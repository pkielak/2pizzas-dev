#!/usr/bin/env node
/**
 * 00-tea — webhook-driven agent dispatcher.
 *
 * Replaces the Gitea Actions agent workflows (comment-assist / pr-review):
 *
 *   Gitea webhook ──► sqlite queue ──► docker run --runtime=runsc agent-sandbox:<agent>
 *
 * Review chain (after any work task that pushed commits):
 *   work (round N) ──pushed──► agent-review (round N, read-only clone)
 *     verdict <!-- review:pass --> → done
 *     verdict <!-- review:fail --> → rework (round N+1, original agent)
 *       → pushes → agent-review (round N+1) → … capped at REVIEW_MAX_ROUNDS
 *   Internal tasks (agent-review/rework) are enqueued by 00-tea itself, never
 *   via the webhook (the reviewer's comment carries the via:agent marker).
 *
 * Endpoints:
 *   POST /webhook      Gitea native webhook (issue_comment, pull_request_review_comment)
 *   GET  /             home — latest from every section (tasks, android, pages)
 *   GET  /tasks        task dashboard (auto-refresh)
 *   GET  /task/<id>    task detail + log tail
 *   GET  /android      latest builds on the android-runner (label `android`)
 *   GET  /pages        gh-pages sites (last deployed commit per site)
 *   GET  /stats        usage stats (tasks, tokens, models, daily activity)
 *   GET  /backends     agents + inference providers (current setup)
 *   GET  /chat         agent chat — live sessions (pi RPC / opencode serve)
 *   GET  /chat/<id>    chat view (SSE stream)
 *   GET  /api/chat     active chat sessions
 *   POST /api/chat     start a chat session {agent: 'pi'|'opencode'}
 *   POST /api/chat/<id>/message   {message}
 *   POST /api/chat/<id>/abort
 *   DELETE /api/chat/<id>
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
import { StringDecoder } from 'node:string_decoder';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  port: +(process.env.PORT || 3001),
  dataDir: process.env.DATA_DIR || '/data',
  secret: process.env.WEBHOOK_SECRET || '',
  agentToken: process.env.AGENT_TOKEN || '',
  giteaApi: process.env.GITEA_API || 'http://gitea:3000/api/v1', // reachable from THIS container
  giteaHost: process.env.GITEA_HOST || 'host.docker.internal:3000', // reachable from JOB containers
  // seed list of managed repos — self-enrolling (an @agent mention on an
  // unmanaged repo persists it in managed_repos and grants the bot write
  // access) makes this a convenience, not a gate
  repos: (process.env.AGENTD_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
   images: {
    pi: process.env.AGENT_IMAGE_PI || 'agent-sandbox:pi',
    opencode: process.env.AGENT_IMAGE_OPENCODE || 'agent-sandbox:opencode',
    review: process.env.AGENT_IMAGE_REVIEW || 'agent-sandbox:review',
  },
  reviewToken: process.env.REVIEW_TOKEN || '',        // bot token, READ scope — reviewer clone
  reviewMaxRounds: +(process.env.REVIEW_MAX_ROUNDS || 3),
  botLogin: process.env.BOT_LOGIN || 'bot',
  botEmail: process.env.BOT_EMAIL || 'bot@localhost',
  themeUser: process.env.AGENTD_THEME_USER || 'admin',   // whose Gitea theme the UI mirrors
  giteaContainer: process.env.GITEA_CONTAINER || 'gitea',  // theme asset discovery (docker exec grep on the binary)
  giteaDbContainer: process.env.GITEA_DB_CONTAINER || 'gitea-db-1',
  giteaDbUser: process.env.GITEA_DB_USER || 'postgres',
  giteaDbName: process.env.GITEA_DB_NAME || 'gitea',
  adminToken: process.env.ADMIN_TOKEN || '', // admin-scope token — actions runs API
  pagesSites: (process.env.PAGES_SITES || '').split(',').map((s) => s.trim()).filter(Boolean),
  chatToken: process.env.CHAT_TOKEN || '',   // optional gate for /chat + /api/chat* (UI is tailnet-reachable)
  // /chat agents act as the separate "chat" Gitea user (audit separation from
  // task work): the token goes into the chat containers; per-repo WRITE
  // access is still gated by collaborator grants (managed from the /chat UI)
  chatGiteaToken: process.env.CHAT_GITEA_TOKEN || '',
  chatLogin: process.env.CHAT_LOGIN || 'chat',
  chatIdleMs: +(process.env.CHAT_IDLE_MINUTES || 30) * 60_000,  // kill idle chat containers
  chatNetwork: process.env.CHAT_NETWORK || 'gitea_gitea',  // chat containers join it (reached by name)
  pollIntervalMs: 60_000,
  concurrency: 1,
  llamaUrl: (process.env.LLAMA_CPP_URL || 'http://localhost:8080').replace(/\/+$/, ''),
};

const MARKER = '<!-- via:agent -->';
const MENTIONS = [
  { agent: 'pi', re: /@pi\b/ },
  { agent: 'opencode', re: /@opencode\b/ },
];

// ── state ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(CFG.dataDir, 'logs'), { recursive: true });

const db = new DatabaseSync(path.join(CFG.dataDir, '00-tea.db'));
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
CREATE TABLE IF NOT EXISTS chat_grants (
  repo       TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS managed_repos (
  owner    TEXT NOT NULL,
  name     TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
`);
for (const col of ['body TEXT', 'model TEXT', 'model_ctx INTEGER', 'tokens INTEGER',
  'parent_id INTEGER',  // review chain: the task this one was spawned by
  'round INTEGER',      // work round (1 = original, N+1 = rework after review N)
  'pr INTEGER']) {      // PR the work landed in (known at review-enqueue time)
  try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already present */ }
}
db.exec('UPDATE tasks SET round = 1 WHERE round IS NULL'); // backfill pre-chain rows

const running = new Map(); // task id -> { log }
let active = 0;

// ── managed repos: env seed list ∪ self-enrolled (db) ───────────────────────
// The @agent mention on an unmanaged repo IS the opt-in: enroll() persists
// the repo and grants the bot write access, then the task proceeds as usual.
const dbRepos = () => db.prepare("SELECT owner || '/' || name AS repo FROM managed_repos").all().map((r) => r.repo);
const managedRepos = () => [...new Set([...CFG.repos, ...dbRepos()])];
const isManaged = (repo) => managedRepos().includes(repo);

async function enroll(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo name ${repo}`);
  db.prepare('INSERT OR IGNORE INTO managed_repos (owner, name) VALUES (?, ?)').run(owner, name);
  // bot must be a write collaborator: it clones, commits and comments as bot
  // (same call seed.sh makes for env-listed repos)
  const res = await fetch(`${CFG.giteaApi}/repos/${repo}/collaborators/${CFG.botLogin}`, {
    method: 'PUT',
    headers: { Authorization: `token ${CFG.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'write', permission: 'write' }),
  });
  if (!res.ok) throw new Error(`PUT collaborators → ${res.status}`);
  console.log(`[enroll] ${repo} self-enrolled (bot granted write access)`);
}

// ── model selection (llama.cpp router) ─────────────────────────────────────

async function llamaModels() {
  const j = await (await fetch(`${CFG.llamaUrl}/v1/models`)).json();
  return (j.data ?? []).map((m) => {
    const args = m.status?.args ?? [];
    const ai = args.indexOf('--ctx-size');
    let ctx = m.meta?.n_ctx ?? (ai >= 0 ? Number(args[ai + 1]) : NaN);
    if (!Number.isFinite(ctx)) {
      const pm = /ctx-size = (\d+)/.exec(m.status?.preset ?? '');
      ctx = pm ? Number(pm[1]) : 0;
    }
    return { id: m.id, loaded: m.status?.value === 'loaded', ctx };
  });
}

// pi's baked default (single source of truth: the settings.json in the image)
let defaultModelCache = { at: 0, value: null };
async function piDefaultModel() {
  if (Date.now() - defaultModelCache.at < 10 * 60_000) return defaultModelCache.value;
  try {
    const out = await execFileP('docker', ['run', '--rm', '--entrypoint', 'cat', CFG.images.pi, '/root/.pi/agent/settings.json'], { timeout: 15_000 });
    defaultModelCache = { at: Date.now(), value: JSON.parse(out).defaultModel || null };
  } catch {
    defaultModelCache = { at: Date.now(), value: null };
  }
  return defaultModelCache.value;
}

// The default model only if it is loaded; else whatever is loaded (so the
// router never has to lazy-load a model whose VRAM is already occupied);
// else the default (router will load it).
async function pickModel() {
  let models = [];
  try { models = await llamaModels(); }
  catch (e) { console.error(`[llama] ${e.message} — falling back to default model`); }
  const def = (await piDefaultModel()) ?? null;
  const defM = def ? models.find((m) => m.id === def) : null;
  if (defM?.loaded) return { id: def, ctx: defM.ctx, source: 'default' };
  const loaded = models.find((m) => m.loaded);
  if (loaded) return { id: loaded.id, ctx: loaded.ctx, source: 'loaded' };
  return { id: def ?? 'unknown', ctx: defM?.ctx ?? 0, source: 'default (lazy-load)' };
}

// ── enqueue ──────────────────────────────────────────────────────────────────

function enqueue({ repo, issue, agent, kind, comment, sender, eventId }) {
  const body = comment?.body ?? '';
  if (!isManaged(repo)) return;                     // global webhook: only act on managed repos
  if (sender === CFG.botLogin || sender === CFG.chatLogin) return; // never react to our own agents (task bot + chat user)
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

// Internal review-chain tasks: enqueued by 00-tea itself (never via the
// webhook — agent comments carry the via:agent marker and are ignored).
// comment_id is NULL, so the (repo, kind, comment_id) webhook dedupe never
// matches them; the parent_id+kind checks below are their loop guard.
function enqueueReview(work, logText) {
  if (!CFG.reviewToken) {
    console.log(`[review] task ${work.id}: REVIEW_TOKEN not set — review chain skipped`);
    return;
  }
  const dup = db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND kind = 'agent-review'").get(work.id);
  if (dup) return;
  const pr = /\[00-tea\] pr: #(\d+)/.exec(logText)?.[1] ?? null;
  db.prepare(
    `INSERT INTO tasks (repo, issue, agent, kind, body, parent_id, round, pr)
     VALUES (?, ?, 'review', 'agent-review', ?, ?, ?, ?)`
  ).run(work.repo, work.issue, work.body ?? null, work.id, work.round ?? 1, pr ? +pr : null);
  console.log(`[review] task ${work.id} pushed → review enqueued (round ${work.round ?? 1}${pr ? `, PR #${pr}` : ''})`);
}

function enqueueRework(review, concerns) {
  const work = db.prepare('SELECT * FROM tasks WHERE id = ?').get(review.parent_id);
  const dup = db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND kind = 'rework'").get(review.id);
  if (dup) return;
  db.prepare(
    `INSERT INTO tasks (repo, issue, agent, kind, body, parent_id, round, pr)
     VALUES (?, ?, ?, 'rework', ?, ?, ?, ?)`
  ).run(review.repo, review.issue, work?.agent ?? 'pi', concerns, review.id, (review.round ?? 1) + 1, review.pr ?? null);
  console.log(`[review] task ${review.id} verdict=fail → rework enqueued (round ${(review.round ?? 1) + 1}, @${work?.agent ?? 'pi'})`);
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

async function apiPost(p, body) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    method: 'POST',
    headers: { Authorization: `token ${CFG.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}`);
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

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if none of the following happens, so do not end without it:
1. Push your commits (and open a PR if the guide above says so).
2. Write a short reply (what you did, plus any PR/branch name) to /tmp/reply.md and post it:
   bash .00-tea/post-comment.sh ${issue} /tmp/reply.md
`;
}

function reviewPrompt({ issue, request, cpath, line }) {
  return `A reviewer left an inline comment in PR #${issue}${cpath ? ` on ${cpath}` : ''}${line ? ` at line ${line}` : ''}:
${request}

Find the PR head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${issue} | jq -r .head.ref
Then: git fetch origin pull/${issue}/head && git checkout FETCH_HEAD
Address the review comment: make the changes, commit, and push to the head branch.

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if you finish without pushing commits AND without posting this reply:
write a short reply (what you changed) to /tmp/reply.md and post it:
bash .00-tea/post-comment.sh ${issue} /tmp/reply.md`;
}

// agent-review: the reviewer is READ-ONLY — its clone uses the read-only
// token and it never receives the write token, so it cannot push OR post.
// It writes the review to /tmp/reply.md; the bootstrap echoes the file into
// the task log between [00-tea] review-body-* markers and 00-tea posts the
// comment itself (afterTask) + parses the verdict marker from it.
function agentReviewPrompt({ issue, pr, refs, request }) {
  const scope = pr
    ? `The work is in PR #${pr}:
BASE=$(curl -s -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls/${pr}" | jq -r .base.ref)
git fetch origin "pull/${pr}/head" && git checkout FETCH_HEAD && git fetch origin "$BASE"
Review the diff: git diff "origin/\${BASE}"...HEAD`
    : refs.map((r) =>
        r.old.replace(/0/g, '') === ''
          ? `git fetch origin "\${r.ref#refs/heads/}" && git diff $(git merge-base origin/main ${r.new})..${r.new}`
          : `git fetch origin "\${r.ref#refs/heads/}" && git diff ${r.old}..${r.new}`
      ).join('\n');
  return `You are a CODE REVIEWER. Another agent implemented the change; you review it.

${scope}

Original request (what the change was supposed to do):
${request}

RULES — you are READ-ONLY:
- Do not edit files, do not commit, do not push (your clone is read-only; pushes will fail).
- Review for: correctness, security (no secrets committed), tests, error handling, scope creep.
- Use the code-review skill.

REQUIRED FINISH — the task is marked FAILED if you finish without writing the review:
write your review to /tmp/reply.md (00-tea posts it as a comment on #${issue}).
Every concern needs file:line + what is wrong + why it matters.
The LAST LINE of /tmp/reply.md must be exactly one of:
  <!-- review:pass -->
  <!-- review:fail -->
Use fail only for concrete, fixable concerns; pass if the work is acceptable.`;
}

function reworkPrompt({ issue, pr, request }) {
  const guide = pr
    ? `Find the PR head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${pr} | jq -r .head.ref
Then: git fetch origin pull/${pr}/head && git checkout FETCH_HEAD
Address the concerns: make the changes, commit, and push to the head branch.`
    : 'Address the concerns: make the changes, commit, and push.';
  return `A code reviewer reviewed your work${pr ? ` on PR #${pr}` : ''} and raised concerns:
${request}

${guide}

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if you finish without pushing commits AND without posting this reply:
write a short reply (what you changed) to /tmp/reply.md and post it:
bash .00-tea/post-comment.sh ${issue} /tmp/reply.md`;
}

async function runTask(t) {
  const logfile = path.join(CFG.dataDir, 'logs', `${t.id}.log`);
  const log = { text: '', file: logfile };
  running.set(t.id, log);
  const say = (s) => { log.text += s; fs.appendFileSync(logfile, s); };
  let tokens = null; // captured from the filter's end-of-stream marker
  let tail = '';

  try {
    // 1. resolve prompt inputs
    const issueInfo = await apiGet(`/repos/${t.repo}/issues/${t.issue}`);
    const isPull = issueInfo.pull_request != null;
    const parent = t.parent_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.parent_id) : null;
    const request =
      t.kind === 'rework'
        ? t.body ?? ''                                    // the reviewer's concerns
        : stripMention(t.body ?? '', parent?.agent ?? t.agent);
    const prompt =
      t.kind === 'review'
        ? reviewPrompt({ issue: t.issue, request, cpath: t.cpath, line: t.line })
        : t.kind === 'agent-review'
          ? agentReviewPrompt({
              issue: t.issue,
              pr: t.pr ?? null,
              refs: parseRefs(parent ? readLog(parent.id) : ''),
              request,
            })
          : t.kind === 'rework'
            ? reworkPrompt({ issue: t.issue, pr: t.pr ?? null, request })
            : commentPrompt({ issue: t.issue, title: issueInfo.title, body: issueInfo.body, isPull, request });

    // 2a. model selection — prefer a model the router already has loaded
    //     (lazy-loading another 27B+ model fails while one is resident).
    //     Both agents share the router; opencode's --model overrides its
    //     baked config (the model id must exist in that config's list).
    const modelSel = await pickModel();
    if (modelSel) {
      db.prepare('UPDATE tasks SET model=?, model_ctx=? WHERE id=?').run(modelSel.id, modelSel.ctx, t.id);
      say(`$ model: ${modelSel.id} (ctx ${modelSel.ctx}, ${modelSel.source})\n`);
    }

    // 2. self-contained bootstrap script, executed INSIDE the job container.
    //    No host-path bind mounts (00-tea talks to the host docker daemon, so
    //    container paths are not host paths). Clone as bot → authenticated
    //    remote, so agent commits/PRs attribute to the bot user.
    //
    //    NOTE: docker -e values have their newlines flattened to spaces, so
    //    everything multi-line (prompt, helper scripts) goes into the script
    //    text via quoted heredocs, and the script itself is passed base64.
    // Enforcement: a finished agent must have taken a visible action (pushed
    // commits, opened a PR, or posted a reply). If it did none of that, post
    // a fallback error comment and flag the task as a failure (checked in
    // runTask via the '[00-tea] no-action' marker).
    // agent-review: the reviewer writes /tmp/reply.md; it is echoed into the
    // log between markers (00-tea posts it — the container has no write
    // token) and a missing file fails the task.
    const enforce = t.kind === 'agent-review' ? `

echo '$ enforcing: reviewer must have written a review'
if [ -s /tmp/reply.md ]; then
  echo '[00-tea] review-body-begin'
  cat /tmp/reply.md
  echo ''
  echo '[00-tea] review-body-end'
else
  echo '[00-tea] no-action: reviewer wrote no review' >&2
  exit 1
fi
` : `

echo '$ enforcing: agent must have taken an action (commit/PR/reply)'
ACTION=""
git ls-remote --heads origin > /tmp/refs-after.txt 2>/dev/null || true
# only trust the diff when both snapshots succeeded (non-empty)
if [ -s /tmp/refs-before.txt ] && [ -s /tmp/refs-after.txt ] && ! cmp -s /tmp/refs-before.txt /tmp/refs-after.txt; then
  ACTION="pushed commits"
  # machine-readable ref changes (old new ref) — the review chain parses these;
  # an open bot PR on a changed branch is reported too (PR-based review prompt)
  for ref in $(awk '{print $2}' /tmp/refs-after.txt | sort -u); do
    old=$(awk -v r="$ref" '$2==r{print $1}' /tmp/refs-before.txt)
    new=$(awk -v r="$ref" '$2==r{print $1}' /tmp/refs-after.txt)
    [ -n "$new" ] || continue
    [ "\${old:-0000000000000000000000000000000000000000}" = "$new" ] && continue
    echo "[00-tea] ref: $ref \${old:-0000000000000000000000000000000000000000} $new"
    p=$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls?state=open&limit=50" 2>/dev/null \\
      | jq -r --arg bot "$BOT_NAME" --arg b "\${ref#refs/heads/}" '[.[] | select(.user.login == $bot and .head.ref == $b)] | first | .number' 2>/dev/null || true)
    [ -n "$p" ] && [ "$p" != "null" ] && echo "[00-tea] pr: #$p"
  done
fi
if [ -z "$ACTION" ]; then
  PRINFO="$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls?state=open&limit=10" 2>/dev/null | jq -r --arg bot "$BOT_NAME" '[.[] | select(.user.login == $bot)] | last | select(. != null) | (.created_at) + " #" + (.number | tostring)' || true)"
  # NOTE: the > operator must be QUOTED — unquoted, the shell parses it as
  # an output redirection ([ A > B ] = [ A ] with stdout redirected to file B,
  # which is always true for a non-empty A)
  if [ -n "$PRINFO" ] && [ "\${PRINFO%% #*}" \">" "$(cat /tmp/start-iso.txt)" ]; then
    ACTION="opened PR \${PRINFO#* }"
    echo "[00-tea] pr: #\${PRINFO##*#}"
  fi
fi
if [ -z "$ACTION" ]; then
  LASTC="$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/issues/$TASK_ISSUE/comments?limit=20" 2>/dev/null | jq -r --arg bot "$BOT_NAME" '[.[] | select(.user.login == $bot)] | last | select(. != null) | .created_at' || true)"
  if [ -n "$LASTC" ] && [ "$LASTC" \">" "$(cat /tmp/start-iso.txt)" ]; then
    ACTION="posted a reply comment"
  fi
fi
if [ -s /tmp/reply.md ]; then
  bash .00-tea/post-comment.sh "$TASK_ISSUE" /tmp/reply.md
  echo '[00-tea] posted reply from /tmp/reply.md'
elif [ -n "$ACTION" ]; then
  echo "[00-tea] no reply file, but the agent already acted: $ACTION"
else
  echo '[00-tea] ERROR: agent took no action (no commit, no PR, no reply)' >&2
  printf '%s\n' '[00-tea] The agent finished but took no visible action (no commit, PR, or reply). Re-run the request or check the task log on the 00-tea dashboard.' > /tmp/reply.md
  bash .00-tea/post-comment.sh "$TASK_ISSUE" /tmp/reply.md
  echo '[00-tea] no-action: fallback comment posted' >&2
fi
`;

    const assetsDir = path.join(__dirname, 'assets');
    const delim = () => `EOF_${crypto.randomBytes(6).toString('hex')}`;
    const dPrompt = delim(), dPost = delim(), dJq = delim(), dOc = delim();
    // (dJq: the name is historical — it now carries the node filter)
    const bootstrap = `
set -e
mkdir -p /work && cd /work
date -u +%Y-%m-%dT%H:%M:%S > /tmp/start-iso.txt
echo '$ git clone ${t.repo}'
git clone -q "$CLONE_URL" repo
cd repo
git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"
# BEFORE-snapshot of remote refs must be taken INSIDE the repo (a failure
# here is fatal — an empty snapshot would make the later diff a false
# positive and mask a no-op agent)
git ls-remote --heads origin > /tmp/refs-before.txt
mkdir -p .00-tea
cat > .00-tea/post-comment.sh <<'${dPost}'
${fs.readFileSync(path.join(assetsDir, 'post-comment.sh'), 'utf8').replace(/\n+$/, '')}
${dPost}
cat > .00-tea/output_filter.mjs <<'${dJq}'
${fs.readFileSync(path.join(assetsDir, 'output_filter.mjs'), 'utf8').replace(/\n+$/, '')}
${dJq}
cat > .00-tea/opencode_filter.mjs <<'${dOc}'
${fs.readFileSync(path.join(assetsDir, 'opencode_filter.mjs'), 'utf8').replace(/\n+$/, '')}
${dOc}
chmod +x .00-tea/post-comment.sh
cat > /tmp/prompt.txt <<'${dPrompt}'
${prompt}
${dPrompt}
PROMPT="$(cat /tmp/prompt.txt)"
export PROMPT
echo ''
echo '$ ${t.agent} agent (runsc sandbox${modelSel ? `, model ${modelSel.id}` : ''})'
` + (t.agent === 'pi'
      ? `bash -o pipefail -c \'pi -p --mode json --model "llama.cpp/${modelSel.id}" "$PROMPT" | tee /tmp/agent-out.jsonl | node .00-tea/output_filter.mjs\'\n` +
        // pi >= 0.82: the SESSION-end event is `agent_settled` — emitted in
        // prompt()'s finally, AFTER `agent_end` and all post-run processing
        // (retries, compaction). `agent_end` only closes the loop, so it is
        // NOT the last stream line. A clean run: last line is agent_settled,
        // the last agent_end carries no errorMessage, and no finalError
        // (exhausted auto-retry) appears anywhere in the stream.
        'tail -n1 /tmp/agent-out.jsonl > /tmp/last-event.json\n' +
        'if ! grep -q \'"type":"agent_settled"\' /tmp/last-event.json; then\n' +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\n' +
        'if grep \'"type":"agent_end"\' /tmp/agent-out.jsonl | tail -n1 | grep -q \'"errorMessage"\' || grep -q \'"finalError"\' /tmp/agent-out.jsonl; then\n' +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\necho "[00-tea] agent finished OK"'
      : `bash -o pipefail -c 'opencode run --format json --auto --model "llama.cpp/${modelSel.id}" "$PROMPT" | tee /tmp/agent-out.jsonl | OPENCODE_MODEL="llama.cpp/${modelSel.id}" node .00-tea/opencode_filter.mjs'\n` +
        'tail -n1 /tmp/agent-out.jsonl > /tmp/last-event.json\n' +
        `if grep -q '"type":"error"' /tmp/last-event.json || ! grep -q '"type":"step_finish"' /tmp/last-event.json; then\n` +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\necho "[00-tea] agent finished OK"') + enforce;
    const b64 = Buffer.from(bootstrap).toString('base64');

    say(`$ docker run --rm --runtime=runsc ${CFG.images[t.agent]} (bootstrap + ${t.agent})\n\n`);

    // 3. run the agent in a fresh gVisor-sandboxed container
    await new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '--runtime=runsc',
        '--add-host=gitea:host-gateway',
        '--add-host=host.docker.internal:host-gateway',
        // agent-review runs on the READ-ONLY token for everything (clone +
        // API): the reviewer physically cannot push or post — 00-tea posts
        // its comment from the task log.
        '-e', `BOOTSTRAP_B64=${b64}`,
        '-e', `CLONE_URL=http://bot:${t.kind === 'agent-review' ? CFG.reviewToken : CFG.agentToken}@${CFG.giteaHost}/${t.repo}.git`,
        '-e', `BOT_NAME=${CFG.botLogin}`,
        '-e', `BOT_EMAIL=${CFG.botEmail}`,
        '-e', `AGENT_TOKEN=${t.kind === 'agent-review' ? CFG.reviewToken : CFG.agentToken}`,
        '-e', `TASK_ISSUE=${t.issue}`,
        '-e', `GITEA_API=http://${CFG.giteaHost}/api/v1`,
        '-e', `GITEA_REPO=${t.repo}`,
        CFG.images[t.agent], 'sh', '-c', 'sh -c "$(printf %s "$BOOTSTRAP_B64" | base64 -d)"',
      ]);
      const onOut = (d) => {
        const s = d.toString();
        say(s);
        const m = /\[00-tea\] usage: model=\S+ tokens=(\d+)/.exec(tail + s); // filter's end-of-stream marker
        if (m) tokens = +m[1];
        tail = s.length > 80 ? s.slice(-80) : s;
      };
      child.stdout.on('data', onOut);
      child.stderr.on('data', onOut);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`agent exited with code ${code}`))));
    });

    // enforcement result: the bootstrap posted a fallback comment when the
    // agent did nothing visible — surface that as a task failure
    if (log.text.includes('[00-tea] no-action: fallback comment posted'))
      throw new Error('agent took no action (no commit/PR/reply) — fallback comment posted');
  } catch (e) {
    say(`\n[00-tea] ERROR: ${e.message}\n`);
    throw e;
  } finally {
    if (tokens != null) db.prepare('UPDATE tasks SET tokens=? WHERE id=?').run(tokens, t.id);
    running.delete(t.id);
  }
}

// ── review chain (after a task finishes successfully) ───────────────────────

const readLog = (id) => {
  try { return fs.readFileSync(path.join(CFG.dataDir, 'logs', `${id}.log`), 'utf8'); }
  catch { return ''; }
};
const parseRefs = (text) => [...text.matchAll(/\[00-tea\] ref: (\S+) ([0-9a-f]{40}) ([0-9a-f]{40})/g)]
  .map((m) => ({ ref: m[1], old: m[2], new: m[3] }));

async function afterTask(t) {
  if (t.kind === 'agent-review') {
    // 00-tea posts the review itself (the container had no write token),
    // then acts on the verdict marker in the review body.
    const m = /\[00-tea\] review-body-begin\n([\s\S]*?)\n\[00-tea\] review-body-end/.exec(readLog(t.id));
    if (!m) { console.log(`[review] task ${t.id}: no review body in log — chain stops`); return; }
    const body = m[1].trim();
    await apiPost(`/repos/${t.repo}/issues/${t.issue}/comments`, { body: `${body}\n\n${MARKER}` });
    console.log(`[review] task ${t.id}: review posted on ${t.repo}#${t.issue}`);
    const v = /<!-- review:(pass|fail) -->/.exec(body);
    if (!v) { console.log(`[review] task ${t.id}: no verdict marker in review — chain stops`); return; }
    if (v[1] === 'pass') { console.log(`[review] task ${t.id}: verdict=pass`); return; }
    const round = t.round ?? 1;
    if (round >= CFG.reviewMaxRounds) {
      await apiPost(`/repos/${t.repo}/issues/${t.issue}/comments`, {
        body: `[00-tea] Review cycle exhausted: the reviewer still has concerns after ${round} round${round > 1 ? 's' : ''}. A human should take over.\n\n${MARKER}`,
      });
      console.log(`[review] task ${t.id}: verdict=fail at round cap (${CFG.reviewMaxRounds}) — cycle exhausted`);
      return;
    }
    enqueueRework(t, body);
    return;
  }
  // work tasks: a push starts the review chain (one review per work task —
  // the parent_id+kind dedupe in enqueueReview keeps this idempotent)
  if (['comment', 'review', 'rework'].includes(t.kind)) {
    const logText = readLog(t.id);
    if (parseRefs(logText).length) enqueueReview(t, logText);
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
    try { await afterTask(t); }
    catch (e) { console.error(`[after] task ${t.id}: ${e.message}`); }
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
  for (const repo of managedRepos()) {
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

async function handleWebhook(event, deliveryId, payload) {
  const repo = payload.repository?.full_name;
  if (!repo) return 0;

  let body = '';
  // comments on a PR arrive as pull_request_comment, not issue_comment
  if ((event === 'issue_comment' || event === 'pull_request_comment') && payload.action === 'created' && payload.issue?.number && payload.comment) {
    body = payload.comment?.body ?? '';
    // self-enroll: a mention on an unmanaged repo opts it in — persist it and
    // grant the bot write access, then the enqueue gate below passes
    if (!isManaged(repo) && MENTIONS.some((m) => m.re.test(body))) {
      try { await enroll(repo); }
      catch (e) { console.error(`[enroll] ${repo}: ${e.message} — mention ignored`); return 0; }
    }
    for (const m of MENTIONS)
      enqueue({ repo, issue: payload.issue.number, agent: m.agent, kind: 'comment', comment: payload.comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1; // enqueue() logs what it accepted
  }
  // full PR reviews (inline review comments have no hook event in 1.27 —
  // they arrive via the poll fallback)
  if (event === 'pull_request_review' && payload.action === 'created' && payload.review) {
    const prNo = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNo) return 0;
    body = payload.review?.body ?? '';
    if (!isManaged(repo) && MENTIONS.some((m) => m.re.test(body))) {
      try { await enroll(repo); }
      catch (e) { console.error(`[enroll] ${repo}: ${e.message} — mention ignored`); return 0; }
    }
    const comment = { id: payload.review.id, body, path: null, line: null };
    for (const m of MENTIONS)
      enqueue({ repo, issue: prNo, agent: m.agent, kind: 'review', comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1;
  }
  return 0;
}

// ── chat sessions (long-lived sandboxed agents over RPC/HTTP) ──────────────
// The /chat UI talks to a LIVE agent inside a long-lived runsc container —
// the counterpart of the one-shot task containers:
//
//   pi       : docker run -i … agent-sandbox:pi pi --mode rpc --model …
//              JSONL over stdin/stdout (prompt / abort / followUp-while-busy)
//   opencode : docker run … opencode serve --port 4096
//              REST: POST /session, POST /session/{id}/message (per-message
//              model override — `serve` has no -m flag), GET /event (SSE)
//
// Both join the CHAT_NETWORK (00-tea's compose network) and are reached by
// container name — no host port publishing (a 127.0.0.1 publish is invisible
// to 00-tea, which is itself a container).
//
// 00-tea is a dumb bridge: browser SSE ⇄ agent stream, POST message ⇄ agent
// command. Chat containers get NO Gitea token — they chat and can read the
// 00-tea task API (via host.docker.internal), they cannot push or post.
// Sessions are in-memory: a 00-tea restart abandons them (orphaned
// tea-chat-* containers are reaped at startup), idle ones are killed after
// CHAT_IDLE_MINUTES.

const chats = new Map(); // id -> session
let chatSeq = 0;

const chatAuthed = (req, url) =>
  !CFG.chatToken || url.searchParams.get('token') === CFG.chatToken ||
  req.headers['x-chat-token'] === CFG.chatToken;

// fan out one stream line to the log file, the replay buffer, and all SSE clients
const chatSay = (c, line) => {
  c.lastActive = Date.now();
  c.lines.push(line);
  if (c.lines.length > 2000) c.lines.shift();
  try { fs.appendFileSync(c.logFile, line + '\n'); } catch { /* non-fatal */ }
  for (const res of [...c.clients]) {
    try { res.write(`data: ${line}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

const chatKill = (c, note) => {
  if (c.dead) return;
  c.dead = true;
  // killing the `docker run` client does NOT remove the container — rm it by name
  // (docker 29 no longer prints the container id on `docker run`)
  try { c.child.kill('SIGKILL'); } catch { /* already gone */ }
  if (c.name) execFile('docker', ['rm', '-f', c.name], () => { /* gone */ });
  if (note) chatSay(c, `[00-tea] chat closed: ${note}`);
  for (const res of [...c.clients]) {
    try { res.write('event: done\ndata: \n\n'); res.end(); } catch { /* gone */ }
  }
  c.clients.clear();
  chats.delete(c.id);
  console.log(`[chat] ${c.id} (@${c.agent}) closed${note ? `: ${note}` : ''}`);
};

const chatJson = (c) => ({
  id: c.id, agent: c.agent, model: c.model, isStreaming: c.isStreaming,
  lastActive: c.lastActive,
});

// The chat agent's extra context: read-only eyes on the dispatcher itself,
// so a chat can answer "what are my agents doing / which model is loaded".
// The Gitea section is only present when CHAT_GITEA_TOKEN is configured —
// with it, the agent acts as the separate "chat" user (see createChat env)
const CHAT_SYSTEM = `You are an interactive assistant inside a disposable sandbox (bash + file tools, empty workspace /work).
You can read the 00-tea dispatcher state (which runs the Gitea coding agents) via its read-only API:
  curl -s http://host.docker.internal:3001/api/tasks | jq '.[0:5]'
Use it when asked about tasks, agents, models, or token usage.${CFG.chatGiteaToken ? `
You have Gitea access as user "${CFG.chatLogin}" (token: $GITEA_TOKEN, API: $GITEA_URL):
  clone:  git clone http://${CFG.chatLogin}:$GITEA_TOKEN@host.docker.internal:3000/OWNER/REPO
  api:    curl -s -H "Authorization: token $GITEA_TOKEN" $GITEA_URL/api/v1/...
You can READ any repo you can see. You can only WRITE (push, comment, PR) in repos where you have been granted collaborator access — if a push fails with 403 "permission denied", say so and stop trying other write paths.` : ' You have no write access to Gitea.'}`;

async function createChat(agent) {
  if (!['pi', 'opencode'].includes(agent)) throw new Error(`unknown agent: ${agent}`);
  const modelSel = await pickModel();
  chatSeq++;
  const id = chatSeq;
  const c = {
    id, agent, model: modelSel?.id ?? null,
    isStreaming: false, dead: false,
    clients: new Set(), lines: [],
    lastActive: Date.now(),
    logFile: path.join(CFG.dataDir, 'chats', `${id}.log`),
    child: null, name: '', ocSession: null,
  };
  fs.mkdirSync(path.dirname(c.logFile), { recursive: true });
  chats.set(id, c);
  c.name = `tea-chat-${id}-${crypto.randomBytes(3).toString('hex')}`;

  // Gitea access for the chat agent: separate "chat" user (audit separation
  // from task work). Write still requires a per-repo collaborator grant.
  // host.docker.internal (not the compose service name): the runsc sandbox
  // can't reach Docker's built-in DNS, so name resolution must come from
  // /etc/hosts — same pattern the task containers use for GITEA_HOST
  const giteaEnv = CFG.chatGiteaToken
    ? ['-e', `GITEA_TOKEN=${CFG.chatGiteaToken}`, '-e', 'GITEA_URL=http://host.docker.internal:3000']
    : [];

  if (agent === 'pi') {
    c.child = spawn('docker', [
      'run', '--rm', '-i',
      '--runtime=runsc',
      '--network', CFG.chatNetwork,
      '--add-host=host.docker.internal:host-gateway',
      '--name', c.name,
      ...giteaEnv,
      CFG.images.pi,
      'pi', '--mode', 'rpc',
      '--model', `llama.cpp/${modelSel?.id ?? 'unknown'}`,
      '--append-system-prompt', CHAT_SYSTEM,
    ]);
    const dec = new StringDecoder('utf8');
    let buf = '';
    c.child.stdout.on('data', (d) => {
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { // LF-only framing (U+2028/2029 are valid in JSON strings)
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (line.includes('"agent_start"')) c.isStreaming = true;
        if (line.includes('"agent_settled"')) c.isStreaming = false;
        chatSay(c, line);
      }
    });
    c.child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) chatSay(c, `[stderr] ${s}`);
    });
    c.child.stdin.on('error', () => { /* EPIPE — the container is already gone */ });
  } else {
    c.child = spawn('docker', [
      'run', '--rm',
      '--runtime=runsc',
      '--network', CFG.chatNetwork,
      '--add-host=host.docker.internal:host-gateway',
      '--name', c.name,
      ...giteaEnv,
      CFG.images.opencode,
      'opencode', 'serve', '--hostname', '0.0.0.0', '--port', '4096',
    ]);
    c.child.stdout.on('data', () => { /* drain */ });
    c.child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s && !s.includes('listening on')) chatSay(c, `[stderr] ${s}`);
    });
    // the port is published on the HOST's 127.0.0.1 — from this container
    // that is host.docker.internal, not our own loopback
    const base = `http://${c.name}:4096`;
    let up = false;
    for (let i = 0; i < 60 && !up && !c.dead; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { up = (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* not up yet */ }
    }
    if (c.dead) return null;
    if (!up) { chatKill(c, 'opencode server did not start'); return null; }
    const sres = await fetch(`${base}/session`, { method: 'POST' });
    if (!sres.ok) { chatKill(c, `opencode POST /session → ${sres.status}`); return null; }
    c.ocSession = (await sres.json()).id;
    // forward the server's SSE event stream to the chat clients
    const eres = await fetch(`${base}/event`);
    const reader = eres.body.getReader();
    const dec = new StringDecoder('utf8');
    let sbuf = '';
    (async () => {
      while (!c.dead) {
        const { done, value } = await reader.read();
        if (done) break;
        sbuf += dec.write(value);
        let i;
        while ((i = sbuf.indexOf('\n\n')) >= 0) {
          const frame = sbuf.slice(0, i);
          sbuf = sbuf.slice(i + 2);
          for (const l of frame.split('\n'))
            if (l.startsWith('data: ')) chatSay(c, l.slice(6));
        }
      }
    })().catch(() => { /* stream ended with the container */ });
  }
  c.child.on('close', () => chatKill(c, 'container exited'));
  console.log(`[chat] ${id} started (@${agent}, model ${c.model}, container ${c.name})`);
  return c;
}

async function chatMessage(id, message) {
  const c = chats.get(id);
  if (!c || c.dead) throw new Error('no such chat');
  message = String(message ?? '').trim();
  if (!message) throw new Error('empty message');
  message = message.slice(0, 20000);
  c.lastActive = Date.now();
  // echo the user message into the stream: the transcript is SERVER-
  // authoritative, so a reconnect/reload replays the whole conversation
  // (user bubbles included) instead of only the agent side
  chatSay(c, JSON.stringify({ type: 'user_message', message }));
  if (c.agent === 'pi') {
    const cmd = { type: 'prompt', message };
    if (c.isStreaming) cmd.streamingBehavior = 'followUp'; // deliver once the agent stops
    c.child.stdin.write(JSON.stringify(cmd) + '\n');
  } else {
    // `opencode serve` has no model flag — the model is picked per message
    const res = await fetch(`http://${c.name}:4096/session/${c.ocSession}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: message }],
        model: c.model ? { providerID: 'llama.cpp', modelID: c.model } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`opencode message → ${res.status}`);
    await res.text();
  }
}

async function chatAbort(id) {
  const c = chats.get(id);
  if (!c || c.dead) return;
  if (c.agent === 'pi') c.child.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
  else { try { await fetch(`http://${c.name}:4096/session/${c.ocSession}/abort`, { method: 'POST' }); } catch { /* gone */ } }
}

// reap chat containers orphaned by a previous 00-tea run (they are plain
// docker containers — they outlive the dispatcher that spawned them)
execFile('docker', ['ps', '-aq', '--filter', 'name=tea-chat-', '--format', '{{.ID}}'],
  (err, out) => {
    if (err) return;
    for (const cid of out.trim().split('\n')) if (cid) execFile('docker', ['rm', '-f', cid]);
  });

setInterval(() => {
  for (const c of [...chats.values()])
    if (Date.now() - c.lastActive > CFG.chatIdleMs) chatKill(c, 'idle timeout');
}, 60_000).unref?.();

// ── HTTP server (API + barebones UI) ─────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sidebar(active) {
  // gitea link resolved client-side: same host as the UI, port 3000
  // mobile: off-canvas drawer toggled by #navToggle, closed by backdrop or nav click
  return `<button id="navToggle" aria-label="menu">☰</button>
<div id="backdrop"></div>
<aside class="sidebar" id="sidebar"><span class="brand">00-tea</span>
<a class="navl${active === 'home' ? ' on' : ''}" href="/">home</a>
<a class="navl${active === 'tasks' ? ' on' : ''}" href="/tasks">tasks</a>
<a class="navl${active === 'chat' ? ' on' : ''}" href="/chat">chat</a>
<a class="navl${active === 'android' ? ' on' : ''}" href="/android">android</a>
<a class="navl${active === 'pages' ? ' on' : ''}" href="/pages">pages</a>
<a class="navl${active === 'repos' ? ' on' : ''}" href="/repos">repos</a>
<a class="navl${active === 'stats' ? ' on' : ''}" href="/stats">stats</a>
<a class="navl${active === 'backends' ? ' on' : ''}" href="/backends">backends</a>
<a class="navl sbfoot" id="giteaLink" href="#">gitea ↗</a></aside>
<script>var sb=document.getElementById('sidebar'),bd=document.getElementById('backdrop'),tg=document.getElementById('navToggle');
tg.onclick=function(){bd.classList.toggle('show',sb.classList.toggle('open'));};
bd.onclick=function(){sb.classList.remove('open');bd.classList.remove('show');};
document.querySelectorAll('.sidebar a').forEach(function(a){a.addEventListener('click',function(){sb.classList.remove('open');bd.classList.remove('show');});});
var g=document.getElementById('giteaLink');if(g)g.href=location.protocol+'//'+location.hostname+':3000';</script>`;
}

function page(title, bodyHtml, { auto = true, nav = null, app = false } = {}) {
  const th = giteaTheme();
  const reload = auto ? '<script>setTimeout(()=>location.reload(),3000)</script>' : '';
  const side = nav ? sidebar(nav) : '';
  // Colors come from Gitea's theme CSS (served same-origin, see giteaTheme());
  // every var() has a hardcoded dark fallback so the UI works if Gitea is down.
  return `<!doctype html><html data-theme="${th.theme}"><head><meta charset="utf-8"><title>${esc(title)} — 00-tea</title>
<link rel="stylesheet" href="/assets/gitea-theme.css">
<script>function glinkFix(){document.querySelectorAll('a.glink').forEach(function(a){a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo+'/actions/runs/'+a.dataset.run;});}</script>
<style>
*{box-sizing:border-box}
:root{--radius:10px;--radius-sm:7px}
body{font:14px/1.6 -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;background:var(--color-body,#111);color:var(--color-text,#ddd);margin:0;-webkit-font-smoothing:antialiased}
a{color:var(--color-primary-light-2,#7ab)}
h1{font-size:20px;font-weight:700;letter-spacing:-.01em}
h2{font-size:13px;font-weight:600;margin:22px 0 8px;color:var(--color-text-light-2,#aab);text-transform:uppercase;letter-spacing:.04em}
/* mobile-first: off-canvas drawer; desktop (>=768px) pins it open */
.layout{min-height:100vh}
main{min-width:0;padding:16px;padding-top:56px;max-width:960px}
/* full-height app layout (chat): header top, messages fill, input pinned bottom */
main.app{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.chatapp{flex:1;min-height:0;display:flex;flex-direction:column;max-width:960px;width:100%;margin:0 auto}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:200px;z-index:30;background:var(--color-nav-bg,#0c0c0c);border-right:1px solid var(--color-light-border,#2a2a2a);padding:18px 12px;display:flex;flex-direction:column;transform:translateX(-100%);transition:transform .18s ease-out}
.sidebar.open{transform:none}
.sidebar .brand{font-weight:700;font-size:15px;letter-spacing:-.02em;color:var(--color-text,#eee);padding:0 10px 18px}
#navToggle{position:fixed;top:12px;left:12px;z-index:40;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:8px;color:var(--color-input-text,#7ab);font:14px -apple-system,system-ui,sans-serif;padding:5px 11px;cursor:pointer}
#backdrop{display:none;position:fixed;inset:0;background:var(--color-overlay-backdrop,rgba(0,0,0,.55));z-index:25}
#backdrop.show{display:block}
.navl{display:block;color:var(--color-nav-text,#8ab);text-decoration:none;padding:8px 12px;font-size:13.5px}
.navl:hover{color:var(--color-text,#cde);text-decoration:none}
.navl.on{color:var(--color-text,#fff);font-weight:600}
.sbfoot{margin-top:auto}
/* card surface (no tables): each .item is a whole-block clickable row */
.list{border:1px solid var(--color-light-border,#2a2a2a);border-radius:var(--radius);overflow:hidden;background:var(--color-secondary-alpha-10,rgba(255,255,255,.02))}
.item{display:block;text-decoration:none;color:inherit;padding:11px 15px;border-bottom:1px solid var(--color-light-border,#242424)}
.item:last-child{border-bottom:none}
.item:hover{background:var(--color-hover,rgba(255,255,255,.04))}
.l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13.5px}
.l2{color:var(--color-text-light-2,#8a8a8a);font-size:12.5px;margin-top:3px;line-height:1.5}
.err{color:var(--color-error-text,#f76);font-size:12.5px;margin-top:3px;word-break:break-word}
.model{color:var(--color-text-3,#777);font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ctx{color:var(--color-text-light-2,#888);font-size:11.5px}
.meta{color:var(--color-text-light-2,#888);font-size:12.5px}
.hook{font-weight:400;font-size:12.5px}.hook.ok{color:var(--color-success-text,#6d6)}.hook.bad{color:var(--color-error-text,#f66)}
.del{cursor:pointer;font-size:13px;margin-left:8px;color:var(--color-text-light-2,#888)}
.del:hover{color:var(--color-error-text,#f66)}
.grantbtn{margin-left:auto;background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm);padding:3px 10px;cursor:pointer;font-size:12px}
.grantbtn:hover{border-color:var(--color-primary,#7ab)}
/* status pill badges */
.queued,.running,.success,.failure{display:inline-block;font-size:11px;font-weight:600;padding:1px 9px;border-radius:11px;border:1px solid transparent;white-space:nowrap;line-height:1.6}
.queued{color:var(--color-text-light-2,#999);border-color:var(--color-text-light-2,#555)}
.running{color:var(--color-primary-light-1,#7cf);border-color:var(--color-primary,#36c);background:rgba(90,140,255,.12)}
.success{color:var(--color-success-text,#6d6);border-color:var(--color-success-text,#3a3);background:rgba(90,200,90,.12)}
.failure{color:var(--color-error-text,#f66);border-color:var(--color-error-text,#a33);background:rgba(255,90,90,.12)}
/* live indicator (pulsing dot) — shared by task + chat streaming views */
.live{display:inline-flex;align-items:center;gap:6px;color:var(--color-primary-light-1,#7cf);font-size:12px;font-weight:500;margin-left:4px}
.live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--color-primary,#7ab);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
/* page header: title row + meta */
.pagehead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.pagehead h1{margin:0}
.back{display:inline-block;text-decoration:none;font-size:12.5px;color:var(--color-text-light-2,#999);margin-bottom:10px}
.back:hover{color:var(--color-text,#ddd);text-decoration:underline}
/* console: shared stream surface for task logs AND chat */
.console{background:var(--color-console-bg,#0a0a0a);color:var(--color-console-fg,#d7d7d7);border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:14px 16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin-top:12px;max-height:calc(100vh - 240px)}
pre{background:var(--color-console-bg,#0a0a0a);color:var(--color-console-fg,#d7d7d7);border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:14px 16px;overflow-x:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.bar{height:6px;background:var(--color-secondary-alpha-20,#1a1a1a);border-radius:3px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--color-primary,#7ab);border-radius:3px}
/* chat — same console/indicator language as the task views */
#msgs{flex:1;min-height:0;overflow-y:auto;border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:10px 14px;margin:12px 0;background:var(--color-console-bg,transparent)}
.muser{background:var(--color-secondary-alpha-20,rgba(90,140,255,.1));border:1px solid var(--color-light-border,#2a2a2a);border-radius:var(--radius-sm);padding:9px 13px;margin:9px 0;white-space:pre-wrap;font-size:13px}
.muser::before{content:"you";display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--color-primary-light-1,#7cf);margin-bottom:3px}
.mtext{border-left:3px solid var(--color-primary,#7ab);padding:4px 13px;margin:9px 0;white-space:pre-wrap;font-size:13px}
.mtool{color:var(--color-text-light-2,#888);font-size:12px;margin:6px 0;word-break:break-word;border-left:2px solid var(--color-light-border,#333);padding-left:10px}
.mtool code{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.merr{color:var(--color-error-text,#f76);font-size:12.5px;margin:8px 0;white-space:pre-wrap}
.msettle{color:var(--color-text-light-3,#666);font-size:11.5px;margin:12px 0;text-align:right}
.mstatus{color:var(--color-primary-light-1,#7cf);font-size:12.5px;margin:8px 0;opacity:.85}
.chatin{display:flex;gap:8px;align-items:stretch;flex:none;margin-top:4px}
.chatbtns{display:flex;flex-direction:column;gap:8px;align-items:stretch}
.chatbtns .ic{display:inline-block;margin-right:7px;vertical-align:middle;transform:translateY(-1px)}
#send{border-color:var(--color-success-text,#3a3)}
#send .ic{color:var(--color-success-text,#3a3)}
#send:hover{border-color:var(--color-success-text,#6d6);background:rgba(90,200,90,.14)}
#stop{border-color:var(--color-error-text,#a33)}
#stop .ic{color:var(--color-error-text,#a33)}
#stop:hover{border-color:var(--color-error-text,#f66);background:rgba(255,90,90,.14)}
.chatin textarea{flex:1;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:var(--radius-sm);color:var(--color-input-text,#ddd);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;resize:vertical}
.chatin textarea:focus{outline:none;border-color:var(--color-primary,#7ab)}
.chatin button,#newchat button{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm);padding:7px 15px;cursor:pointer;font-size:13px}
.chatin button:hover,#newchat button:hover{border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}
#newchat{display:flex;gap:8px;margin:12px 0}
#newchat select{background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);color:var(--color-input-text,#ddd);border-radius:var(--radius-sm);padding:7px}
@media (min-width:768px){
  .sidebar{transform:none}
  #navToggle,#backdrop{display:none}
  main{margin-left:200px;padding:28px 32px}
  main.app{padding:16px 24px 12px}
}
</style></head><body>
<div class="layout${app ? ' app' : ''}">${side}<main class="${app ? 'app' : ''}">${bodyHtml}</main></div>
${reload}</body></html>`;
}

const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
function ctxLine(t) {
  if (t.tokens == null || !t.model_ctx) return '';
  const pct = Math.min(100, Math.round((t.tokens / t.model_ctx) * 100));
  return ` · <span class="ctx" title="context used / window">${fmtTok(t.tokens)}/${fmtTok(t.model_ctx)} tok (${pct}%)</span>`;
}

function taskRows(limit = 100) {
  return db.prepare(
    `SELECT * FROM tasks ORDER BY id DESC LIMIT ?`
  ).all(limit).map((t) => {
    const mid = [t.model ? ` · <span class="model">${esc(t.model)}</span>` : '', ctxLine(t)].filter(Boolean).join('');
    const chain = [
      t.kind === 'agent-review' || t.kind === 'rework' ? esc(t.kind) : '',
      (t.round ?? 1) > 1 ? `round ${t.round}` : '',
      t.parent_id ? `from #${t.parent_id}` : '',
    ].filter(Boolean).join(' · ');
    return `<a class="item" href="/task/${t.id}">
    <div class="l1"><span class="${t.status}">${t.status}</span> <span>#${t.id}</span> ${esc(t.repo)}#${t.issue}</div>
    <div class="l2">@${esc(t.agent)}${chain ? ` · ${chain}` : ''}${mid} · ${esc(t.created_at)}</div>
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
  </a>`;
  }).join('\n');
}

function tasksPage() {
  const rows = taskRows(100);
  return `<h1>00-tea tasks</h1><div class="list">${rows}</div>`;
}

// ── chat pages ─────────────────────────────────────────────────────────────

async function chatListPage() {
  const rows = [...chats.values()].map((c) => `<a class="item" href="/chat/${c.id}">
    <div class="l1">@${esc(c.agent)} <span>#${c.id}</span> ${c.isStreaming ? '<span class="running">streaming</span>' : '<span class="success">idle</span>'}</div>
    <div class="l2">${c.model ? `model <span class="model">${esc(c.model)}</span> · ` : ''}last activity ${esc(new Date(c.lastActive).toISOString().slice(11, 19))} UTC</div>
  </a>`).join('\n');
  // grant UI: every repo on the instance, with a per-repo grant/revoke toggle
  let grantUi = '';
  if (CFG.chatGiteaToken) {
    const grantAt = Object.fromEntries(
      db.prepare('SELECT repo, granted_at FROM chat_grants').all().map((g) => [g.repo, g.granted_at]));
    let allRepos = [], repoErr = null;
    try {
      // /admin/repos does not exist in Gitea 1.27 — search covers all repos
      // the admin token can see (private included)
      const rs = await apiGet('/repos/search?limit=250', { token: CFG.adminToken });
      allRepos = (rs.data ?? []).map((r) => r.full_name).sort();
    } catch (e) { repoErr = e.message; }
    const grantRows = allRepos.map((r) => {
      const granted = grantAt[r];
      return `<div class="item">
    <div class="l1">${esc(r)}${granted ? ` <span class="meta">· write since ${esc(granted)}</span>` : ''}
      <button class="grantbtn" data-repo="${esc(r)}" data-grant="${granted ? '0' : '1'}">${granted ? 'revoke write' : 'grant write'}</button></div>
  </div>`;
    }).join('');
    grantUi = `
<h2>gitea access — user <code>${esc(CFG.chatLogin)}</code></h2>
<p class="meta">chat agents act as the separate <code>${esc(CFG.chatLogin)}</code> Gitea user (audit separation from task work). read works everywhere; grant write per repo:</p>
<div class="list">${repoErr ? `<div class="item"><div class="l2">repo list unavailable: <span class="err">${esc(repoErr)}</span></div></div>` : grantRows || '<div class="item"><div class="l2">no repos on this instance</div></div>'}</div>`;
  }
  return `<h1>agent chat</h1>
<form id="newchat">
  <select name="agent"><option value="pi">pi</option><option value="opencode">opencode</option></select>
  <button type="submit">start chat</button>
</form>
<div class="list">${rows || '<div class="item"><div class="l2">no active chats</div></div>'}</div>
${grantUi}
<p class="meta">each chat is a long-lived gVisor sandbox with one agent.${CFG.chatGiteaToken ? ` it has Gitea access as <code>${esc(CFG.chatLogin)}</code> (write where granted above)` : ' no Gitea token — it chats and can read the 00-tea task API, but cannot push or post.'} chats die on 00-tea restart or after ${CFG.chatIdleMs / 60000} min idle.</p>
<script>
const tk = new URLSearchParams(location.search).get('token');
const auth = (p) => p + (tk ? '?token=' + encodeURIComponent(tk) : '');
document.getElementById('newchat').onsubmit = async function (e) {
  e.preventDefault();
  const agent = this.agent.value;
  const r = await fetch(auth('/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent }) });
  const j = await r.json();
  if (r.ok) location.href = '/chat/' + j.id; else alert(j.error || 'failed to start chat');
};
document.querySelectorAll('.grantbtn').forEach(b => b.onclick = async () => {
  const grant = b.dataset.grant === '1';
  if (!grant && !confirm('revoke ' + b.dataset.repo + ' write access for the chat agent?')) return;
  const r = await fetch(auth('/api/chat/grant'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: b.dataset.repo, grant }) });
  if (r.ok) location.reload(); else alert((await r.json()).error || 'grant failed');
});
</script>`;
}

function chatView(c) {
  return `<div class="chatapp">
<a class="back" href="/chat">← back to chats</a>
<div class="pagehead"><h1>chat @${esc(c.agent)} <span class="meta">#${c.id}</span></h1><span class="meta" id="chatstate">idle</span></div>
<p class="meta">${c.model ? `model <span class="model">${esc(c.model)}</span> · ` : ''}sandboxed container${CFG.chatGiteaToken ? `, Gitea access as <code>${esc(CFG.chatLogin)}</code> (write where granted)` : ', no Gitea access'} · <a href="#" id="closechat">close chat</a></p>
<div id="msgs"></div>
<div class="chatin">
  <textarea id="msg" rows="2" placeholder="message ${esc(c.agent)}… (Enter sends, Shift+Enter newline)"></textarea>
  <div class="chatbtns"><button id="send"><span class="ic">▷</span>send</button><button id="stop"><span class="ic">□</span>stop</button></div>
</div>
</div>
<script>
const agent = ${JSON.stringify(c.agent)};
const box = document.getElementById('msgs');
const stateEl = document.getElementById('chatstate');
const ta = document.getElementById('msg');
let curText = null;
const escH = (s) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const addEl = (cls, html) => {
  const d = document.createElement('div');
  d.className = cls; d.innerHTML = html;
  box.insertBefore(d, statusEl); // the status line always stays at the bottom
  box.scrollTop = box.scrollHeight;
  return d;
};
// live status line (thinking / writing / running tool / retrying) — updated
// in place, mirrored into the header
const statusEl = document.createElement('div');
statusEl.className = 'mstatus';
statusEl.style.display = 'none';
box.appendChild(statusEl);
const setStatus = (text) => {
  statusEl.style.display = text ? '' : 'none';
  statusEl.textContent = text || '';
  stateEl.textContent = text || 'idle';
  stateEl.className = text ? 'live' : 'meta'; // pulsing dot while working
  box.scrollTop = box.scrollHeight;
};
const userMsg = (t) => { curText = null; addEl('muser', escH(t)); };
const textBlock = (pid) => { curText = addEl('mtext', ''); if (pid) curText.dataset.pid = pid; };
const toolBlock = (name, arg) => addEl('mtool', '⚙ <b>' + escH(name) + '</b> <code>' + escH(String(arg).slice(0, 200)) + '</code>');
const handle = (line) => {
  let e; try { e = JSON.parse(line); } catch { if (line.startsWith('[00-tea]')) addEl('msettle', escH(line)); return; }
  // user messages travel through the stream (server-echoed) — the replay on
  // (re)connect therefore rebuilds the FULL conversation, not just the
  // agent side
  if (e.type === 'user_message') { userMsg(e.message); return; }
  if (agent === 'pi') {
    const d = e.assistantMessageEvent || {};
    if (e.type === 'message_update') {
      if (d.type === 'text_delta') {
        if (!curText) textBlock();
        curText.textContent += d.delta;
        box.scrollTop = box.scrollHeight;
        setStatus('writing…');
      } else if (d.type === 'thinking_delta') setStatus('thinking…');
    } else if (e.type === 'tool_execution_start') {
      curText = null;
      toolBlock(e.toolName, e.args && (e.args.command || JSON.stringify(e.args)));
      setStatus('running ' + e.toolName + '…');
    } else if (e.type === 'tool_execution_end') setStatus('thinking…');
    else if (e.type === 'agent_start') setStatus('working…');
    else if (e.type === 'agent_settled') { curText = null; setStatus(''); addEl('msettle', 'settled'); }
    else if (e.type === 'auto_retry_start') setStatus('retrying (' + e.attempt + '/' + e.maxAttempts + ')…');
    else if (e.type === 'response' && e.success === false) { setStatus(''); addEl('merr', 'error: ' + escH(e.error || 'command failed')); }
  } else {
    const p = e.properties || {};
    if (e.type === 'message.part.updated' && p.part) {
      if (p.part.type === 'reasoning') setStatus('thinking…');
      else if (p.part.type === 'text') {
        if (!curText || curText.dataset.pid !== p.part.id) textBlock(p.part.id);
        curText.textContent = p.part.text; // part.text is cumulative
        box.scrollTop = box.scrollHeight;
        if (p.part.text) setStatus('writing…');
      } else if (p.part.type === 'tool' && p.part.state && p.part.state.status === 'running') {
        curText = null;
        toolBlock(p.part.tool, (p.part.state.input && (p.part.state.input.command || JSON.stringify(p.part.state.input))) || '');
        setStatus('running ' + p.part.tool + '…');
      }
    } else if (e.type === 'session.idle') { curText = null; setStatus(''); addEl('msettle', 'done'); }
    else if (e.type === 'session.error') { setStatus(''); addEl('merr', 'error: ' + escH(JSON.stringify(p.error || p))); }
  }
};
const es = new EventSource('/chat/${c.id}/stream');
// every (re)connect replays the whole stream from the server — clear on open;
// statusEl MUST be re-attached: addEl() inserts before it, and insertBefore
// with a detached reference throws, silently killing all rendering
es.onopen = () => { box.innerHTML = ''; box.appendChild(statusEl); };
es.onmessage = (ev) => handle(ev.data);
es.addEventListener('done', () => { location.href = '/chat'; });
async function sendMsg() {
  const t = ta.value.trim();
  if (!t) return;
  ta.value = '';
  setStatus('sending…'); // the bubble arrives via the stream echo
  const r = await fetch('/api/chat/${c.id}/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: t }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); addEl('merr', j.error || 'send failed'); setStatus(''); }
}
document.getElementById('send').onclick = sendMsg;
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
document.getElementById('stop').onclick = () => fetch('/api/chat/${c.id}/abort', { method: 'POST' });
document.getElementById('closechat').onclick = async (e) => {
  e.preventDefault();
  await fetch('/api/chat/${c.id}', { method: 'DELETE' });
  location.href = '/chat';
};
</script>`;
}

// ── android builds (Gitea Actions runs on the `android` label) ─────────────
// The runs API does not expose the runner/label — that lives on the JOBS — so
// a run is an "android build" iff one of its jobs carries the `android` label
// (same opt-in the runner uses: runs-on: android).
async function androidRuns(limit = 30) {
  const runs = (await apiGet(`/admin/actions/runs?limit=${limit}`, { token: CFG.adminToken })).workflow_runs;
  const withJobs = await Promise.all(runs.map(async (r) => {
    let jobs = [];
    try {
      const j = await apiGet(`/repos/${r.repository.owner.login}/${r.repository.name}/actions/runs/${r.id}/jobs`,
        { token: CFG.adminToken, ok404: true });
      jobs = (j && j.jobs) || [];
    } catch { /* jobs unavailable — treated as non-android */ }
    r.jobs = jobs;
    r.isAndroid = jobs.some((j) => (j.labels || []).includes('android'));
    return r;
  }));
  return withJobs.filter((r) => r.isAndroid);
}

function runPill(r) {
  if (['queued', 'waiting', 'pending', 'running'].includes(r.status)) return `<span class="running">${esc(r.status)}</span>`;
  if (r.conclusion === 'success') return '<span class="success">success</span>';
  if (r.conclusion === 'failure') return '<span class="failure">failure</span>';
  if (r.conclusion === 'cancelled') return '<span class="queued">cancelled</span>';
  return `<span class="queued">${esc(r.status || '—')}</span>`;
}

function runRows(runs) {
  return runs.map((r) => `<a class="item glink" data-repo="${esc(r.repository.full_name)}" data-run="${r.id}" href="#">
    <div class="l1">${runPill(r)} <span>#${r.id}</span> ${esc(r.repository.full_name)} · ${esc(r.head_branch || '')}</div>
    <div class="l2">${esc((r.display_title || '').slice(0, 140))}${r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ''} · ${esc((r.started_at || '—').replace('T', ' ').slice(0, 19))}</div>
  </a>`).join('\n');
}

async function androidPage() {
  let runs = [], err = null;
  if (!CFG.adminToken) err = 'ADMIN_TOKEN not set — cannot list actions runs (add it to 00-tea in docker-compose.yml)';
  else { try { runs = await androidRuns(30); } catch (e) { err = e.message; } }
  return `<h1>android builds</h1>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<div class="list">${runs.length ? runRows(runs) : '<div class="item"><div class="l2">no android builds yet — jobs opt in with <code>runs-on: android</code></div></div>'}</div>
<p class="meta">built on <code>android-runner</code> (label <code>android</code>, image <code>gitea-android:latest</code>: JDK 21 + Android SDK + warm ~/.gradle) — separate from <code>my-runner</code> (ordinary CI)</p>
<script>glinkFix();</script>`;
}

// ── gh-pages sites (pages/ service instances) ─────────────────────────────
// PAGES_SITES entries: repo:port:container (e.g. owner/Pancratius:3002:gitea-pages)
async function pagesStatus() {
  return Promise.all(CFG.pagesSites.map(async (s) => {
    const [repo, port, container] = s.split(':');
    let commit = null, err = null;
    try {
      const out = (await execFileP('docker', ['exec', container, 'git', '-C', '/srv/pages', 'log', '-1', '--format=%h|%cI|%s'])).trim();
      const [h, at, ...rest] = out.split('|');
      commit = { h, at, s: rest.join('|') };
    } catch (e) { err = e.message; }
    return { repo, port, container, commit, err };
  }));
}

async function pagesPage() {
  const sites = await pagesStatus();
  const rows = sites.map((s) => `<a class="item plink" data-port="${esc(s.port)}" href="#">
    <div class="l1">${esc(s.repo)} <span class="meta">:${esc(s.port)}</span></div>
    <div class="l2">${s.commit
      ? `${esc(s.commit.h)} · ${esc(s.commit.at)} · ${esc(s.commit.s)}`
      : `<span class="err">not synced (${esc(s.err ?? 'no checkout')})`}</div>
  </a>`).join('\n');
  return `<h1>pages</h1>
<div class="list">${rows || '<div class="item"><div class="l2">no sites — set PAGES_SITES in .env (repo:port:container per pages service)</div></div>'}</div>
<p class="meta">each site is a <code>pages/</code> compose service serving a repo's <code>gh-pages</code> branch (CI pushes the branch, the server syncs every 60s). add one: new compose service (see <code>browser-llm-bench-pages</code>) → append <code>repo:port:container</code> to PAGES_SITES → <code>docker compose up -d 00-tea</code></p>
<script>document.querySelectorAll('a.plink').forEach(a=>a.href=location.protocol+'//'+location.hostname+':'+a.dataset.port);</script>`;
}

// ── home — latest from every section ───────────────────────────────────────
async function homePage() {
  const [runs, sites] = await Promise.all([
    CFG.adminToken ? androidRuns(8).catch(() => []) : Promise.resolve([]),
    pagesStatus(),
  ]);
  const siteRows = sites.map((s) => `<a class="item plink" data-port="${esc(s.port)}" href="#">
    <div class="l1">${esc(s.repo)} <span class="meta">:${esc(s.port)}</span></div>
    <div class="l2">${s.commit
      ? `${esc(s.commit.h)} · ${esc(s.commit.at)} · ${esc(s.commit.s)}`
      : `<span class="err">not synced (${esc(s.err ?? 'no checkout')})`}</div>
  </a>`).join('\n');
  const latestTask = db.prepare('SELECT status, created_at FROM tasks ORDER BY id DESC LIMIT 1').get();
  const runningN = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running')").get().n;
  const runN = runs.filter((r) => ['queued', 'waiting', 'pending', 'running'].includes(r.status)).length;
  return `<h1>home</h1>
<p class="meta">${runningN ? `<span class="running">${runningN} task${runningN > 1 ? 's' : ''} in flight</span> · ` : ''}${latestTask ? `last task ${esc(latestTask.status)} at ${esc(latestTask.created_at)}` : 'no tasks yet'}${runN ? ` · <span class="running">${runN} android build${runN > 1 ? 's' : ''} in flight</span>` : ''}</p>
<h2>latest tasks</h2><div class="list">${taskRows(5) || '<div class="item"><div class="l2">no tasks yet</div></div>'}</div>
<p><a href="/tasks">all tasks →</a></p>
<h2>latest android builds</h2><div class="list">${runs.length ? runRows(runs) : '<div class="item"><div class="l2">no android builds yet</div></div>'}</div>
<p><a href="/android">all builds →</a></p>
<h2>pages</h2><div class="list">${siteRows || '<div class="item"><div class="l2">no sites configured</div></div>'}</div>
<p><a href="/pages">pages →</a></p>
<script>glinkFix();document.querySelectorAll('a.plink').forEach(a=>a.href=location.protocol+'//'+location.hostname+':'+a.dataset.port);</script>`;
}

function taskPage(t) {
  const kids = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(t.id).map((k) => k.id);
  const chain = [
    (t.round ?? 1) > 1 ? `round ${t.round}` : '',
    t.parent_id ? `parent <a href="/task/${t.parent_id}">#${t.parent_id}</a>` : '',
    kids.length ? `spawned ${kids.map((k) => `<a href="/task/${k}">#${k}</a>`).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const head = `<a class="back" href="/tasks">← back to tasks</a>
<div class="pagehead"><h1>task ${t.id} <span class="${t.status}">${t.status}</span>${t.status === 'running' ? '<span class="live">live</span>' : ''}</h1></div>
<p class="meta">${esc(t.repo)}#${t.issue} · @${esc(t.agent)}${[t.model ? ` · <span class="model">${esc(t.model)}</span>` : '', ctxLine(t)].filter(Boolean).join('')} · ${esc(t.kind)} · created ${esc(t.created_at)}
 · started ${esc(t.started_at ?? '—')} · finished ${esc(t.finished_at ?? '—')}
${chain ? `<br>${chain}` : ''}
${t.error ? `<br><span class="err">${esc(t.error)}</span>` : ''}</p>`;
  if (t.status === 'running') {
    // live view: SSE streams the log line-by-line as the container prints it
    return `${head}<div class="console" id="log">(waiting for output…)</div>
<script>
const pre = document.getElementById('log');
let stick = true; // follow the bottom unless the user scrolls up
const nearBottom = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
pre.addEventListener('scroll', () => { stick = nearBottom(); });
const es = new EventSource('/task/${t.id}/stream');
// every (re)connect replays the whole log from the start — keep the DOM in
// lockstep by clearing on open, so a dropped+auto-reconnected stream can't
// duplicate lines
es.onopen = () => { pre.textContent = ''; };
es.onmessage = (e) => {
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
  return `${head}<div class="console">${esc(log)}</div>`;
}

async function reposPage() {
  // webhook is GLOBAL (is_system_webhook row, covers every repo) — no API for
  // it in Gitea 1.27, so check the same way seed.sh writes it: via psql
  let hookLine;
  try {
    const out = await execFileP('docker', ['exec', CFG.giteaDbContainer, 'psql', '-U', CFG.giteaDbUser, '-d', CFG.giteaDbName, '-tAc', "SELECT id FROM webhook WHERE is_system_webhook AND url LIKE '%:3001/webhook' LIMIT 1"], { timeout: 5000 });
    const id = out.trim(); // execFileP resolves the stdout string
    hookLine = id
      ? `<p>global webhook: <span class="hook ok">✓ id ${id} — fires for every repo, new ones included</span></p>`
      : `<p>global webhook: <span class="hook bad">✗ missing — run ./seed.sh</span></p>`;
  } catch { hookLine = `<p>global webhook: <span class="hook bad">✗ check failed (gitea-db unreachable?)</span></p>`; }
  const rows = (await Promise.all(managedRepos().map(async (r) => {
    const tot = db.prepare('SELECT COUNT(*) n FROM tasks WHERE repo=?').get(r).n;
    const ok = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='success'").get(r).n;
    const bad = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='failure'").get(r).n;
    const last = db.prepare('SELECT MAX(created_at) t FROM tasks WHERE repo=?').get(r).t;
    const added = db.prepare('SELECT added_at FROM managed_repos WHERE owner=? AND name=?').get(...r.split('/'))?.added_at;
    const auto = !CFG.repos.includes(r);
    return `<a class="item gl" data-repo="${esc(r)}" href="#">
    <div class="l1">${esc(r)} <span class="meta">${auto ? `auto · ${esc(added ?? '')}` : 'env'}</span>${auto ? ` <span class="del" data-repo="${esc(r)}" title="remove from managed repos">✕</span>` : ''}</div>
    <div class="l2">${tot} tasks (${ok} ok / ${bad} failed) · last activity: ${esc(last ?? '—')}</div>
  </a>`;
  }))).join('');
  return `<h1>managed repos</h1>${hookLine}
<div class="list">${rows}</div>
<p class="meta">repos self-enroll: mention <code>@pi</code> or <code>@opencode</code> on an issue in ANY repo — 00-tea persists it and grants the bot write access automatically. <code>AGENTD_REPOS</code> in .env pins repos (no ✕); the ✕ removes a self-enrolled repo (its bot collaborator grant stays in Gitea — remove it there too if you want it gone)</p>
<script>document.querySelectorAll('a.gl').forEach(a=>a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo);
document.querySelectorAll('span.del').forEach(s=>s.onclick=(e)=>{e.preventDefault();e.stopPropagation();
  if (!confirm('remove '+s.dataset.repo+' from managed repos?')) return;
  fetch('/api/repos/'+encodeURIComponent(s.dataset.repo),{method:'DELETE'}).then(()=>location.reload());
});</script>`;
}

function statsPage() {
  const total = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  if (!total) return `<h1>stats</h1><p class="meta">no tasks yet</p>`;
  const st = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) st[r.status] = r.n;
  const tok = db.prepare('SELECT COUNT(*) n, SUM(tokens) s, AVG(tokens) a, MAX(tokens) m FROM tasks WHERE tokens IS NOT NULL').get();
  const agents = db.prepare(
    `SELECT agent, COUNT(*) n, SUM(status='success') ok, SUM(tokens) tok, AVG(tokens) avgtok
     FROM tasks GROUP BY agent ORDER BY n DESC`).all();
  const models = db.prepare(
    `SELECT model, COUNT(*) n, SUM(tokens) tok, AVG(tokens) avgtok, MAX(model_ctx) ctx
     FROM tasks WHERE model IS NOT NULL GROUP BY model ORDER BY tok DESC`).all();
  const daily = db.prepare(
    `SELECT date(created_at) d, COUNT(*) n, SUM(status='success') ok, SUM(status='failure') bad, SUM(tokens) tok
     FROM tasks WHERE created_at >= datetime('now', '-13 days') GROUP BY d ORDER BY d DESC`).all();
  const maxDay = Math.max(1, ...daily.map((d) => d.n));
  const tk = (v) => (v == null ? '—' : fmtTok(Math.round(v)));

  return `<h1>stats</h1>
<p class="meta">${total} tasks · <span class="success">${st.success ?? 0} success</span> · <span class="failure">${st.failure ?? 0} failed</span>${st.running ? ` · <span class="running">${st.running} running</span>` : ''}${st.queued ? ` · <span class="queued">${st.queued} queued</span>` : ''}</p>
<h2>tokens</h2><div class="list"><div class="item">
  <div class="l1">${tk(tok.s)} total</div>
  <div class="l2">${tok.n} tasks measured · avg ${tk(tok.a)} · max ${tk(tok.m)} per task</div>
</div></div>
<h2>by model</h2><div class="list">${models.map((m) => `<div class="item">
  <div class="l1">${esc(m.model)} <span class="meta">${m.n} tasks${m.ctx ? ` · ctx ${fmtTok(m.ctx)}` : ''}</span></div>
  <div class="l2">${m.tok ? `${tk(m.tok)} tok · avg ${tk(m.avgtok)}` : 'no token data yet'}</div>
</div>`).join('') || '<div class="item"><div class="l2">no model data yet</div></div>'}</div>
<h2>by agent</h2><div class="list">${agents.map((a) => `<div class="item">
  <div class="l1">@${esc(a.agent)} <span class="meta">${a.n} tasks · ${a.ok ?? 0} ok</span></div>
  <div class="l2">${a.tok ? `${tk(a.tok)} tok · avg ${tk(a.avgtok)}` : 'no token data yet'}</div>
</div>`).join('')}</div>
<h2>last 14 days</h2><div class="list">${daily.map((d) => `<div class="item">
  <div class="l1">${esc(d.d)} <span class="meta">${d.n} tasks · ${d.ok ?? 0} ok${d.bad ? ` · <span class="err">${d.bad} failed</span>` : ''}${d.tok ? ` · ${tk(d.tok)} tok` : ''}</span></div>
  <div class="bar"><i style="width:${Math.round((d.n / maxDay) * 100)}%"></i></div>
</div>`).join('') || '<div class="item"><div class="l2">nothing in the last 14 days</div></div>'}</div>`;
}

async function backendsPage() {
  const agentRows = [
    { agent: 'pi', image: CFG.images.pi, note: 'model picked per task from the inference backend (below)' },
    { agent: 'opencode', image: CFG.images.opencode, note: 'model picked per task from the inference backend (below), overriding the baked config' },
    { agent: 'review', image: CFG.images.review, note: `read-only reviewer (opencode + code-review skill) — triggered after agent pushes, max ${CFG.reviewMaxRounds} rounds` },
  ];
  // inference backends — one local llama.cpp router for now; the list shape is
  // what a second endpoint on the network will slot into later
  const backends = [{ name: 'llama.cpp', url: CFG.llamaUrl, models: null, error: null }];
  for (const b of backends) {
    try { b.models = await llamaModels(); }
    catch (e) { b.error = e.message; }
  }
  const def = await piDefaultModel();

  const agents = `<h2>agents</h2><div class="list">${agentRows.map((a) => `<div class="item">
    <div class="l1">@${esc(a.agent)}</div>
    <div class="l2">image <code>${esc(a.image)}</code> · ${a.note}</div>
  </div>`).join('')}</div>
<p class="meta">every job runs one-shot in a gVisor (runsc) sandbox; 00-tea itself runs unsandboxed on the host</p>`;

  const provs = backends.map((b) => {
    const rows = b.models
      ? b.models.map((m) => `<div class="item">
        <div class="l1">${esc(m.id)}${m.id === def ? ' <span class="meta">★ pi default</span>' : ''} <span class="${m.loaded ? 'running' : 'queued'}">${m.loaded ? 'loaded' : 'idle'}</span></div>
        <div class="l2">ctx ${m.ctx ? fmtTok(m.ctx) : 'unknown'}</div>
      </div>`).join('')
      : `<div class="item"><div class="l2">unreachable: <span class="err">${esc(b.error)}</span></div></div>`;
    return `<p class="meta">${esc(b.name)} — <code>${esc(b.url)}</code></p><div class="list">${rows}</div>`;
  }).join('');

  return `<h1>backends</h1>${agents}
<h2>inference</h2>${provs}
<p class="meta">model selection for pi: baked default if it is loaded → else whichever model is loaded → else the default (lazy-load). one local llama.cpp endpoint for now; the backend list is shaped to accept another local endpoint on the network later.</p>`;
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
    req.on('end', async () => {
      if (!verifySignature(req, Buffer.from(body))) return send(403, 'text/plain', 'bad signature');
      let payload = {};
      try { payload = JSON.parse(body); } catch { return send(400, 'text/plain', 'bad json'); }
      const event = req.headers['x-gitea-event'] || '';
      const delivery = req.headers['x-gitea-delivery'] || '';
      const handled = await handleWebhook(event, delivery, payload);
      console.log(`[webhook] ${event} delivery=${delivery.slice(0, 8)} ${handled ? '→ enqueued' : '→ ignored'}`);
      send(200, 'text/plain', 'ok');
    });
    return;
  }

  // ── chat ──
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let agent = '';
      try { agent = JSON.parse(body).agent; } catch { /* empty body */ }
      try {
        const c = await createChat(agent);
        if (!c) return send(502, 'application/json', JSON.stringify({ error: 'agent container failed to start' }));
        send(200, 'application/json', JSON.stringify({ id: c.id }));
      } catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'GET') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    return send(200, 'application/json', JSON.stringify([...chats.values()].map(chatJson)));
  }
  // grant/revoke the "chat" user write access to a repo (collaborator API)
  if (url.pathname === '/api/chat/grant' && req.method === 'POST') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    if (!CFG.chatGiteaToken) return send(502, 'application/json', JSON.stringify({ error: 'CHAT_GITEA_TOKEN not configured' }));
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const { repo, grant } = JSON.parse(body);
        if (!/^[^/]+\/[^/]+$/.test(repo ?? '')) throw new Error('repo must be owner/name');
        const res = await fetch(`${CFG.giteaApi}/repos/${repo}/collaborators/${CFG.chatLogin}`, {
          method: grant ? 'PUT' : 'DELETE',
          headers: { Authorization: `token ${CFG.adminToken}`, 'content-type': 'application/json' },
          body: grant ? JSON.stringify({ role: 'write', permission: 'write' }) : undefined,
        });
        if (!res.ok) throw new Error(`collaborator API → ${res.status}`);
        if (grant) db.prepare('INSERT INTO chat_grants (repo) VALUES (?) ON CONFLICT(repo) DO UPDATE SET granted_at=datetime(\'now\')').run(repo);
        else db.prepare('DELETE FROM chat_grants WHERE repo=?').run(repo);
        console.log(`[chat] ${CFG.chatLogin} ${grant ? 'granted write on' : 'revoked from'} ${repo}`);
        send(200, 'application/json', '{"ok":true}');
      } catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  const chatMsgMatch = url.pathname.match(/^\/api\/chat\/(\d+)\/message$/);
  if (chatMsgMatch && req.method === 'POST') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        await chatMessage(+chatMsgMatch[1], JSON.parse(body).message);
        send(200, 'application/json', '{"ok":true}');
      } catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  const chatAbortMatch = url.pathname.match(/^\/api\/chat\/(\d+)\/abort$/);
  if (chatAbortMatch && req.method === 'POST') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    try { await chatAbort(+chatAbortMatch[1]); send(200, 'application/json', '{"ok":true}'); }
    catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
    return;
  }
  const chatItemMatch = url.pathname.match(/^\/api\/chat\/(\d+)$/);
  if (chatItemMatch) {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    const c = chats.get(+chatItemMatch[1]);
    if (!c) return send(404, 'application/json', '{}');
    if (req.method === 'DELETE') { chatKill(c, 'closed by user'); return send(200, 'application/json', '{"ok":true}'); }
    return send(200, 'application/json', JSON.stringify(chatJson(c)));
  }
  const chatStreamMatch = url.pathname.match(/^\/chat\/(\d+)\/stream$/);
  if (chatStreamMatch) {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    const c = chats.get(+chatStreamMatch[1]);
    if (!c) return send(404, 'text/plain', 'no such chat');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const line of c.lines) res.write(`data: ${line}\n\n`); // replay, then live
    c.clients.add(res);
    req.on('close', () => c.clients.delete(res));
    return;
  }
  const chatPageMatch = url.pathname.match(/^\/chat\/(\d+)$/);
  if (chatPageMatch) {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    const c = chats.get(+chatPageMatch[1]);
    if (!c) return send(404, 'text/plain', 'no such chat');
    return send(200, 'text/html', page(`chat ${c.id}`, chatView(c), { auto: false, nav: 'chat', app: true }));
  }
  if (url.pathname === '/chat') {
    if (!chatAuthed(req, url)) return send(401, 'text/plain', 'chat token required (CHAT_TOKEN)');
    return send(200, 'text/html', page('chat', await chatListPage(), { nav: 'chat' }));
  }

  if (url.pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, active, repos: managedRepos() }));
  if (url.pathname === '/api/tasks') {
    return send(200, 'application/json', JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 100').all()));
  }
  // remove a self-enrolled repo (env-listed ones are pinned — no-op → 404)
  const repoDelMatch = url.pathname.match(/^\/api\/repos\/(.+)$/);
  if (repoDelMatch && req.method === 'DELETE') {
    const [owner, name] = decodeURIComponent(repoDelMatch[1]).split('/');
    const res = db.prepare('DELETE FROM managed_repos WHERE owner=? AND name=?').run(owner, name);
    if (!res.changes) return send(404, 'application/json', JSON.stringify({ error: 'not self-enrolled (env-pinned or unknown)' }));
    console.log(`[repos] ${owner}/${name} removed from managed repos`);
    return send(200, 'application/json', '{"ok":true}');
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
    // SSE tail of the task log: emits each complete line as it hits the file.
    // off = bytes already sent; pend = bytes read but not yet flushed (the
    // pending partial line). The read MUST start at off+pend — starting at
    // `off` re-reads the pending bytes and concatenates them onto `tail`
    // again on every tick, garbling a long partial line (e.g. streamed
    // thinking) into growing-prefix duplicates.
    const logfile = path.join(CFG.dataDir, 'logs', `${t.id}.log`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const dec = new StringDecoder('utf8'); // never split a multi-byte char at a chunk edge
    let off = 0, pend = 0, tail = '';
    const tick = () => {
      try {
        const size = fs.statSync(logfile).size;
        if (size > off + pend) {
          const len = Math.min(size - off - pend, 1 << 20);
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(logfile, 'r');
          fs.readSync(fd, buf, 0, len, off + pend);
          fs.closeSync(fd);
          pend += len;
          const txt = tail + dec.write(buf);
          const end = txt.lastIndexOf('\n');
          if (end >= 0) {
            const complete = txt.slice(0, end + 1);
            for (const line of complete.split('\n').slice(0, -1)) res.write(`data: ${line.replace(/\r?$/, '')}\n\n`);
            const flushed = Buffer.byteLength(complete); // exact: only full chars in `complete`
            off += flushed;
            pend -= flushed;
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
  if (url.pathname === '/') return send(200, 'text/html', page('home', await homePage(), { nav: 'home' }));
  if (url.pathname === '/tasks') return send(200, 'text/html', page('tasks', tasksPage(), { nav: 'tasks' }));
  if (url.pathname === '/android') return send(200, 'text/html', page('android', await androidPage(), { nav: 'android' }));
  if (url.pathname === '/pages') return send(200, 'text/html', page('pages', await pagesPage(), { nav: 'pages' }));
  if (url.pathname === '/repos') return send(200, 'text/html', page('repos', await reposPage(), { nav: 'repos' }));
  if (url.pathname === '/stats') return send(200, 'text/html', page('stats', statsPage(), { nav: 'stats' }));
  if (url.pathname === '/backends') return send(200, 'text/html', page('backends', await backendsPage(), { nav: 'backends' }));
  send(404, 'text/plain', 'not found');
});

server.listen(CFG.port, () => {
  console.log(`[00-tea] listening on :${CFG.port}`);
  console.log(`[00-tea] repos (poll fallback): ${managedRepos().join(', ') || '(none)'} — new repos self-enroll on @agent mention`);
  console.log(`[00-tea] images: pi=${CFG.images.pi} opencode=${CFG.images.opencode} review=${CFG.images.review}`);
  console.log(`[00-tea] review chain: ${CFG.reviewToken ? `enabled (max ${CFG.reviewMaxRounds} rounds)` : 'DISABLED (no REVIEW_TOKEN)'}`);
  console.log(`[00-tea] webhook secret: ${CFG.secret ? 'set' : 'NOT SET (dev mode: signatures not verified)'}`);
  (async () => {
    try {
      const ms = await llamaModels();
      const loaded = ms.filter((m) => m.loaded).map((m) => m.id).join(', ') || 'none';
      console.log(`[llama] ${CFG.llamaUrl}: ${ms.map((m) => m.id).join(', ') || 'no models'} · loaded: ${loaded} · pi default: ${await piDefaultModel() ?? 'n/a'}`);
    } catch (e) { console.error(`[llama] ${e.message}`); }
  })();
});
