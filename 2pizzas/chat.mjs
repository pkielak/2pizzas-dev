import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CFG, isHostLocal } from './config.mjs';
import { db } from './db.mjs';
import { execFileP } from './util.mjs';
import { apiGet } from './gitea.mjs';
import { pickModel } from './inference.mjs';
import { redact } from './redact.mjs';
import { liveBroadcast } from './live.mjs';

// ── chat sessions (long-lived sandboxed agent over RPC) ─────────────────────
// The /chat UI talks to a LIVE pi inside a long-lived runsc container —
// the counterpart of the one-shot task containers:
//
//   pi : docker run -i … agent-sandbox:pi pi --mode rpc --model …
//        JSONL over stdin/stdout (prompt / abort / followUp-while-busy)
//
// Both join the CHAT_NETWORK (2pizzas's compose network) and are reached by
// container name — no host port publishing (a 127.0.0.1 publish is invisible
// to 2pizzas, which is itself a container).
//
// 2pizzas is a dumb bridge: browser SSE ⇄ agent stream, POST message ⇄ agent
// command. Chat containers get NO Gitea token — they chat and can read the
// 2pizzas task API (via host.docker.internal), they cannot push or post.
// Every session is RECORDED in the chat_sessions table with its log file —
// the /chat page lists past sessions and /chat/<id> renders the full
// transcript of a dead one from its log.
//
// PERSISTENT CHAT (the pinned one): one session is flagged pinned in the db
// (chat_sessions.pinned) — it is EXEMPT from the idle killer and there is
// ALWAYS a live one: startup auto-creates it if none exists, and a failed
// start is retried with backoff (self-re-arming — never terminal).
// "Surviving a restart" is done by RESUME, not re-attach: the container runs WITHOUT
// --rm, but when 2pizzas restarts the `docker run` client dies, pi gets
// stdin EOF and exits — a "surviving" container is an empty shell. What
// survives is the CONVERSATION: pi's session state lives in the mounted
// session dir (a .jsonl that pi loads natively via --session, the same
// mechanism the "continue" button on a past session uses). Startup reaps
// the orphaned tea-chat-* containers, then re-creates the pinned chat with
// createChat('pi', <pinned rowid>, pin=true), which mounts the same session
// dir and passes the newest .jsonl — pi picks up the exact conversation.
//
// The raw pi JSONL is FILTERED (piLine) before it reaches the log, the
// replay buffer, and the SSE clients — unfiltered it was every text/
// thinking delta, tool partial results, and `agent_end` carrying the FULL
// message history (57MB logs, a replay buffer of noise, tens of MB pushed
// to every reconnecting client). Two lanes:
//   chatSay  — TRANSCRIPT events (settled conversation): log + replay buffer
//              + clients. The transcript is server-authoritative: a
//              (re)connect replays it and rebuilds the whole chat.
//   chatLive — TRANSIENT events (deltas, status): clients only — never
//              logged, never replayed.

export const chats = new Map(); // id -> session
let chatSeq = 0;
// consecutive persistent-chat start failures (container dies / fails to
// start immediately — no docker, missing image, …). Capped so a broken
// environment doesn't loop createChat forever; reset once a pinned chat
// has stayed up (see the idle-killer interval below) and re-armed after 5m
// of consecutive failures (see schedulePersistentStart)
let pinnedRespawns = 0;

// Bounded, self-re-arming start of the persistent (pinned) chat — shared by
// the startup auto-create and the crash-respawn path. A single transient
// createChat failure (e.g. pickModel() throwing "no backend reachable" while
// the router is down/reloading at boot) must NOT be terminal: the "there is
// ALWAYS a live one" invariant requires us to keep trying. The 3-attempt cap
// prevents a tight create→fail→retry loop in a broken environment (docker
// down, image missing); exhausting it RE-ARMS after 5 min (counter reset +
// retry) instead of giving up forever — a transient outage of ANY length is
// survived, only a permanently-broken environment needs a human.
const schedulePersistentStart = (parent, delayMs) => {
  // a live pinned chat already exists — nothing to start (also stops two
  // concurrent start/respawn paths from double-creating)
  for (const c of chats.values()) if (c.pinned && !c.dead) return;
  if (pinnedRespawns >= 3) {
    console.error(`[chat] persistent chat: ${pinnedRespawns} consecutive start failures — re-arming in 5m (check docker/images/backends)`);
    setTimeout(() => { pinnedRespawns = 0; schedulePersistentStart(parent, 5000); }, 5 * 60_000).unref?.();
    return;
  }
  pinnedRespawns++;
  setTimeout(async () => {
    try {
      const c = await createChat('pi', parent, true);
      console.log(`[chat] persistent chat ${c.id} ready (container ${c.name})${parent ? ` · resumed from r${parent}` : ''}`);
    } catch (e) {
      const nextDelay = Math.min(60_000, 2000 * 2 ** (pinnedRespawns - 1));
      console.error(`[chat] persistent chat start failed (attempt ${pinnedRespawns}/3): ${e.message} — retrying in ${nextDelay}ms`);
      schedulePersistentStart(parent, nextDelay);
    }
  }, delayMs).unref?.();
};

// find .jsonl session files in a pi session dir (host path). Returns
// relative paths (from the dir root) sorted newest-first. Pi organizes
// them as --<cwd>--/<timestamp>_<uuid>.jsonl
const findSessionFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort().reverse(); // newest timestamp first
};

// The chat gate: ?token= param, x-chat-token header, or the session cookie.
// A request that authenticates via param/header gets a 30-day HttpOnly
// cookie set, so the token only has to be typed into a URL ONCE — after
// that the bare /chat works (the browser keeps presenting the cookie,
// which EventSource/fetch/send all do automatically). HttpOnly keeps page
// JS from reading it; SameSite=Lax keeps it off cross-site requests.
export const CHAT_COOKIE = 'tea_chat_token';
// Accepts EITHER token (UI_TOKEN or CHAT_TOKEN) and BOTH session cookies —
// the whole-UI gate runs first, so a browser unlocked via the UI cookie
// passes the chat gate without re-entering anything.
export const chatAuthed = (req, url, res) => {
  const toks = [CFG.chatToken, CFG.uiToken].filter(Boolean);
  if (!toks.length) return true;
  if (isHostLocal(req)) return true; // SSH TUI / local curl — see config.mjs
  const cookies = (req.headers.cookie || '').split('; ');
  const c = cookies.find((x) => x.startsWith(`${CHAT_COOKIE}=`));
  if (c && toks.includes(c.slice(CHAT_COOKIE.length + 1))) return true;
  const u = cookies.find((x) => x.startsWith('tea_ui_token='));
  if (u && toks.includes(u.slice('tea_ui_token='.length))) return true;
  const v = url.searchParams.get('token') || req.headers['x-chat-token'] || req.headers['x-ui-token'];
  const ok = toks.includes(v);
  if (ok && res)
    res.setHeader('set-cookie', `${CHAT_COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
  return ok;
};

// transcript event: log file + replay buffer + all SSE clients
const chatSay = (c, ev) => {
  c.lastActive = Date.now();
  // redact(): chat agents echo secrets in tool calls too — scrub before the
  // line hits the log, the replay buffer, or a client
  const line = redact(typeof ev === 'string' ? ev : JSON.stringify(ev));
  c.lines.push(line);
  if (c.lines.length > 2000) c.lines.shift();
  try { fs.appendFileSync(c.logFile, line + '\n'); }
  catch (e) { chatSaveFailure(c, e.message); }
  for (const res of [...c.clients]) {
    try { res.write(`data: ${line}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

// the log IS the transcript — a failed save means the session will not be
// preserved. The user must see it IN THE CHAT WINDOW (a silently-failing log
// was the #1 cause of "empty" past sessions). Notify once per distinct
// error and record it on the session row so the ended-session page shows
// the same message. (Not via chatSay — that would write the log again and
// re-enter this handler.)
const chatSaveFailure = (c, msg) => {
  const note = `transcript save failed: ${msg}`;
  if (c.logErrorNote === note) return;
  c.logErrorNote = note;
  console.error(`[chat] ${c.logFile}: ${note}`);
  try { db.prepare('UPDATE chat_sessions SET log_error=? WHERE rowid=?').run(note, c.rowid); }
  catch { /* non-fatal */ }
  const errLine = JSON.stringify({ type: 'error',
    message: `${note} — this session will NOT be preserved after it ends` });
  c.lines.push(errLine);
  if (c.lines.length > 2000) c.lines.shift();
  for (const res of [...c.clients]) {
    try { res.write(`data: ${errLine}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

// transient event: clients only (not logged, not replayed)
const chatLive = (c, ev) => {
  c.lastActive = Date.now();
  const line = redact(typeof ev === 'string' ? ev : JSON.stringify(ev));
  for (const res of [...c.clients]) {
    try { res.write(`data: ${line}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

// The chat agent creates Gitea issues/PRs with curl (POST/--data); the
// API response carries the created object's html_url (…/issues/42,
// …/pulls/42). Detect a write whose output contains such a URL and turn
// it into a gitea_ref transcript event — the web UI and TUI render it as
// a link. Reads (GETs of existing issues) are deliberately ignored: only
// creations link.
const GITEA_REF_RE = /https?:\/\/[^\s"'<>\\]+?\/(issues|pulls)\/(\d+)/;
const giteaRefFromTool = (tool, e) => {
  if (!tool || tool.name !== 'bash' || e.isError) return null;
  const cmd = tool.command || '';
  if (!/\bcurl\b/.test(cmd)) return null;
  if (!/-X\s*(POST|PUT|PATCH)\b|(^|\s)(-d|-F|--data|--form)\b/.test(cmd)) return null;
  const r = e.result || {};
  const out = (typeof r.output === 'string' && r.output)
    || (Array.isArray(r.content) && r.content.map((p) => p.text || '').join(''))
    || '';
  const m = GITEA_REF_RE.exec(out);
  return m ? { type: 'gitea_ref', kind: m[1] === 'pulls' ? 'pr' : 'issue', number: +m[2], url: m[0] } : null;
};

// raw pi JSONL line → compact chat events (see the lane comment above).
// Everything not listed is noise: turn_start/end, message_start,
// tool_execution_update (full partial results), agent_end (full history),
// response success acks, thinking/toolcall start-end pairs.
const piLine = (c, raw) => {
  let e;
  try { e = JSON.parse(raw); } catch { return chatSay(c, raw); } // [2pizzas]/[stderr] markers
  switch (e.type) {
    case 'agent_start': c.isStreaming = true; return chatLive(c, { type: 'working' });
    case 'agent_settled':
      c.isStreaming = false;
      chatSay(c, { type: 'settle' });
      // refresh the ctx-usage display from pi (its own context-window
      // estimate — the same number pi uses for compaction decisions)
      c.child.stdin.write(JSON.stringify({ type: 'get_session_stats' }) + '\n');
      return;
    // compaction (long-chat context management): live status while it runs,
    // a transcript marker when done (replayed on reconnect). pi continues
    // the turn itself (see the set_auto_compaction note in createChat);
    // agent_settled follows
    case 'compaction_start': return chatLive(c, { type: 'compaction', phase: 'start', reason: e.reason });
    case 'compaction_end':
      if (e.errorMessage) return chatSay(c, { type: 'error', message: `compaction failed: ${e.errorMessage}` });
      return chatSay(c, { type: 'compacted', reason: e.reason });
    case 'message_update': {
      const d = e.assistantMessageEvent || {};
      if (d.type === 'text_delta') return chatLive(c, { type: 'text_delta', delta: d.delta });
      // thinking text rides the TRANSIENT lane (clients only — never logged,
      // never replayed): live clients accumulate it in a collapsible block
      if (d.type === 'thinking_delta') return chatLive(c, { type: 'thinking_delta', delta: d.delta });
      return;
    }
    case 'message_end': {
      // the assistant block is settled — all its text parts concatenated
      // (live clients finalize their delta-built block with the exact text,
      // replay clients get the block whole)
      const m = e.message || {};
      if (m.role !== 'assistant') return; // user echo, toolResult
      const text = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (text.trim()) chatSay(c, { type: 'text_block', text });
      return;
    }
    case 'tool_execution_start':
      // remember the FULL command (the tool_call event only keeps 500 chars):
      // giteaRefFromTool() needs the flags even when the payload is long
      c.lastTool = { name: e.toolName, command: e.args && e.args.command ? String(e.args.command) : '' };
      return chatSay(c, { type: 'tool_call', name: e.toolName,
        arg: String(e.args && (e.args.command || JSON.stringify(e.args))).slice(0, 500) });
    case 'tool_execution_end': {
      const ref = giteaRefFromTool(c.lastTool, e);
      c.lastTool = null;
      if (ref) chatSay(c, ref); // transcript lane — persisted + replayed, both UIs link it
      return chatLive(c, { type: 'tool_end' });
    }
    case 'auto_retry_start': return chatLive(c, { type: 'auto_retry', attempt: e.attempt, max: e.maxAttempts });
    case 'response':
      if (e.command === 'get_session_stats') {
        const cu = e.data && e.data.contextUsage;
        if (cu && cu.tokens != null) { // null right after compaction — next turn refreshes
          c.ctxUsed = cu.tokens;
          if (cu.contextWindow) c.modelCtx = cu.contextWindow;
          db.prepare('UPDATE chat_sessions SET tokens=? WHERE rowid=?').run(c.ctxUsed, c.rowid);
          chatLive(c, { type: 'ctx', tokens: c.ctxUsed, window: c.modelCtx });
        }
        return;
      }
      if (e.success === false) chatSay(c, { type: 'error', message: e.error || 'command failed' });
      return;
    default: return;
  }
};

export const chatKill = (c, note) => {
  if (c.dead) return;
  c.dead = true;
  db.prepare('UPDATE chat_sessions SET ended_at=datetime(\'now\'), end_reason=? WHERE rowid=? AND ended_at IS NULL')
    .run(note || 'ended', c.rowid);
  // a pinned (persistent) chat that dies on its own (container exited, failed
  // to start) is respawned a moment later, resuming from its own session dir
  // (pi loads the .jsonl natively). A user-initiated close is honored as-is —
  // the next 2pizzas startup auto-creates the persistent chat again
  if (c.pinned && note !== 'closed by user') {
    // a pinned chat that dies on its own is respawned (bounded-retry with
    // backoff, self-re-arming — see schedulePersistentStart); a
    // user-initiated close is honored as-is
    const parent = findSessionFiles(c.sessionDir).length ? c.rowid : null;
    schedulePersistentStart(parent, 1500);
  }
  // killing the `docker run` client does NOT remove the container — rm it by name
  // (docker 29 no longer prints the container id on `docker run`)
  try { c.child.kill('SIGKILL'); } catch { /* already gone */ }
  if (c.name) execFile('docker', ['rm', '-f', c.name], () => { /* gone */ });
  if (note) chatSay(c, `[2pizzas] chat closed: ${note}`);
  for (const res of [...c.clients]) {
    try { res.write('event: done\ndata: \n\n'); res.end(); } catch { /* gone */ }
  }
  c.clients.clear();
  chats.delete(c.id);
  console.log(`[chat] ${c.id} (@${c.agent}) closed${note ? `: ${note}` : ''}`);
  liveBroadcast('chat');
};

export const chatJson = (c) => ({
  id: c.id, agent: c.agent, model: c.model, isStreaming: c.isStreaming,
  lastActive: c.lastActive, startedAt: c.startedAt, modelCtx: c.modelCtx,
  pinned: !!c.pinned,
});

// the persistent (pinned) chat — the always-on session the sidebar widget
// and the mobile sheet connect to (auto-created at startup, resumed across
// restarts). `live` is false in the brief window before startup's auto-
// create finishes (or if it failed) — clients poll until it is live.
export const persistentChat = () => {
  const row = db.prepare('SELECT *, rowid FROM chat_sessions WHERE pinned=1 ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
  if (!row) return null;
  const live = chatRowLive(row) ? chats.get(row.id) : null;
  return { id: row.id, rowid: row.rowid, agent: row.agent, model: row.model,
    live: !!live, isStreaming: live ? live.isStreaming : false, created_at: row.created_at };
};

// data for the SPA chat list's grant section: every repo on the instance
// with the chat user's recorded grants. Drift cleanup: chat_grants is our
// OWN record — a human can revoke the collaborator in Gitea directly,
// leaving a stale "write since" row. Verify each recorded grant against the
// real permission (204 = yes, 404 = no) and drop the stale ones; a Gitea
// blip (error) never drops a row.
export async function chatRepos() {
  if (!CFG.chatGiteaToken) return { hasToken: false, repos: [], grants: {}, idleMin: CFG.chatIdleMs / 60000 };
  const grants = Object.fromEntries(
    db.prepare('SELECT repo, granted_at FROM chat_grants').all().map((g) => [g.repo, g.granted_at]));
  for (const repo of [...Object.keys(grants)]) {
    let state; // 'yes' | 'no' | 'unknown'
    try {
      state = (await apiGet(`/repos/${repo}/collaborators/${CFG.chatLogin}`, { token: CFG.chatGiteaToken, ok404: true })) !== null ? 'yes' : 'no';
    } catch { state = 'unknown'; } // Gitea blip — never drop a row on an error
    if (state === 'no') {
      db.prepare('DELETE FROM chat_grants WHERE repo=?').run(repo);
      delete grants[repo];
    }
  }
  let repos = [], repoError = null;
  try {
    // /admin/repos does not exist in Gitea 1.27 — search covers all repos
    // the admin token can see (private included). No total_count in the
    // response, so paginate until a short page (was a blind limit=250)
    for (let page = 1; ; page++) {
      const rs = await apiGet(`/repos/search?limit=50&page=${page}`, { token: CFG.adminToken });
      const batch = (rs.data ?? []).map((r) => r.full_name);
      repos.push(...batch);
      if (batch.length < 50) break;
    }
    repos.sort();
  } catch (e) { repoError = e.message; }
  return { hasToken: true, chatLogin: CFG.chatLogin, repos, grants, repoError, idleMin: CFG.chatIdleMs / 60000 };
}

// ── persisted session records (chat_sessions) ───────────────────────────────
// chatSeq ids restart at 1 on every 2pizzas run, so a dead id resolves to the
// NEWEST row carrying it (an older run's session with the same id is
// shadowed — acceptable: ids are per-run by design)
export const chatSessionRow = (id) => db
  .prepare('SELECT * FROM chat_sessions WHERE id=? ORDER BY created_at DESC LIMIT 1').get(id);

// rowid is the only globally-unique session key — chatSeq ids restart per
// run, so past-session links must carry it (an id link shadows older rows)
export const chatSessionByRowid = (rowid) => db
  .prepare('SELECT *, rowid FROM chat_sessions WHERE rowid=?').get(rowid);

export const chatSessions = (limit = 100) => db
  .prepare('SELECT *, rowid FROM chat_sessions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);

// true iff this persisted row belongs to a LIVE session: chatSeq ids restart
// at 1 per 2pizzas run, so matching must compare created_at, not id alone
// (sqlite stores 'YYYY-MM-DD HH:MM:SS' UTC)
export const chatRowLive = (r) => {
  const live = chats.get(r.id);
  return !!live && new Date(live.startedAt).toISOString().replace('T', ' ').slice(0, 19) === r.created_at;
};

// transcript of a (dead) session from its log file: the log IS the
// server-authoritative transcript (chatSay writes every settled event).
// Lines are returned RAW (the exact log strings) — the clients parse them
// (the web parseLine() and the TUI chatLine() both JSON.parse per line,
// same as the SSE stream path). Returning pre-parsed objects here broke
// the web transcript: parseLine() does JSON.parse(line) on an object,
// which coerces to "[object Object]", throws, and drops EVERY json event
// (user_message/text_block/tool_call/…) — the past-session page rendered
// only the plain [2pizzas] marker lines and looked empty (issue #21).
export const chatHistory = (row) => {
  if (!row || !row.log_file) return { lines: [], logMissing: true, logError: 'no log file recorded for this session' };
  let text = '';
  try { text = fs.readFileSync(row.log_file, 'utf8'); }
  catch (e) { console.warn(`[chat] log file missing: ${row.log_file}: ${e.message}`); return { lines: [], logMissing: true, logError: row.log_error || 'log file missing' }; }
  const lines = [];
  for (const line of text.split('\n')) if (line.trim()) lines.push(line);
  // a session that had traffic but an empty log was NEVER saved — say so in
  // the window instead of "empty session" (covers rows from before the
  // log_error column existed)
  if (!lines.length && (row.log_error || (row.messages || 0) > 0))
    return { lines, logMissing: true,
      logError: row.log_error || `log file is empty although the session had ${row.messages} message${row.messages === 1 ? '' : 's'} — saving failed` };
  return { lines, logMissing: false, logError: row.log_error || false };
};

// The chat agent's extra context: it acts as a SUPERVISOR that delegates work
// to the coding agents (pi, opencode) by creating issues/PRs and
// commenting @agent on them. The existing 2pizzas pipeline (webhook → task
// → agent run → review chain) handles everything after the mention.
// The Gitea section is only present when CHAT_GITEA_TOKEN is configured —
// with it, the agent acts as the separate "chat" user (see createChat env)
const CHAT_SYSTEM = `You are a SUPERVISOR agent inside a disposable sandbox (bash + file tools, empty workspace /work).
Your job is to COORDINATE work by delegating to coding agents — NOT to write code yourself.

## How you delegate work
1. Create an issue (or PR) in the target repo with a clear title and description
   of what needs to be done.
2. Add a COMMENT on that issue/PR mentioning the appropriate agent:
   - @${CFG.agents.pi.login} — general coding tasks, bug fixes, features
   - @${CFG.agents.opencode.login} — alternative coding agent (use if @${CFG.agents.pi.login} is unavailable or for a second opinion)

The agent will pick up the comment, do the work, push commits, and a review
chain runs automatically. You do NOT need to write code, push branches, or
manage the implementation.

## Monitoring
You can read the 2pizzas dispatcher state (which tracks all agent tasks):
  curl -s http://host.docker.internal:3001/api/tasks | jq '.[0:5]'
Use this to check task status (running, success, failure), see which agent is
working, and report progress back to the user.

## What you should NOT do
- Do NOT clone repos and write code yourself — delegate that to the agents.
- Do NOT push commits or create PRs with code changes — create issues and
  delegate instead.
- You MAY read repos (clone --depth 1) to gather context for writing better
  issue descriptions, but do not modify anything.
${CFG.chatGiteaToken ? `
## Gitea access
You act as user "${CFG.chatLogin}" (token: $GITEA_TOKEN, API: $GITEA_URL).
You have full issue/PR/comment access via the Gitea REST API (curl):
  - Create issues: POST /repos/OWNER/REPO/issues
  - Create PRs:    POST /repos/OWNER/REPO/pulls
  - Comment:       POST /repos/OWNER/REPO/issues/N/comments
  - Read:          GET /repos/OWNER/REPO/issues, /pulls, /contents, etc.
Your primary tool is creating an ISSUE with a clear description, then
commenting @agent on it to delegate. You can also create a PR when you want
to propose a specific change direction.
You can READ any repo you can see. You can only WRITE in repos where you
have been granted collaborator access — if an API call fails with 403
"permission denied", say so and stop trying other paths.` : ' You have no write access to Gitea — you can only observe task state.'}`;

// pin = this is the PERSISTENT chat (exempt from the idle killer; exactly
// one row is pinned at a time — pinning a new one unpins the previous).
export async function createChat(agent, resumeFromRowid, pin = false) {
  if (agent !== 'pi') throw new Error(`unknown agent: ${agent}`);
  const modelSel = await pickModel();
  chatSeq++;
  const id = chatSeq;
  const c = {
    id, agent, model: modelSel ? `${modelSel.provider}/${modelSel.id}` : null,
    isStreaming: false, dead: false, pinned: pin,
    clients: new Set(), lines: [],
    lastActive: Date.now(), startedAt: Date.now(),
    ctxUsed: 0, modelCtx: modelSel?.ctx ?? 0, // pi's get_session_stats refines both after the first turn
    logFile: '',
    child: null, name: '',
    sessionDir: '', // persistent pi session state (mounted into the container)
  };
  // unique per session (NOT just the id): chatSeq restarts at 1 on every
  // 2pizzas restart, and a bare <id>.log would append new sessions onto
  // stale log files from previous runs
  const suffix = crypto.randomBytes(3).toString('hex');
  c.logFile = path.join(CFG.dataDir, 'chats', `${id}-${suffix}.log`);
  c.name = `tea-chat-${id}-${suffix}`;
  // persistent session directory (pi's session files survive container death)
  c.sessionDir = path.join(CFG.dataDir, 'chat-sessions', `${id}-${suffix}`);
  // session resume: if resuming from a previous session, reuse its session
  // dir and find the .jsonl to pass to pi (pi loads the full conversation
  // state natively — compaction, tokens, tool results, tree)
  let sessionArg = [];
  if (resumeFromRowid) {
    const oldRow = chatSessionByRowid(resumeFromRowid);
    if (oldRow?.session_dir) {
      const sessFiles = findSessionFiles(oldRow.session_dir);
      if (sessFiles.length) {
        c.sessionDir = oldRow.session_dir; // mount the same dir (rw)
        sessionArg = ['--session', `/root/.pi/agent/sessions/${sessFiles[0]}`];
      }
    }
  }
  fs.mkdirSync(c.sessionDir, { recursive: true });
  const logDir = path.dirname(c.logFile);
  fs.mkdirSync(logDir, { recursive: true });
  // verify the log dir is writable (silent appendFileSync failures are the #1
  // cause of "empty session" transcripts — make it visible at startup)
  const testFile = path.join(logDir, '.write-test');
  try {
    fs.writeFileSync(testFile, '');
  } catch (e) {
    console.error(`[chat] log directory not writable: ${logDir}: ${e.message}`);
  } finally {
    try { fs.unlinkSync(testFile); } catch { /* best-effort cleanup */ }
  }
  chats.set(id, c);
  // rowid scopes later UPDATEs — chatSeq ids restart per run, so a bare
  // WHERE id=? would hit older rows sharing the same id
  const parentSession = resumeFromRowid || null;
  c.rowid = db.prepare('INSERT INTO chat_sessions (id, agent, model, log_file, session_dir, parent_session, pinned) VALUES (?,?,?,?,?,?,?)')
    .run(id, agent, c.model, c.logFile, c.sessionDir, parentSession, pin ? 1 : 0).lastInsertRowid;
  if (pin) db.prepare('UPDATE chat_sessions SET pinned=0 WHERE pinned=1 AND rowid!=?').run(c.rowid);
  // start marker in the transcript (replayed on reconnect, and the first
  // line of the saved history)
  chatSay(c, `[2pizzas] chat started: @${agent}${c.model ? ` · model ${c.model}` : ''} · container ${c.name}${parentSession ? ` · resumed from r${parentSession}` : ''}${sessionArg.length ? ` · pi session ${sessionArg[1].split('/').pop()}` : ''}`);

  // Gitea access for the chat agent: separate "chat" user (audit separation
  // from task work). Write still requires a per-repo collaborator grant.
  // the tailnet IP (not the compose service name — the runsc sandbox can't
  // use Docker's built-in DNS — and NOT host.docker.internal: neither Gitea
  // nor 2pizzas is bound to the host-gateway, both are bound to the tailnet IP)
  const giteaEnv = CFG.chatGiteaToken
    ? ['-e', `GITEA_TOKEN=${CFG.chatGiteaToken}`, '-e', `GITEA_URL=http://${CFG.giteaHost}`]
    : [];

  // the HOST-side source of the session-dir bind mount. 2pizzas talks to
  // the host docker daemon (from inside a container), which resolves `-v`
  // sources as HOST paths — c.sessionDir is a container path (/data/… =
  // host ./data-2pizzas/…), so mounting it directly would make the daemon
  // auto-create an empty host /data/chat-sessions/… and pi's .jsonl would
  // land there while findSessionFiles() reads the (empty) container path —
  // session resume would silently never work. Map through DATA_HOST_DIR.
  let sessionMountSrc = c.sessionDir;
  if (CFG.dataHostDir) {
    sessionMountSrc = path.join(CFG.dataHostDir, path.relative(CFG.dataDir, c.sessionDir));
  } else {
    console.error(`[chat] DATA_HOST_DIR unset — session-dir bind mount (${c.sessionDir}) resolves as a HOST path; session resume will not work (set it in .env via ./setup.sh)`);
  }

  c.child = spawn('docker', [
    // no --rm: the container outlives the `docker run` client (a 2pizzas
    // restart). pi dies with the closed stdin — what survives is the
    // mounted session dir, which startup resumes into a fresh container
    // (see the persistent-chat note at the top of this file)
    'run', '-i',
    '--runtime=runsc',
    // caps on a long-lived, user-spawned container (inference is on the
    // host's llama.cpp — this is just node + git + light builds)
    '--memory', CFG.chatMemory,
    '--cpus', CFG.chatCpus,
    '--network', CFG.chatNetwork,
    '--add-host=host.docker.internal:host-gateway',
    '--name', c.name,
    // persistent pi session state (survives container death → resumable)
    '-v', `${sessionMountSrc}:/root/.pi/agent/sessions`,
    ...giteaEnv,
    CFG.images.pi,
    'pi', '--mode', 'rpc',
    '--model', `${modelSel?.provider ?? 'none'}/${modelSel?.id ?? 'unknown'}`,
    '--append-system-prompt', CHAT_SYSTEM,
    ...sessionArg,
  ]);

  // auto-compaction ON for this long-lived session (the image bakes it off —
  // for one-shot task runs a post-run summarization is pure downside). pi
  // handles the continuation itself: past the threshold (window − 16K)
  // _checkCompaction() compacts and the _runAgentPrompt loop calls
  // agent.continue(); an overflow mid-turn is compacted and auto-retried.
  // All of it happens BEFORE agent_settled, so no re-prompting is needed
  // here — the stream just carries compaction_start/end through it
  c.child.stdin.write(JSON.stringify({ type: 'set_auto_compaction', enabled: true }) + '\n');
  const dec = new StringDecoder('utf8');
  let buf = '';
  c.child.stdout.on('data', (d) => {
    buf += dec.write(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { // LF-only framing (U+2028/2029 are valid in JSON strings)
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      piLine(c, line);
    }
  });
  c.child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) chatSay(c, `[stderr] ${s}`);
  });
  c.child.stdin.on('error', () => { /* EPIPE — the container is already gone */ });
  // a spawn failure (docker down, image missing) emits 'error' — without a
  // handler it would CRASH the whole dispatcher (uncaught 'error' event)
  c.child.on('error', (e) => chatKill(c, `container failed to start: ${e.message}`));
  c.child.on('close', () => chatKill(c, 'container exited'));
  console.log(`[chat] ${id} started (@${agent}, model ${c.model}, container ${c.name})`);
  liveBroadcast('chat');
  return c;
}

export function chatMessage(id, message) {
  const c = chats.get(id);
  if (!c || c.dead) throw new Error('no such chat');
  message = String(message ?? '').trim();
  if (!message) throw new Error('empty message');
  message = message.slice(0, 20000);
  c.lastActive = Date.now();
  db.prepare('UPDATE chat_sessions SET messages = messages + 1 WHERE rowid=?').run(c.rowid);
  // echo the user message into the stream: the transcript is SERVER-
  // authoritative, so a reconnect/reload replays the whole conversation
  // (user bubbles included) instead of only the agent side
  chatSay(c, JSON.stringify({ type: 'user_message', message }));
  const cmd = { type: 'prompt', message };
  if (c.isStreaming) cmd.streamingBehavior = 'followUp'; // deliver once the agent stops
  c.child.stdin.write(JSON.stringify(cmd) + '\n');
}

export function chatAbort(id) {
  const c = chats.get(id);
  if (!c || c.dead) return;
  c.child.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
}

// ── startup: the persistent (pinned) chat ──────────────────────────────────
// Orphaned tea-chat-* containers are reaped (their pi already died with the
// old `docker run` client — stdin EOF — so there is nothing to re-attach),
// the previous run's session rows are closed out (a kill-by-restart never
// ran chatKill, so their ended_at is still NULL), and a pinned chat is
// created: RESUMED from the previous pinned row's session dir when it has
// a .jsonl (pi loads the exact conversation natively), fresh otherwise.
// A failed start is retried with backoff (self-re-arming — never terminal;
// see schedulePersistentStart).
(async () => {
  try {
    const out = await execFileP('docker', ['ps', '-aq', '--filter', 'name=tea-chat-', '--format', '{{.ID}}'], { timeout: 15000 });
    for (const cid of out.trim().split('\n')) if (cid) execFile('docker', ['rm', '-f', cid], () => { /* gone */ });
  } catch { /* docker unreachable — nothing to reap */ }
  // read the pinned row BEFORE the close-out UPDATE below ends it
  const pinnedRow = db.prepare('SELECT *, rowid FROM chat_sessions WHERE pinned=1 ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
  db.prepare(`UPDATE chat_sessions SET ended_at=COALESCE(ended_at, created_at), end_reason='2pizzas restart' WHERE ended_at IS NULL`).run();
  let parent = null;
  if (pinnedRow?.session_dir && findSessionFiles(pinnedRow.session_dir).length) parent = pinnedRow.rowid;
  // bounded-retry start (self-re-arming) — a transient backend/docker
  // failure at boot is NOT terminal (see schedulePersistentStart)
  schedulePersistentStart(parent, 0);
})();

setInterval(() => {
  for (const c of [...chats.values()]) {
    // a pinned chat that has stayed up for a while was a SUCCESSFUL start —
    // clear the consecutive-failure counter so a later crash can respawn
    if (c.pinned && Date.now() - c.startedAt > 5 * 60_000) pinnedRespawns = 0;
    // the pinned (persistent) chat is never idle-killed — it is the
    // always-on chat the webui sidebar/sheet connects to
    // a streaming turn is never "idle": lastActive only moves on stream
    // events, so a long tool run with no output would otherwise SIGKILL a
    // live chat. isStreaming can't stick — pi always settles, and a dead
    // container kills the session via the close handler
    if (!c.isStreaming && !c.pinned && Date.now() - c.lastActive > CFG.chatIdleMs) chatKill(c, 'idle timeout');
  }
}, 60_000).unref?.();
