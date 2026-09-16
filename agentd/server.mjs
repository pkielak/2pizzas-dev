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
import { execFile, spawn } from 'node:child_process';
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
  workTtlMs: 7 * 24 * 3600 * 1000,
  concurrency: 1,
};

const MARKER = '<!-- via:agent -->';
const MENTIONS = [
  { agent: 'pi', re: /@pi\b/ },
  { agent: 'opencode', re: /@opencode\b/ },
];

// ── state ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(CFG.dataDir, 'work'), { recursive: true });
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
    `INSERT INTO tasks (event_id, comment_id, repo, issue, agent, kind, cpath, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId ?? null, comment.id, repo, issue, agent, kind, comment.path ?? null, comment.line ?? null);
  console.log(`[enqueue] task for ${repo}#${issue} @${agent} (${kind}, comment ${comment.id})`);
}

// ── Gitea API ────────────────────────────────────────────────────────────────

async function apiGet(p) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    headers: { Authorization: `token ${CFG.agentToken}` },
  });
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

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0] ?? ''} failed: ${err.message} ${stderr || ''}`.trim())) : resolve(stdout)
    )
  );
}

async function runTask(t) {
  const workdir = path.join(CFG.dataDir, 'work', String(t.id));
  const logfile = path.join(CFG.dataDir, 'logs', `${t.id}.log`);
  fs.mkdirSync(workdir, { recursive: true });
  const log = { text: '', file: logfile };
  running.set(t.id, log);
  const say = (s) => { log.text += s; fs.appendFileSync(logfile, s); };

  try {
    // 1. clone as bot (authenticated remote → agent commits attribute to bot)
    const cloneUrl = `http://bot:${CFG.agentToken}@${CFG.giteaHost}/${t.repo}.git`;
    say(`$ git clone ${t.repo}\n`);
    await execFileP('git', ['clone', '-q', cloneUrl, workdir]);
    await execFileP('git', ['-C', workdir, 'config', 'user.name', CFG.botLogin]);
    await execFileP('git', ['-C', workdir, 'config', 'user.email', CFG.botEmail]);

    // 2. agent helpers
    fs.cpSync(path.join(__dirname, 'assets'), path.join(workdir, '.agentd'), { recursive: true });

    // 3. resolve prompt inputs
    const issueInfo = await apiGet(`/repos/${t.repo}/issues/${t.issue}`);
    const isPull = issueInfo.pull_request != null;
    const request = stripMention(t.body ?? '', t.agent);
    const prompt =
      t.kind === 'review'
        ? reviewPrompt({ issue: t.issue, request, cpath: t.cpath, line: t.line })
        : commentPrompt({ issue: t.issue, title: issueInfo.title, body: issueInfo.body, isPull, request });

    // 4. run the agent in a fresh gVisor-sandboxed container
    const image = CFG.images[t.agent];
    const cmd =
      t.agent === 'pi'
        ? 'pi -p --mode json "$PROMPT" | jq -j -f .agentd/output_filter.jq'
        : 'opencode run "$PROMPT"';
    say(`$ docker run --rm --runtime=runsc ${image} sh -c ${JSON.stringify(cmd)}\n\n`);

    await new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '--runtime=runsc',
        '--add-host=gitea:host-gateway',
        '--add-host=host.openshell.internal:host-gateway',
        `-v ${workdir}:/work`, '-w', '/work',
        '-e', `PROMPT=${prompt}`,
        '-e', `AGENT_TOKEN=${CFG.agentToken}`,
        '-e', `GITEA_API=http://${CFG.giteaHost}/api/v1`,
        '-e', `GITEA_REPO=${t.repo}`,
        image, 'sh', '-c', cmd,
      ]);
      const onOut = (d) => say(d.toString());
      child.stdout.on('data', onOut);
      child.stderr.on('data', onOut);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`agent exited with code ${code}`))));
    });
    say('\n[agentd] agent finished OK\n');
  } catch (e) {
    say(`\n[agentd] ERROR: ${e.message}\n`);
    throw e;
  } finally {
    running.delete(t.id);
  }
}

async function pump() {
  if (active >= CFG.concurrency) return;
  const t = db.prepare(
    `SELECT tasks.*, NULL AS body FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1`
  ).get();
  if (!t) return;
  db.prepare(`UPDATE tasks SET status='running', started_at=datetime('now') WHERE id=?`).run(t.id);
  active++;
  try {
    // fetch comment body for prompt construction (webhook path doesn't store it)
    t.body = await (async () => {
      try {
        if (t.kind === 'review') {
          const cs = await apiGet(`/repos/${t.repo}/pulls/${t.issue}/comments`);
          const c = cs.find((c) => c.id === t.comment_id);
          return c?.body ?? '';
        }
        const cs = await apiGet(`/repos/${t.repo}/issues/${t.issue}/comments`);
        const c = cs.find((c) => c.id === t.comment_id);
        return c?.body ?? '';
      } catch { return ''; }
    })();
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
    const cs = await apiGet(`/repos/${repo}/pulls/${pr.number}/comments?limit=50`);
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

// ── workdir pruning ──────────────────────────────────────────────────────────

function prune() {
  const dir = path.join(CFG.dataDir, 'work');
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (Date.now() - fs.statSync(p).mtimeMs > CFG.workTtlMs) fs.rmSync(p, { recursive: true, force: true });
  }
}
prune();
setInterval(prune, 6 * 3600 * 1000).unref?.();

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
  if (event === 'pull_request_review_comment' && payload.action === 'created' && payload.comment) {
    const prNo = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNo) return 0;
    for (const m of MENTIONS)
      enqueue({ repo, issue: prNo, agent: m.agent, kind: 'review', comment: payload.comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1;
  }
  return 0;
}

// ── HTTP server (API + barebones UI) ─────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, bodyHtml) {
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
<script>setTimeout(()=>location.reload(),3000)</script></body></html>`;
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
  const log = fs.existsSync(path.join(CFG.dataDir, 'logs', `${t.id}.log`))
    ? fs.readFileSync(path.join(CFG.dataDir, 'logs', `${t.id}.log`), 'utf8').split('\n').slice(-400).join('\n')
    : '(no log yet)';
  return `<h1>task ${t.id} <span class="${t.status}">${t.status}</span></h1>
<p class="meta">${esc(t.repo)}#${t.issue} · @${esc(t.agent)} · ${esc(t.kind)} · created ${esc(t.created_at)}
 · started ${esc(t.started_at ?? '—')} · finished ${esc(t.finished_at ?? '—')}<br>
${t.error ? `<span class="failure">${esc(t.error)}</span>` : ''}</p>
<pre>${esc(log)}</pre><p><a href="/">← back</a></p>`;
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
  const taskMatch = url.pathname.match(/^\/task\/(\d+)$/);
  if (taskMatch) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+taskMatch[1]);
    if (!t) return send(404, 'text/plain', 'no such task');
    return send(200, 'text/html', page(`task ${t.id}`, taskPage(t)));
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
