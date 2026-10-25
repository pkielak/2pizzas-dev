import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CFG } from './config.mjs';
import { db } from './db.mjs';
import { pickModel } from './inference.mjs';
import { liveBroadcast } from './live.mjs';

// ── chat sessions (long-lived sandboxed agent over RPC) ─────────────────────
// The /chat UI talks to a LIVE pi inside a long-lived runsc container —
// the counterpart of the one-shot task containers:
//
//   pi : docker run -i … agent-sandbox:pi pi --mode rpc --model …
//        JSONL over stdin/stdout (prompt / abort / followUp-while-busy)
//
// Both join the CHAT_NETWORK (00-tea's compose network) and are reached by
// container name — no host port publishing (a 127.0.0.1 publish is invisible
// to 00-tea, which is itself a container).
//
// 00-tea is a dumb bridge: browser SSE ⇄ agent stream, POST message ⇄ agent
// command. Chat containers get NO Gitea token — they chat and can read the
// 00-tea task API (via host.docker.internal), they cannot push or post.
// Sessions are in-memory (a 00-tea restart abandons them — orphaned
// tea-chat-* containers are reaped at startup, idle ones are killed after
// CHAT_IDLE_MINUTES) but every session is RECORDED in the chat_sessions
// table with its log file — the /chat page lists past sessions and
// /chat/<id> renders the full transcript of a dead one from its log.
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

// The chat gate: ?token= param, x-chat-token header, or the session cookie.
// A request that authenticates via param/header gets a 30-day HttpOnly
// cookie set, so the token only has to be typed into a URL ONCE — after
// that the bare /chat works (the browser keeps presenting the cookie,
// which EventSource/fetch/send all do automatically). HttpOnly keeps page
// JS from reading it; SameSite=Lax keeps it off cross-site requests.
export const CHAT_COOKIE = 'tea_chat_token';
export const chatAuthed = (req, url, res) => {
  if (!CFG.chatToken) return true;
  const cookie = (req.headers.cookie || '').split('; ').find((c) => c.startsWith(`${CHAT_COOKIE}=`));
  if (cookie && cookie.slice(CHAT_COOKIE.length + 1) === CFG.chatToken) return true;
  const ok = url.searchParams.get('token') === CFG.chatToken || req.headers['x-chat-token'] === CFG.chatToken;
  if (ok && res)
    res.setHeader('set-cookie', `${CHAT_COOKIE}=${CFG.chatToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
  return ok;
};

// transcript event: log file + replay buffer + all SSE clients
const chatSay = (c, ev) => {
  c.lastActive = Date.now();
  const line = typeof ev === 'string' ? ev : JSON.stringify(ev);
  c.lines.push(line);
  if (c.lines.length > 2000) c.lines.shift();
  try { fs.appendFileSync(c.logFile, line + '\n'); } catch { /* non-fatal */ }
  for (const res of [...c.clients]) {
    try { res.write(`data: ${line}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

// transient event: clients only (not logged, not replayed)
const chatLive = (c, ev) => {
  c.lastActive = Date.now();
  const line = typeof ev === 'string' ? ev : JSON.stringify(ev);
  for (const res of [...c.clients]) {
    try { res.write(`data: ${line}\n\n`); }
    catch { c.clients.delete(res); }
  }
};

// raw pi JSONL line → compact chat events (see the lane comment above).
// Everything not listed is noise: turn_start/end, message_start,
// tool_execution_update (full partial results), agent_end (full history),
// response success acks, thinking/toolcall start-end pairs.
const piLine = (c, raw) => {
  let e;
  try { e = JSON.parse(raw); } catch { return chatSay(c, raw); } // [00-tea]/[stderr] markers
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
      if (d.type === 'thinking_delta') return chatLive(c, { type: 'thinking' }); // status only — never log the thoughts
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
      return chatSay(c, { type: 'tool_call', name: e.toolName,
        arg: String(e.args && (e.args.command || JSON.stringify(e.args))).slice(0, 500) });
    case 'tool_execution_end': return chatLive(c, { type: 'tool_end' });
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
  liveBroadcast('chat');
};

export const chatJson = (c) => ({
  id: c.id, agent: c.agent, model: c.model, isStreaming: c.isStreaming,
  lastActive: c.lastActive, startedAt: c.startedAt,
});

// ── persisted session records (chat_sessions) ───────────────────────────────
// chatSeq ids restart at 1 on every 00-tea run, so a dead id resolves to the
// NEWEST row carrying it (an older run's session with the same id is
// shadowed — acceptable: ids are per-run by design)
export const chatSessionRow = (id) => db
  .prepare('SELECT * FROM chat_sessions WHERE id=? ORDER BY created_at DESC LIMIT 1').get(id);

export const chatSessions = (limit = 100) => db
  .prepare('SELECT * FROM chat_sessions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);

// true iff this persisted row belongs to a LIVE session: chatSeq ids restart
// at 1 per 00-tea run, so matching must compare created_at, not id alone
// (sqlite stores 'YYYY-MM-DD HH:MM:SS' UTC)
export const chatRowLive = (r) => {
  const live = chats.get(r.id);
  return !!live && new Date(live.startedAt).toISOString().replace('T', ' ').slice(0, 19) === r.created_at;
};

// transcript of a (dead) session from its log file: the log IS the
// server-authoritative transcript (chatSay writes every settled event)
export const chatHistory = (row) => {
  if (!row || !row.log_file) return [];
  let text = '';
  try { text = fs.readFileSync(row.log_file, 'utf8'); } catch { return []; }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { e = line; }
    lines.push(e);
  }
  return lines;
};

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

export async function createChat(agent) {
  if (agent !== 'pi') throw new Error(`unknown agent: ${agent}`);
  const modelSel = await pickModel();
  chatSeq++;
  const id = chatSeq;
  const c = {
    id, agent, model: modelSel ? `${modelSel.provider}/${modelSel.id}` : null,
    isStreaming: false, dead: false,
    clients: new Set(), lines: [],
    lastActive: Date.now(), startedAt: Date.now(),
    ctxUsed: 0, modelCtx: modelSel?.ctx ?? 0, // pi's get_session_stats refines both after the first turn
    logFile: '',
    child: null, name: '',
  };
  // unique per session (NOT just the id): chatSeq restarts at 1 on every
  // 00-tea restart, and a bare <id>.log would append new sessions onto
  // stale log files from previous runs
  const suffix = crypto.randomBytes(3).toString('hex');
  c.logFile = path.join(CFG.dataDir, 'chats', `${id}-${suffix}.log`);
  c.name = `tea-chat-${id}-${suffix}`;
  fs.mkdirSync(path.dirname(c.logFile), { recursive: true });
  chats.set(id, c);
  // rowid scopes later UPDATEs — chatSeq ids restart per run, so a bare
  // WHERE id=? would hit older rows sharing the same id
  c.rowid = db.prepare('INSERT INTO chat_sessions (id, agent, model, log_file) VALUES (?,?,?,?)')
    .run(id, agent, c.model, c.logFile).lastInsertRowid;
  // start marker in the transcript (replayed on reconnect, and the first
  // line of the saved history)
  chatSay(c, `[00-tea] chat started: @${agent}${c.model ? ` · model ${c.model}` : ''} · container ${c.name}`);

  // Gitea access for the chat agent: separate "chat" user (audit separation
  // from task work). Write still requires a per-repo collaborator grant.
  // host.docker.internal (not the compose service name): the runsc sandbox
  // can't reach Docker's built-in DNS, so name resolution must come from
  // /etc/hosts — same pattern the task containers use for GITEA_HOST
  const giteaEnv = CFG.chatGiteaToken
    ? ['-e', `GITEA_TOKEN=${CFG.chatGiteaToken}`, '-e', 'GITEA_URL=http://host.docker.internal:3000']
    : [];

  c.child = spawn('docker', [
    'run', '--rm', '-i',
    '--runtime=runsc',
    // caps on a long-lived, user-spawned container (inference is on the
    // host's llama.cpp — this is just node + git + light builds)
    '--memory', CFG.chatMemory,
    '--cpus', CFG.chatCpus,
    '--network', CFG.chatNetwork,
    '--add-host=host.docker.internal:host-gateway',
    '--name', c.name,
    ...giteaEnv,
    CFG.images.pi,
    'pi', '--mode', 'rpc',
    '--model', `${modelSel?.provider ?? 'none'}/${modelSel?.id ?? 'unknown'}`,
    '--append-system-prompt', CHAT_SYSTEM,
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

// reap chat containers orphaned by a previous 00-tea run (they are plain
// docker containers — they outlive the dispatcher that spawned them) AND
// close out their session rows (a kill-by-restart never ran chatKill, so
// their ended_at is still NULL)
execFile('docker', ['ps', '-aq', '--filter', 'name=tea-chat-', '--format', '{{.ID}}'],
  (err, out) => {
    if (err) return;
    for (const cid of out.trim().split('\n')) if (cid) execFile('docker', ['rm', '-f', cid]);
  });
db.prepare(`UPDATE chat_sessions SET ended_at=created_at, end_reason='00-tea restart' WHERE ended_at IS NULL`).run();

setInterval(() => {
  for (const c of [...chats.values()])
    // a streaming turn is never "idle": lastActive only moves on stream
    // events, so a long tool run with no output would otherwise SIGKILL a
    // live chat. isStreaming can't stick — pi always settles, and a dead
    // container kills the session via the close handler
    if (!c.isStreaming && Date.now() - c.lastActive > CFG.chatIdleMs) chatKill(c, 'idle timeout');
}, 60_000).unref?.();
