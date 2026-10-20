import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CFG } from './config.mjs';
import { pickModel } from './llama.mjs';
import { liveBroadcast } from './live.mjs';

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

export const chats = new Map(); // id -> session
let chatSeq = 0;

export const chatAuthed = (req, url) =>
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

export const chatKill = (c, note) => {
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
  liveBroadcast('chat');
};

export const chatJson = (c) => ({
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

export async function createChat(agent) {
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
  liveBroadcast('chat');
  return c;
}

export async function chatMessage(id, message) {
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

export async function chatAbort(id) {
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
