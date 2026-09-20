#!/usr/bin/env node
/**
 * agentd — webhook-driven agent dispatcher.
 *
 * Replaces the Gitea Actions agent workflows (comment-assist / pr-review):
 *
 *   Gitea webhook ──► sqlite queue ──► docker run --runtime=runsc agent-sandbox:<agent>
 *
 * Endpoints:
 *   POST /webhook      Gitea native webhook (issue_comment, pull_request_review_comment)
 *   GET  /             task dashboard (auto-refresh)
 *   GET  /task/<id>    task detail + log tail
 *   GET  /api/tasks    JSON task list
 *   GET  /healthz
 *
 * Reliability:
 *   - webhooks are at-least-once: deliveries are deduped, tasks deduped on
 *     (repo, kind, comment_id)
 *   - a poll fallback (every 60s) rescues lost webhooks
 *
 * Loop prevention: replies are stamped `<!-- via:agent -->` by
 * assets/post-comment.sh; comments carrying the marker (or authored by the
 * bot) are never enqueued.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  port: +(process.env.PORT || 3001),
  dataDir: process.env.DATA_DIR || '/data',
  secret: process.env.WEBHOOK_SECRET || '',
  agentToken: process.env.AGENT_TOKEN || '',
  giteaApi: process.env.GITEA_API || 'http://gitea:3000/api/v1', // reachable from THIS container
  giteaHost: process.env.GITEA_HOST || 'host.openshell.internal:3000', // reachable from JOB containers
  repos: (process.env.AGENTD_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  images: {
    pi: process.env.AGENT_IMAGE_PI || 'agent-sandbox:pi',
    opencode: process.env.AGENT_IMAGE_OPENCODE || 'agent-sandbox:opencode',
  },
  botLogin: process.env.BOT_LOGIN || 'bot',
  botEmail: process.env.BOT_EMAIL || 'bot@localhost',
  pollIntervalMs: 60_000,
  concurrency: 1,
};

const MARKER = '<!-- via:agent -->';
const MENTIONS = [
  { agent: 'pi', re: /@pi\b/ },
  { agent: 'opencode', re: /@opencode\b/ },
];

// ── state ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(CFG.dataDir, 'logs'), { recursive: true });

const db = new DatabaseSync(path.join(CFG.dataDir, 'agentd.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT,
  comment_id  INTEGER,
  repo        TEXT NOT NULL,
  issue       INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'comment' | 'review'
  cpath       TEXT,
  line        INTEGER,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|success|failure
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(repo, kind, comment_id);
CREATE TABLE IF NOT EXISTS poll_state (
  repo TEXT PRIMARY KEY,
  since TEXT
);
`);
try { db.exec('ALTER TABLE tasks ADD COLUMN body TEXT'); } catch { /* already present */ }

const running = new Map(); // task id -> { log }
let active = 0;

// ── enqueue ──────────────────────────────────────────────────────────────────

function enqueue({ repo, issue, agent, kind, comment, sender, eventId }) {
  const body = comment?.body ?? '';
  if (sender === CFG.botLogin) return;               // never react to ourselves
  if (body.includes(MARKER)) return;                 // loop prevention
  if (!MENTIONS.some((m) => m.agent === agent && m.re.test(body))) return;

  const exists = db
    .prepare('SELECT 1 FROM tasks WHERE repo = ? AND kind = ? AND comment_id = ?')
    .get(repo, kind, comment.id);
  if (exists) return;

  db.prepare(
    `INSERT INTO tasks (event_id, comment_id, repo, issue, agent, kind, cpath, line, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId ?? null, comment.id, repo, issue, agent, kind, comment.path ?? null, comment.line ?? null, body);
  console.log(`[enqueue] task for ${repo}#${issue} @${agent} (${kind}, comment ${comment.id})`);
}

// ── Gitea API ────────────────────────────────────────────────────────────────

async function apiGet(p, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    headers: { Authorization: `token ${CFG.agentToken}` },
  });
  if (res.status === 404 && opts.ok404) return null;
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

// ── task execution ───────────────────────────────────────────────────────────

function stripMention(body, agent) {
  return body.replace(new RegExp(`@${agent}[ \\t]*`, 'g'), '').trim();
}

function commentPrompt({ issue, title, body, isPull, request }) {
  const guide = isPull
    ? `The comment is on PULL REQUEST #${issue}.
Find its head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${issue} | jq -r .head.ref
Then: git fetch origin pull/${issue}/head && git checkout FETCH_HEAD
Make the requested changes, commit, and push to that head branch (use --force-with-lease only if you had to rebase).`
    : `The comment is on ISSUE #${issue} (not a PR).
If your work produces commits, push a new branch and open a PR from it:
POST $GITEA_API/repos/$GITEA_REPO/pulls with JSON {"title": ..., "head": "<branch>", "base": "main"} (Authorization: token $AGENT_TOKEN).`;
  return `Issue/PR: #${issue} — ${title}
Issue body:
${body}

User request: ${request}
${guide}

When done, write a short reply (what you did, plus any PR/branch name) to /tmp/reply.md and post it:
bash .agentd/post-comment.sh ${issue} /tmp/reply.md`;
}

function reviewPrompt({ issue, request, cpath, line }) {
  return `A reviewer left an inline comment in PR #${issue}${cpath ? ` on ${cpath}` : ''}${line ? ` at line ${line}` : ''}:
${request}

Find the PR head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${issue} | jq -r .head.ref
Then: git fetch origin pull/${issue}/head && git checkout FETCH_HEAD
Address the review comment: make the changes, commit, and push to the head branch.

When done, write a short reply (what you changed) to /tmp/reply.md and post it:
bash .agentd/post-comment.sh ${issue} /tmp/reply.md`;
}

async function runTask(t) {
  const logfile = path.join(CFG.dataDir, 'logs', `${t.id}.log`);
  const log = { text: '', file: logfile };
  running.set(t.id, log);
  const say = (s) => { log.text += s; fs.appendFileSync(logfile, s); };

  try {
    // 1. resolve prompt inputs
    const issueInfo = await apiGet(`/repos/${t.repo}/issues/${t.issue}`);
    const isPull = issueInfo.pull_request != null;
    const request = stripMention(t.body ?? '', t.agent);
    const prompt =
      t.kind === 'review'
        ? reviewPrompt({ issue: t.issue, request, cpath: t.cpath, line: t.line })
        : commentPrompt({ issue: t.issue, title: issueInfo.title, body: issueInfo.body, isPull, request });

    // 2. self-contained bootstrap script, executed INSIDE the job container.
    //    No host-path bind mounts (agentd talks to the host docker daemon, so
    //    container paths are not host paths). Clone as bot → authenticated
    //    remote, so agent commits/PRs attribute to the bot user.
    //
    //    NOTE: docker -e values have their newlines flattened to spaces, so
    //    everything multi-line (prompt, helper scripts) goes into the script
    //    text via quoted heredocs, and the script itself is passed base64.
    const assetsDir = path.join(__dirname, 'assets');
    const delim = () => `EOF_${crypto.randomBytes(6).toString('hex')}`;
    const dPrompt = delim(), dPost = delim(), dJq = delim();
    // (dJq: the name is historical — it now carries the node filter)
    const bootstrap = `
set -e
mkdir -p /work && cd /work
echo '$ git clone ${t.repo}'
git clone -q "$CLONE_URL" repo
cd repo
git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"
mkdir -p .agentd
cat > .agentd/post-comment.sh <<'${dPost}'
${fs.readFileSync(path.join(assetsDir, 'post-comment.sh'), 'utf8').replace(/\n+$/, '')}
${dPost}
cat > .agentd/output_filter.mjs <<'${dJq}'
${fs.readFileSync(path.join(assetsDir, 'output_filter.mjs'), 'utf8').replace(/\n+$/, '')}
${dJq}
chmod +x .agentd/post-comment.sh
cat > /tmp/prompt.txt <<'${dPrompt}'
${prompt}
${dPrompt}
PROMPT="$(cat /tmp/prompt.txt)"
echo ''
echo '$ ${t.agent} agent (runsc sandbox)'
` + (t.agent === 'pi'
      ? 'pi -p --mode json "$PROMPT" | node .agentd/output_filter.mjs\necho "[agentd] agent finished OK"'
      : 'opencode run "$PROMPT"\necho "[agentd] agent finished OK"');
    const b64 = Buffer.from(bootstrap).toString('base64');

    say(`$ docker run --rm --runtime=runsc ${CFG.images[t.agent]} (bootstrap + ${t.agent})\n\n`);

    // 3. run the agent in a fresh gVisor-sandboxed container
    await new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '--runtime=runsc',
        '--add-host=gitea:host-gateway',
        '--add-host=host.openshell.internal:host-gateway',
        '-e', `BOOTSTRAP_B64=${b64}`,
        '-e', `CLONE_URL=http://bot:${CFG.agentToken}@${CFG.giteaHost}/${t.repo}.git`,
        '-e', `BOT_NAME=${CFG.botLogin}`,
        '-e', `BOT_EMAIL=${CFG.botEmail}`,
        '-e', `AGENT_TOKEN=${CFG.agentToken}`,
        '-e', `GITEA_API=http://${CFG.giteaHost}/api/v1`,
        '-e', `GITEA_REPO=${t.repo}`,
        CFG.images[t.agent], 'sh', '-c', 'sh -c "$(printf %s "$BOOTSTRAP_B64" | base64 -d)"',
      ]);
      const onOut = (d) => say(d.toString());
      child.stdout.on('data', onOut);
      child.stderr.on('data', onOut);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`agent exited with code ${code}`))));
    });
  } catch (e) {
    say(`\n[agentd] ERROR: ${e.message}\n`);
    throw e;
  } finally {
    running.delete(t.id);
  }
}

async function pump() {
  if (active >= CFG.concurrency) return;
  const t = db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
  if (!t) return;
  db.prepare(`UPDATE tasks SET status='running', started_at=datetime('now') WHERE id=?`).run(t.id);
  active++;
  try {
    await runTask(t);
    db.prepare(`UPDATE tasks SET status='success', finished_at=datetime('now') WHERE id=?`).run(t.id);
  } catch (e) {
    db.prepare(`UPDATE tasks SET status='failure', finished_at=datetime('now'), error=? WHERE id=?`)
      .run(String(e.message).slice(0, 2000), t.id);
  } finally {
    active--;
  }
}
setInterval(pump, 2000).unref?.();

// ── poll fallback (rescues lost webhooks) ───────────────────────────────────

async function pollRepo(repo) {
  const st = db.prepare('SELECT since FROM poll_state WHERE repo=?').get(repo);
  const since = st?.since ? new Date(st.since) : new Date(Date.now() - 3600_000);

  const issues = await apiGet(`/repos/${repo}/issues?state=open&limit=50`);
  for (const iss of issues) {
    const cs = await apiGet(`/repos/${repo}/issues/${iss.number}/comments?limit=50`);
    for (const c of cs) {
      if (new Date(c.created_at) < since) continue;
      for (const m of MENTIONS)
        enqueue({ repo, issue: iss.number, agent: m.agent, kind: 'comment', comment: c, sender: c.user?.login });
    }
  }

  const prs = await apiGet(`/repos/${repo}/pulls?state=open&limit=25`);
  for (const pr of prs) {
    const cs = (await apiGet(`/repos/${repo}/pulls/${pr.number}/comments?limit=50`, { ok404: true })) ?? []; // 404 = no review comments
    for (const c of cs) {
      if (new Date(c.created_at) < since) continue;
      for (const m of MENTIONS)
        enqueue({ repo, issue: pr.number, agent: m.agent, kind: 'review', comment: c, sender: c.user?.login });
    }
  }

  db.prepare(
    `INSERT INTO poll_state (repo, since) VALUES (?, ?)
     ON CONFLICT(repo) DO UPDATE SET since=excluded.since`
  ).run(repo, new Date().toISOString());
}

async function poll() {
  for (const repo of CFG.repos) {
    try { await pollRepo(repo); }
    catch (e) { console.error(`[poll] ${repo}: ${e.message}`); }
  }
}
setInterval(poll, CFG.pollIntervalMs).unref?.();

// ── webhook ──────────────────────────────────────────────────────────────────

function verifySignature(req, body) {
  if (!CFG.secret) return true; // dev mode: no secret configured
  const sig = req.headers['x-gitea-signature'];
  if (!sig) return false;
  const mac = crypto.createHmac('sha256', CFG.secret).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); }
  catch { return false; }
}

function handleWebhook(event, deliveryId, payload) {
  const repo = payload.repository?.full_name;
  if (!repo) return 0;

  if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.number && payload.comment) {
    for (const m of MENTIONS)
      enqueue({ repo, issue: payload.issue.number, agent: m.agent, kind: 'comment', comment: payload.comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1; // enqueue() logs what it accepted
  }
  // full PR reviews (inline review comments have no hook event in 1.27 —
  // they arrive via the poll fallback)
  if (event === 'pull_request_review' && payload.action === 'created' && payload.review) {
    const prNo = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNo) return 0;
    const comment = { id: payload.review.id, body: payload.review.body ?? '', path: null, line: null };
    for (const m of MENTIONS)
      enqueue({ repo, issue: prNo, agent: m.agent, kind: 'review', comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1;
  }
  return 0;
}

// ── HTTP server (API + barebones UI) ─────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, bodyHtml, { auto = true } = {}) {
  const reload = auto ? '<script>setTimeout(()=>location.reload(),3000)</script>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — agentd</title>
<style>
body{font:14px/1.5 ui-monospace,monospace;background:#111;color:#ddd;margin:24px}
a{color:#7ab} h1{font-size:18px}
table{border-collapse:collapse;width:100%} td,th{border:1px solid #333;padding:4px 8px;text-align:left}
th{color:#888}
.queued{color:#888}.running{color:#7cf}.success{color:#6d6}.failure{color:#f66}
pre{background:#0a0a0a;border:1px solid #333;padding:12px;overflow-x:auto;white-space:pre-wrap}
.meta{color:#888}
</style></head><body>${bodyHtml}
${reload}</body></html>`;
}

function taskTable() {
  const rows = db.prepare(
    `SELECT * FROM tasks ORDER BY id DESC LIMIT 100`
  ).all().map((t) => `<tr>
    <td><a href="/task/${t.id}">${t.id}</a></td>
    <td>${esc(t.created_at)}</td>
    <td>${esc(t.repo)}#${t.issue}</td>
    <td>@${esc(t.agent)}</td>
    <td>${esc(t.kind)}</td>
    <td class="${t.status}">${t.status}</td>
    <td>${esc(t.error ?? '')}</td>
  </tr>`).join('\n');
  return `<h1>agentd tasks</h1><table>
<tr><th>id</th><th>created</th><th>repo</th><th>agent</th><th>kind</th><th>status</th><th>error</th></tr>
${rows}</table>`;
}

function taskPage(t) {
  const head = `<h1>task ${t.id} <span class="${t.status}">${t.status}</span></h1>
<p class="meta">${esc(t.repo)}#${t.issue} · @${esc(t.agent)} · ${esc(t.kind)} · created ${esc(t.created_at)}
 · started ${esc(t.started_at ?? '—')} · finished ${esc(t.finished_at ?? '—')}<br>
${t.error ? `<span class="failure">${esc(t.error)}</span>` : ''}</p>`;
  if (t.status === 'running') {
    // live view: SSE streams the log line-by-line as the container prints it
    return `${head}<pre id="log">(waiting for output…)</pre><p><a href="/">← back</a></p>
<script>
const pre = document.getElementById('log');
let stick = true; // follow the bottom unless the user scrolls up
const nearBottom = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
pre.addEventListener('scroll', () => { stick = nearBottom(); });
const es = new EventSource('/task/${t.id}/stream');
let any = false;
es.onmessage = (e) => {
  if (!any) { pre.textContent = ''; any = true; }
  pre.textContent += e.data + '\\n';
  if (stick) pre.scrollTop = pre.scrollHeight;
};
es.addEventListener('done', () => location.reload());
// poll status so the page settles when the task finishes
const iv = setInterval(async () => {
  const j = await (await fetch('/api/task/${t.id}')).json();
  if (!['queued', 'running'].includes(j.status)) { clearInterval(iv); location.reload(); }
}, 2000);
</script>`;
  }
  const log = fs.existsSync(path.join(CFG.dataDir, 'logs', `${t.id}.log`))
    ? fs.readFileSync(path.join(CFG.dataDir, 'logs', `${t.id}.log`), 'utf8').split('\n').slice(-400).join('\n')
    : '(no log yet)';
  return `${head}<pre>${esc(log)}</pre><p><a href="/">← back</a></p>`;
}

const server = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!verifySignature(req, Buffer.from(body))) return send(403, 'text/plain', 'bad signature');
      let payload = {};
      try { payload = JSON.parse(body); } catch { return send(400, 'text/plain', 'bad json'); }
      const event = req.headers['x-gitea-event'] || '';
      const delivery = req.headers['x-gitea-delivery'] || '';
      const handled = handleWebhook(event, delivery, payload);
      console.log(`[webhook] ${event} delivery=${delivery.slice(0, 8)} ${handled ? '→ enqueued' : '→ ignored'}`);
      send(200, 'text/plain', 'ok');
    });
    return;
  }

  if (url.pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, active, repos: CFG.repos }));
  if (url.pathname === '/api/tasks') {
    return send(200, 'application/json', JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 100').all()));
  }
  const apiTaskMatch = url.pathname.match(/^\/api\/task\/(\d+)$/);
  if (apiTaskMatch) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+apiTaskMatch[1]);
    if (!t) return send(404, 'application/json', '{}');
    return send(200, 'application/json', JSON.stringify(t));
  }
  const streamMatch = url.pathname.match(/^\/task\/(\d+)\/stream$/);
  if (streamMatch) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+streamMatch[1]);
    if (!t) return send(404, 'text/plain', 'no such task');
    // SSE tail of the task log: emits each complete line as it hits the file
    const logfile = path.join(CFG.dataDir, 'logs', `${t.id}.log`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let off = 0, tail = '';
    const tick = () => {
      try {
        const size = fs.statSync(logfile).size;
        if (size > off) {
          const len = Math.min(size - off, 1 << 20);
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(logfile, 'r');
          fs.readSync(fd, buf, 0, len, off);
          fs.closeSync(fd);
          const txt = tail + buf.toString();
          const end = txt.lastIndexOf('\n');
          if (end >= 0) {
            const complete = txt.slice(0, end + 1);
            for (const line of complete.split('\n').slice(0, -1)) res.write(`data: ${line.replace(/\r?$/, '')}\n\n`);
            off += Buffer.byteLength(complete);
            tail = txt.slice(end + 1);
          } else tail = txt;
        }
      } catch { /* log file not created yet */ }
      const cur = db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id);
      if (cur && !['queued', 'running'].includes(cur.status)) {
        clearInterval(iv);
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    };
    const iv = setInterval(tick, 250);
    tick();
    req.on('close', () => clearInterval(iv));
    return;
  }
  const taskMatch = url.pathname.match(/^\/task\/(\d+)$/);
  if (taskMatch) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+taskMatch[1]);
    if (!t) return send(404, 'text/plain', 'no such task');
    return send(200, 'text/html', page(`task ${t.id}`, taskPage(t), { auto: false }));
  }
  if (url.pathname === '/') return send(200, 'text/html', page('tasks', taskTable()));
  send(404, 'text/plain', 'not found');
});

server.listen(CFG.port, () => {
  console.log(`[agentd] listening on :${CFG.port}`);
  console.log(`[agentd] repos (poll fallback): ${CFG.repos.join(', ') || '(none)'}`);
  console.log(`[agentd] images: pi=${CFG.images.pi} opencode=${CFG.images.opencode}`);
  console.log(`[agentd] webhook secret: ${CFG.secret ? 'set' : 'NOT SET (dev mode: signatures not verified)'}`);
});
