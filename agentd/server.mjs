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
import { spawn, execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  port: +(process.env.PORT || 3001),
  dataDir: process.env.DATA_DIR || '/data',
  secret: process.env.WEBHOOK_SECRET || '',
  agentToken: process.env.AGENT_TOKEN || '',
  adminToken: process.env.ADMIN_TOKEN || '', // read-only: repos page webhook status
  giteaApi: process.env.GITEA_API || 'http://gitea:3000/api/v1', // reachable from THIS container
  giteaHost: process.env.GITEA_HOST || 'host.openshell.internal:3000', // reachable from JOB containers
  repos: (process.env.AGENTD_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  images: {
    pi: process.env.AGENT_IMAGE_PI || 'agent-sandbox:pi',
    opencode: process.env.AGENT_IMAGE_OPENCODE || 'agent-sandbox:opencode',
  },
  botLogin: process.env.BOT_LOGIN || 'bot',
  botEmail: process.env.BOT_EMAIL || 'bot@localhost',
  themeUser: process.env.AGENTD_THEME_USER || 'owner',   // whose Gitea theme the UI mirrors
  giteaContainer: process.env.GITEA_CONTAINER || 'gitea',  // theme asset discovery (docker exec grep on the binary)
  giteaDbContainer: process.env.GITEA_DB_CONTAINER || 'gitea-db-1',
  giteaDbUser: process.env.GITEA_DB_USER || 'USER',
  giteaDbName: process.env.GITEA_DB_NAME || 'gitea',
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
    headers: { Authorization: `token ${opts.token || CFG.agentToken}` },
  });
  if (res.status === 404 && opts.ok404) return null;
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

// ── Gitea theme mirroring ────────────────────────────────────────────────────
// The UI is styled with Gitea's own CSS variables so it always matches the
// operator's configured Gitea theme. Gitea's theme CSS files are content-hashed
// and the name→file map is embedded in the gitea binary, so we discover it at
// runtime (docker exec grep), fetch the file for the configured theme, and
// serve it same-origin at /assets/gitea-theme.css. Cached 10 min. If anything
// fails the page falls back to the hardcoded dark palette (var() fallbacks).
let themeState = { at: 0, theme: 'gitea-auto', css: '' };
let themeRefresh = null;
const THEME_TTL = 10 * 60_000;
const themeFile = path.join(CFG.dataDir, 'theme.json');
const giteaOrigin = () => new URL(CFG.giteaApi).origin;

function execFileP(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

// Full discovery pass. SLOW (~15s — grepping the ~100MB gitea binary), so it
// always runs in the background; requests serve whatever themeState already has.
// Results persist to theme.json so restarts render the right theme instantly.
async function refreshTheme() {
  let theme = 'gitea-auto';
  try {
    // Gitea 1.27's user API does NOT expose the theme field → read it from the DB
    // via the docker socket (psql on the db container, local socket = no password).
    const safeUser = CFG.themeUser.replace(/[^a-z0-9-]/gi, '');
    const out = await execFileP('docker', ['exec', CFG.giteaDbContainer, 'psql', '-U', CFG.giteaDbUser, '-d', CFG.giteaDbName, '-tAc',
      `SELECT theme FROM "user" WHERE lower_name='${safeUser}'`]);
    const v = out.trim();
    if (v) theme = v.startsWith('gitea-') ? v : `gitea-${v}`;
  } catch { /* db unreachable: keep auto */ }
  let file = null;
  try {
    // theme name → content-hashed css filename is embedded in the gitea binary
    const out = await execFileP('docker', ['exec', CFG.giteaContainer, 'grep', '-ao', 'theme-[a-z-]*\\.[A-Za-z0-9_-]*\\.css', '/app/gitea/gitea'], { timeout: 30_000 });
    // exact match: filename `theme-<name>.<hash>.css` (the dot excludes -protanopia/-tritanopia variants)
    for (const m of out.matchAll(/theme-[a-z-]*\.[A-Za-z0-9_-]*\.css/g)) {
      if (m[0].startsWith(`theme-${theme}.`)) { file = m[0]; break; }
    }
  } catch { /* binary not greppable */ }
  if (!file) {
    try { // fallback: whatever the anonymous homepage renders (default theme)
      const home = await (await fetch(giteaOrigin(), { signal: AbortSignal.timeout(4000) })).text();
      const m = home.match(/href="(\/assets\/css\/theme-[^"]+\.css)"/);
      if (m) file = m[1].slice(1);
    } catch { /* no file */ }
  }
  file = file?.replace(/^assets\/css\//, ''); // normalize (homepage fallback returns a full path)
  let css = '';
  if (file) {
    try {
      const res = await fetch(`${giteaOrigin()}/assets/css/${file}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) css = await res.text();
    } catch { /* keep empty */ }
  }
  themeState = { at: Date.now(), theme, css };
  try { fs.writeFileSync(themeFile, JSON.stringify({ theme, file, css, at: themeState.at })); } catch { /* non-fatal */ }
  console.log(`[theme] ${theme} via ${file || '(fallback palette)'}${css ? ` (${(css.length / 1024).toFixed(1)}KB)` : ''}`);
}

// Sync: return the current theme immediately; kick a background refresh if stale.
function giteaTheme() {
  if (!themeRefresh && Date.now() - themeState.at >= THEME_TTL) kickThemeRefresh();
  return themeState;
}

function kickThemeRefresh() {
  if (themeRefresh) return;
  themeRefresh = refreshTheme()
    .catch((e) => console.log(`[theme] refresh failed: ${e.message}`))
    .finally(() => { themeRefresh = null; });
}

// First paint: load the persisted theme, then verify in the background.
try {
  const saved = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
  if (saved?.css && Date.now() - saved.at < 24 * 3600_000) {
    themeState = { at: saved.at, theme: saved.theme || 'gitea-auto', css: saved.css };
    console.log(`[theme] loaded from cache: ${themeState.theme}`);
  }
} catch { /* no cache yet */ }
kickThemeRefresh();

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

function sidebar(active) {
  // gitea link resolved client-side: same host as the UI, port 3000
  // mobile: off-canvas drawer toggled by #navToggle, closed by backdrop or nav click
  return `<button id="navToggle" aria-label="menu">☰</button>
<div id="backdrop"></div>
<aside class="sidebar" id="sidebar"><span class="brand">agentd</span>
<a class="navl${active === 'tasks' ? ' on' : ''}" href="/">tasks</a>
<a class="navl${active === 'repos' ? ' on' : ''}" href="/repos">repos</a>
<a class="navl sbfoot" id="giteaLink" href="#">gitea ↗</a></aside>
<script>var sb=document.getElementById('sidebar'),bd=document.getElementById('backdrop'),tg=document.getElementById('navToggle');
tg.onclick=function(){bd.classList.toggle('show',sb.classList.toggle('open'));};
bd.onclick=function(){sb.classList.remove('open');bd.classList.remove('show');};
document.querySelectorAll('.sidebar a').forEach(function(a){a.addEventListener('click',function(){sb.classList.remove('open');bd.classList.remove('show');});});
var g=document.getElementById('giteaLink');if(g)g.href=location.protocol+'//'+location.hostname+':3000';</script>`;
}

function page(title, bodyHtml, { auto = true, nav = null } = {}) {
  const th = giteaTheme();
  const reload = auto ? '<script>setTimeout(()=>location.reload(),3000)</script>' : '';
  const side = nav ? sidebar(nav) : '';
  // Colors come from Gitea's theme CSS (served same-origin, see giteaTheme());
  // every var() has a hardcoded dark fallback so the UI works if Gitea is down.
  return `<!doctype html><html data-theme="${th.theme}"><head><meta charset="utf-8"><title>${esc(title)} — agentd</title>
<link rel="stylesheet" href="/assets/gitea-theme.css">
<style>
*{box-sizing:border-box}
body{font:14px/20px -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;background:var(--color-body,#111);color:var(--color-text,#ddd);margin:0}
a{color:var(--color-primary-light-2,#7ab)} h1{font-size:18px}
/* mobile-first: off-canvas drawer; desktop (>=768px) pins it open */
.layout{min-height:100vh}
main{min-width:0;padding:16px;padding-top:56px}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:170px;z-index:30;background:var(--color-nav-bg,#0c0c0c);border-right:1px solid var(--color-light-border,#333);padding:20px 0;display:flex;flex-direction:column;transform:translateX(-100%);transition:transform .15s ease-out}
.sidebar.open{transform:none}
.sidebar .brand{font-weight:bold;color:var(--color-text,#ddd);padding:0 20px 20px}
#navToggle{position:fixed;top:10px;left:10px;z-index:20;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:6px;color:var(--color-input-text,#7ab);font:14px -apple-system,system-ui,sans-serif;padding:4px 10px;cursor:pointer}
#backdrop{display:none;position:fixed;inset:0;background:var(--color-overlay-backdrop,rgba(0,0,0,.55));z-index:25}
#backdrop.show{display:block}
.navl{display:block;color:var(--color-nav-text,#7ab);text-decoration:none;padding:8px 20px}
.navl:hover{color:var(--color-text,#9cd);text-decoration:none;background:var(--color-nav-hover-bg,transparent)}
.navl.on{color:var(--color-text,#fff);font-weight:bold;background:var(--color-secondary-alpha-20,#1a1a1a);box-shadow:inset 2px 0 0 var(--color-primary,#7ab)}
.sbfoot{margin-top:auto}
pre{background:var(--color-console-bg,#0a0a0a);color:var(--color-console-fg,#ddd);border:1px solid var(--color-console-border,#333);padding:12px;overflow-x:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* list-item style (no tables): each .item is a whole-block clickable row */
.list{border:1px solid var(--color-light-border,#333);border-radius:6px;overflow:hidden}
.item{display:block;text-decoration:none;color:inherit;padding:10px 14px;border-bottom:1px solid var(--color-light-border,#333)}
.item:last-child{border-bottom:none}
.item:hover{background:var(--color-hover,transparent)}
.l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600}
.l2{color:var(--color-text-light-2,#888);font-size:12.5px;margin-top:2px}
.err{color:var(--color-error-text,#f66);font-size:12.5px;margin-top:2px;word-break:break-word}
.hook{font-weight:400;font-size:12.5px}.hook.ok{color:var(--color-success-text,#6d6)}.hook.bad{color:var(--color-error-text,#f66)}
/* status pill badges */
.queued,.running,.success,.failure{display:inline-block;font-size:11px;font-weight:600;padding:1px 9px;border-radius:10px;border:1px solid transparent;white-space:nowrap}
.queued{color:var(--color-text-light-2,#999);border-color:var(--color-text-light-2,#555)}
.running{color:var(--color-primary-light-1,#7cf);border-color:var(--color-primary,#36c);background:rgba(90,140,255,.12)}
.success{color:var(--color-success-text,#6d6);border-color:var(--color-success-text,#3a3);background:rgba(90,200,90,.12)}
.failure{color:var(--color-error-text,#f66);border-color:var(--color-error-text,#a33);background:rgba(255,90,90,.12)}
.meta{color:var(--color-text-light-2,#888)}
.back{display:inline-block;text-decoration:none;font-size:12.5px;color:var(--color-text-light-2,#999);margin-bottom:6px}
.back:hover{color:var(--color-text,#ddd);text-decoration:underline}
@media (min-width:768px){
  .sidebar{transform:none;width:160px}
  #navToggle,#backdrop{display:none}
  main{margin-left:160px;padding:24px}
}
</style></head><body>
<div class="layout">${side}<main>${bodyHtml}</main></div>
${reload}</body></html>`;
}

function taskList() {
  const rows = db.prepare(
    `SELECT * FROM tasks ORDER BY id DESC LIMIT 100`
  ).all().map((t) => `<a class="item" href="/task/${t.id}">
    <div class="l1"><span class="${t.status}">${t.status}</span> <span>#${t.id}</span> ${esc(t.repo)}#${t.issue}</div>
    <div class="l2">@${esc(t.agent)} · ${esc(t.kind)} · ${esc(t.created_at)}</div>
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
  </a>`).join('\n');
  return `<h1>agentd tasks</h1><div class="list">${rows}</div>`;
}

function taskPage(t) {
  const head = `<a class="back" href="/">← back to tasks</a>
<h1>task ${t.id} <span class="${t.status}">${t.status}</span></h1>
<p class="meta">${esc(t.repo)}#${t.issue} · @${esc(t.agent)} · ${esc(t.kind)} · created ${esc(t.created_at)}
 · started ${esc(t.started_at ?? '—')} · finished ${esc(t.finished_at ?? '—')}<br>
${t.error ? `<span class="err">${esc(t.error)}</span>` : ''}</p>`;
  if (t.status === 'running') {
    // live view: SSE streams the log line-by-line as the container prints it
    return `${head}<pre id="log">(waiting for output…)</pre>
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
  return `${head}<pre>${esc(log)}</pre>`;
}

async function reposPage() {
  const rows = (await Promise.all(CFG.repos.map(async (r) => {
    const tot = db.prepare('SELECT COUNT(*) n FROM tasks WHERE repo=?').get(r).n;
    const ok = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='success'").get(r).n;
    const bad = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='failure'").get(r).n;
    const last = db.prepare('SELECT MAX(created_at) t FROM tasks WHERE repo=?').get(r).t;
    let hook;
    try {
      // hooks list needs repo admin — bot token is member-only
      const hooks = await apiGet(`/repos/${r}/hooks`, { token: CFG.adminToken || CFG.agentToken });
      // Gitea 1.27 reports native hooks as type "gitea"
      const h = hooks.find((x) => (x.type === 'gitea' || x.type === 'native') && String(x.config?.url || '').includes('/webhook'));
      hook = h ? { txt: `webhook id ${h.id} (${(h.events || []).join(', ')})`, ok: true } : { txt: 'webhook missing — run ./seed.sh', ok: false };
    } catch { hook = { txt: 'webhook check failed', ok: false }; }
    return `<a class="item gl" data-repo="${esc(r)}" href="#">
    <div class="l1">${esc(r)} <span class="hook ${hook.ok ? 'ok' : 'bad'}">${hook.txt}</span></div>
    <div class="l2">${tot} tasks (${ok} ok / ${bad} failed) · last activity: ${esc(last ?? '—')}</div>
  </a>`;
  }))).join('');
  return `<h1>managed repos</h1>
<div class="list">${rows}</div>
<p class="meta">add a repo: append to AGENTD_REPOS in .env, recreate agentd, run ./seed.sh (creates the webhook)</p>
<script>document.querySelectorAll('a.gl').forEach(a=>a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo);</script>`;
}

const server = http.createServer(async (req, res) => {
  const send = (code, type, body) => {
    const headers = { 'content-type': type };
    if (type === 'text/html' || type === 'text/css') headers['cache-control'] = 'no-store'; // never serve stale UI/theme
    res.writeHead(code, headers);
    res.end(body);
  };
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
    return send(200, 'text/html', page(`task ${t.id}`, taskPage(t), { auto: false, nav: 'tasks' }));
  }
  if (url.pathname === '/assets/gitea-theme.css') {
    const th = giteaTheme();
    return send(200, 'text/css', th.css || '/* gitea theme css unavailable — UI uses fallback palette */');
  }
  if (url.pathname === '/') return send(200, 'text/html', page('tasks', taskList(), { nav: 'tasks' }));
  if (url.pathname === '/repos') return send(200, 'text/html', page('repos', await reposPage(), { nav: 'repos' }));
  send(404, 'text/plain', 'not found');
});

server.listen(CFG.port, () => {
  console.log(`[agentd] listening on :${CFG.port}`);
  console.log(`[agentd] repos (poll fallback): ${CFG.repos.join(', ') || '(none)'}`);
  console.log(`[agentd] images: pi=${CFG.images.pi} opencode=${CFG.images.opencode}`);
  console.log(`[agentd] webhook secret: ${CFG.secret ? 'set' : 'NOT SET (dev mode: signatures not verified)'}`);
});
