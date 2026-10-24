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
 * This file is the HTTP router only — the logic lives in sibling modules:
 *   config.mjs    env config, mention regexes, via:agent marker
 *   db.mjs        sqlite schema + task log helpers
 *   gitea.mjs     Gitea API client
 *   repos.mjs     managed repos (env seed ∪ self-enrolled) + enroll
 *   llama.mjs     model selection (llama.cpp router)
 *   theme.mjs     Gitea theme mirroring for the UI
 *   prompts.mjs   agent prompts (comment / review / agent-review / rework)
 *   queue.mjs     enqueue + internal review-chain tasks
 *   tasks.mjs     task runner (runsc job containers) + pump + afterTask
 *   webhook.mjs   Gitea webhook verification + handling
 *   poll.mjs      60s poll fallback (rescues lost webhooks)
 *   chat.mjs      long-lived chat sessions (pi RPC)
 *   ui/*.mjs      dashboard pages
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
 *   GET  /chat         agent chat — live sessions (pi RPC)
 *   GET  /chat/<id>    chat view (SSE stream)
 *   GET  /api/chat     active chat sessions
 *   POST /api/chat     start a chat session {agent: 'pi'}
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
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { CFG } from './config.mjs';
import { db, logPath } from './db.mjs';
import { managedRepos } from './repos.mjs';
import { llamaModels, piDefaultModel } from './llama.mjs';
import { verifySignature, handleWebhook } from './webhook.mjs';
import { giteaTheme } from './theme.mjs';
import { liveAdd, liveRemove } from './live.mjs';
import { chats, chatAuthed, chatJson, chatKill, createChat, chatMessage, chatAbort } from './chat.mjs';
import { page } from './ui/layout.mjs';
import { homePage } from './ui/home.mjs';
import { infraPage } from './ui/infra.mjs';
import { tasksPage, taskPage } from './ui/tasks.mjs';
import { chatListPage, chatView } from './ui/chat.mjs';
import { androidPage } from './ui/android.mjs';
import { pagesPage } from './ui/pages.mjs';
import { reposPage } from './ui/repos.mjs';
import { statsPage } from './ui/stats.mjs';
import { backendsPage } from './ui/backends.mjs';

// importing these for their side effects: pump interval, poll interval,
// theme discovery, chat orphan reaping + idle killer
import { activeCount } from './tasks.mjs';
import './poll.mjs';
import './live.mjs';

// page functions return either a body string or { html, script } — the
// script (window.__pageInit) is rendered OUTSIDE <main> so it survives the
// in-place live updates (see layout.mjs)
const renderPage = async (title, p, opts = {}) => {
  const r = await p;
  const b = typeof r === 'string' ? { html: r, script: '' } : r;
  return page(title, b.html, { ...opts, script: b.script ?? '' });
};

const server = http.createServer(async (req, res) => {
  // 401 for the chat gate — a usable hint instead of a bare text string
  const chat401 = () => send(401, 'text/html',
    `<!doctype html><html><head><meta charset="utf-8"><title>chat token required</title></head>
    <body style="font:14px system-ui;max-width:64ch;margin:4em auto;color:#333">
    <h2>chat is token-protected</h2>
    <p>Open <code>/chat?token=…</code> once (your <code>CHAT_TOKEN</code> from <code>.env</code>) —
    the response sets a 30-day session cookie and you won't need the <code>?token=</code> param again.</p>
    </body></html>`);

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
    if (!chatAuthed(req, url, res)) return chat401();
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 256 * 1024) { send(413, 'text/plain', 'body too large'); req.destroy(); } });
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
    if (!chatAuthed(req, url, res)) return chat401();
    return send(200, 'application/json', JSON.stringify([...chats.values()].map(chatJson)));
  }
  // grant/revoke the "chat" user write access to a repo (collaborator API)
  if (url.pathname === '/api/chat/grant' && req.method === 'POST') {
    if (!chatAuthed(req, url, res)) return chat401();
    if (!CFG.chatGiteaToken) return send(502, 'application/json', JSON.stringify({ error: 'CHAT_GITEA_TOKEN not configured' }));
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 256 * 1024) { send(413, 'text/plain', 'body too large'); req.destroy(); } });
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
    if (!chatAuthed(req, url, res)) return chat401();
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 256 * 1024) { send(413, 'text/plain', 'body too large'); req.destroy(); } });
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
    if (!chatAuthed(req, url, res)) return chat401();
    try { await chatAbort(+chatAbortMatch[1]); send(200, 'application/json', '{"ok":true}'); }
    catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
    return;
  }
  const chatItemMatch = url.pathname.match(/^\/api\/chat\/(\d+)$/);
  if (chatItemMatch) {
    if (!chatAuthed(req, url, res)) return chat401();
    const c = chats.get(+chatItemMatch[1]);
    if (!c) return send(404, 'application/json', '{}');
    if (req.method === 'DELETE') { chatKill(c, 'closed by user'); return send(200, 'application/json', '{"ok":true}'); }
    return send(200, 'application/json', JSON.stringify(chatJson(c)));
  }
  const chatStreamMatch = url.pathname.match(/^\/chat\/(\d+)\/stream$/);
  if (chatStreamMatch) {
    if (!chatAuthed(req, url, res)) return chat401();
    const c = chats.get(+chatStreamMatch[1]);
    if (!c) return send(404, 'text/plain', 'no such chat');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const line of c.lines) res.write(`data: ${line}\n\n`); // replay, then live
    c.clients.add(res);
    req.on('close', () => c.clients.delete(res));
    // chatKill may have run between chats.get() and the add above (it
    // clears the client set) — such a response would never be ended, so
    // end it ourselves (if the kill runs LATER, we are in its client set
    // and it ends us — the add/check is synchronous, so no gap)
    if (c.dead) { res.write('event: done\ndata: \n\n'); res.end(); }
    return;
  }
  const chatPageMatch = url.pathname.match(/^\/chat\/(\d+)$/);
  if (chatPageMatch) {
    if (!chatAuthed(req, url, res)) return chat401();
    const c = chats.get(+chatPageMatch[1]);
    if (!c) return send(404, 'text/plain', 'no such chat');
    return send(200, 'text/html', page(`chat ${c.id}`, chatView(c), { auto: false, nav: 'chat', app: true }));
  }
  if (url.pathname === '/chat') {
    if (!chatAuthed(req, url, res)) return chat401();
    return send(200, 'text/html', await renderPage('chat', chatListPage(), { nav: 'chat' }));
  }

  // live update feed for the dashboard: pages swap their <main> in place
  // on any event (see live.mjs) — replaces the old 3s full-page reload
  if (url.pathname === '/live/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('data: hello\n\n');
    liveAdd(res);
    req.on('close', () => liveRemove(res));
    return;
  }

  if (url.pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, active: activeCount(), repos: managedRepos() }));
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
    const logfile = logPath(t.id);
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
  if (url.pathname === '/') return send(200, 'text/html', await renderPage('home', homePage(), { nav: 'home' }));
  if (url.pathname === '/infra') return send(200, 'text/html', await renderPage('infra', infraPage(), { nav: 'infra' }));
  if (url.pathname === '/tasks') return send(200, 'text/html', await renderPage('tasks', tasksPage(), { nav: 'tasks' }));
  if (url.pathname === '/android') return send(200, 'text/html', await renderPage('android', androidPage(), { nav: 'android' }));
  if (url.pathname === '/pages') return send(200, 'text/html', await renderPage('pages', pagesPage(), { nav: 'pages' }));
  if (url.pathname === '/repos') return send(200, 'text/html', await renderPage('repos', reposPage(), { nav: 'repos' }));
  if (url.pathname === '/stats') return send(200, 'text/html', await renderPage('stats', statsPage(), { nav: 'stats' }));
  if (url.pathname === '/backends') return send(200, 'text/html', await renderPage('backends', backendsPage(), { nav: 'backends' }));
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
