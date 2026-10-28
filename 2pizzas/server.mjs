#!/usr/bin/env node
/**
 * 2pizzas — webhook-driven agent dispatcher.
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
 *   Internal tasks (agent-review/rework) are enqueued by 2pizzas itself, never
 *   via the webhook (the reviewer's comment carries the via:agent marker).
 *
 * This file is the HTTP router only — the logic lives in sibling modules:
 *   config.mjs    env config, mention regexes, via:agent marker
 *   db.mjs        sqlite schema + task log helpers
 *   gitea.mjs     Gitea API client
 *   repos.mjs     managed repos (env seed ∪ self-enrolled) + enroll
 *   inference.mjs backend registry + model selection (inference.json)
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
 *   POST   /api/backends              add backend {id,url,apiKey,defaultModel}
 *   PATCH  /api/backends/:id          update fields
 *   POST   /api/backends/:id/up|down  reorder priority
 *   DELETE /api/backends/:id          remove (last one is protected)
 *   GET  /api/backends/baked          provider ids baked into the agent images
 *   GET  /chat         agent chat — live sessions (pi RPC)
 *   GET  /chat/<id>    chat view (SSE stream)
 *   GET  /api/chat     active chat sessions
 *   GET  /api/chat/sessions   all sessions (live + past, from chat_sessions)
 *   POST /api/chat     start a chat session {agent: 'pi'}
 *   GET  /api/chat/<id>/history   transcript of a dead session
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
import { readRegistry, backendModels, piDefaultModel, bakedProviderIds, addBackend, updateBackend, deleteBackend, moveBackend, probeBackend } from './inference.mjs';
import { verifySignature, handleWebhook } from './webhook.mjs';
import { giteaTheme } from './theme.mjs';
import { liveAdd, liveRemove } from './live.mjs';
import { chats, chatAuthed, chatJson, chatKill, createChat, chatMessage, chatAbort, CHAT_COOKIE, chatSessions, chatSessionRow, chatHistory, chatRowLive } from './chat.mjs';
import { page } from './ui/layout.mjs';
import { homePage } from './ui/home.mjs';
import { infraPage } from './ui/infra.mjs';
import { tasksPage, taskPage } from './ui/tasks.mjs';
import { chatListPage, chatView, chatHistoryView } from './ui/chat.mjs';
import { settingsPage } from './ui/settings.mjs';
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
  // 401 for the chat gate — an UNLOCK form: the first chat use prompts for
  // the token, stores it in localStorage (this browser only), and retries
  // with ?token=… which sets the 30-day session cookie. If a token was
  // JUST rejected (it's in the URL), don't auto-redirect with the saved
  // one — that would 401→redirect→401 loop; show the form for a correction
  const chat401 = () => {
    // theme-aware like the rest of the UI: Gitea theme CSS + --color-* vars
    // with dark fallbacks (degrades gracefully if Gitea is down)
    const th = giteaTheme();
    return send(401, 'text/html',
    `<!doctype html><html data-theme="${th.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>chat token required — 2pizzas</title>
    <link rel="stylesheet" href="/assets/gitea-theme.css">
    <style>body{font:14px/1.6 -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--color-body,#111);color:var(--color-text,#ddd);max-width:60ch;margin:4em auto;padding:0 16px}
    h2{font-size:20px;font-weight:700;letter-spacing:-.01em}
    a{color:var(--color-primary-light-2,#7ab)}
    input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;margin:12px 0;font-size:14px;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:8px;color:var(--color-input-text,#ddd)}
    input[type=password]::placeholder{color:var(--color-text-light-4,#777)}
    input[type=password]:focus{outline:none;border-color:var(--color-primary,#7ab)}
    button{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:7px;padding:9px 18px;cursor:pointer;font-size:14px}
    button:hover{border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}</style></head>
    <body>
    <h2>chat is token-protected</h2>
    <p id="hint">Enter your <code>CHAT_TOKEN</code> (from <code>.env</code>) to unlock. It is stored only in
    this browser and sets a 30-day session cookie — you won't be asked again.
    You can also manage it from the <a href="/settings">settings page</a>.</p>
    <form id="f"><input type="password" id="tk" placeholder="chat token" autocomplete="off" autofocus>
    <button type="submit">unlock</button></form>
    <script>
    const params = new URLSearchParams(location.search);
    const saved = localStorage.getItem('tea_chat_token');
    if (params.get('token') !== null) {
      document.getElementById('hint').textContent = 'The token in the URL was rejected.' + (saved ? ' Edit the saved token below and unlock again.' : '');
      document.getElementById('tk').value = saved || '';
    } else if (saved) {
      location.replace('/chat?token=' + encodeURIComponent(saved));
    }
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      const v = document.getElementById('tk').value.trim();
      if (!v) return;
      localStorage.setItem('tea_chat_token', v);
      location.replace('/chat?token=' + encodeURIComponent(v));
    };
    </script>
    </body></html>`);
  };

  // Whole-UI gate (UI_TOKEN, CHAT_TOKEN accepted as the value / fallback):
  // cookie first, then ?token= / x-ui-token. A request that authenticates
  // via param/header gets the 30-day HttpOnly cookie, so the token is typed
  // ONCE and every page afterwards works bare.
  const UI_COOKIE = 'tea_ui_token';
  const uiTokenSet = () => !!(CFG.uiToken || CFG.chatToken);
  const uiAuthed = (req, url, res) => {
    const toks = [CFG.uiToken, CFG.chatToken].filter(Boolean);
    if (!toks.length) return true;
    const cookies = (req.headers.cookie || '').split('; ');
    const c = cookies.find((x) => x.startsWith(`${UI_COOKIE}=`));
    if (c && toks.includes(c.slice(UI_COOKIE.length + 1))) return true;
    const v = url.searchParams.get('token') || req.headers['x-ui-token'];
    const ok = toks.includes(v);
    if (ok && res)
      res.setHeader('set-cookie', `${UI_COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    return ok;
  };
  const ui401 = () => {
    // same unlock-form UX as chat401: a just-rejected token (in the URL)
    // shows the form for correction — no auto-redirect, that would 401-loop
    const th = giteaTheme();
    return send(401, 'text/html',
    `<!doctype html><html data-theme="${th.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>token required — 2pizzas</title>
    <link rel="stylesheet" href="/assets/gitea-theme.css">
    <style>body{font:14px/1.6 -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--color-body,#111);color:var(--color-text,#ddd);max-width:60ch;margin:4em auto;padding:0 16px}
    h2{font-size:20px;font-weight:700;letter-spacing:-.01em}
    a{color:var(--color-primary-light-2,#7ab)}
    input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;margin:12px 0;font-size:14px;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:8px;color:var(--color-input-text,#ddd)}
    input[type=password]::placeholder{color:var(--color-text-light-4,#777)}
    input[type=password]:focus{outline:none;border-color:var(--color-primary,#7ab)}
    button{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:7px;padding:9px 18px;cursor:pointer;font-size:14px}
    button:hover{border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}</style></head>
    <body>
    <h2>2pizzas is token-protected</h2>
    <p id="hint">Enter your <code>UI_TOKEN</code> (from <code>.env</code>) to unlock. It is stored only in
    this browser and sets a 30-day session cookie — you won't be asked again.
    You can also manage it from the <a href="/settings">settings page</a>.</p>
    <form id="f"><input type="password" id="tk" placeholder="ui token" autocomplete="off" autofocus>
    <button type="submit">unlock</button></form>
    <script>
    const params = new URLSearchParams(location.search);
    const saved = localStorage.getItem('tea_ui_token');
    if (params.get('token') !== null) {
      document.getElementById('hint').textContent = 'The token in the URL was rejected.' + (saved ? ' Edit the saved token below and unlock again.' : '');
      document.getElementById('tk').value = saved || '';
    } else if (saved) {
      const u = new URL(location.href); u.searchParams.set('token', saved); location.replace(u);
    }
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      const v = document.getElementById('tk').value.trim();
      if (!v) return;
      localStorage.setItem('tea_ui_token', v);
      const u = new URL(location.href); u.searchParams.set('token', v); location.replace(u);
    };
    </script>
    </body></html>`);
  };

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

  // whole-UI gate: everything except the HMAC-signed webhook, healthz, and
  // the theme asset (loaded by the 401 page itself)
  if (uiTokenSet() && !['/healthz', '/assets/gitea-theme.css'].includes(url.pathname) && !uiAuthed(req, url, res))
    return ui401();

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
  if (url.pathname === '/api/chat/sessions' && req.method === 'GET') {
    if (!chatAuthed(req, url, res)) return chat401();
    // live status overlaid on the persisted rows (a live session's row has
    // ended_at NULL). chatSeq ids restart at 1 per 2pizzas run, so overlay
    // ONLY the row whose created_at matches the live session's start — an
    // older row with the same id is a dead session that merely shares the id
    const rows = chatSessions().map((r) => {
      const live = chats.get(r.id);
      const isActive = chatRowLive(r);
      return { ...r, active: isActive, isStreaming: isActive ? live.isStreaming : false, lastActive: isActive ? live.lastActive : (r.ended_at || r.created_at) };
    });
    return send(200, 'application/json', JSON.stringify(rows));
  }
  const chatHistoryMatch = url.pathname.match(/^\/api\/chat\/(\d+)\/history$/);
  if (chatHistoryMatch && req.method === 'GET') {
    if (!chatAuthed(req, url, res)) return chat401();
    const row = chatSessionRow(+chatHistoryMatch[1]);
    if (!row) return send(404, 'application/json', JSON.stringify({ error: 'no such session' }));
    return send(200, 'application/json', JSON.stringify({ session: row, lines: chatHistory(row) }));
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
    if (c) return send(200, 'text/html', page(`chat ${c.id}`, chatView(c), { auto: false, nav: 'chat', app: true }));
    // dead session — read-only transcript from its log
    const row = chatSessionRow(+chatPageMatch[1]);
    if (!row) return send(404, 'text/plain', 'no such chat');
    return send(200, 'text/html', page(`chat ${row.id} (ended)`, chatHistoryView(row), { auto: false, nav: 'chat', app: true }));
  }
  // clear the chat session cookie (authenticates via cookie/param, then
  // the clearing set-cookie overwrites the one chatAuthed() just set)
  if (url.pathname === '/api/chat/logout' && req.method === 'POST') {
    if (!chatAuthed(req, url, res)) return chat401();
    res.setHeader('set-cookie', `${CHAT_COOKIE}=; Path=/; Max-Age=0`);
    res.setHeader('set-cookie', `${UI_COOKIE}=; Path=/; Max-Age=0`);
    return send(200, 'application/json', '{"ok":true}');
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
  // ── inference backends (inference.json — see inference.mjs) ──
  const readJson = (rq) => new Promise((resolve, reject) => {
    let body = '';
    rq.on('data', (d) => { body += d; if (body.length > 256 * 1024) { reject(new Error('body too large')); rq.destroy(); } });
    rq.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('bad json')); } });
  });
  const backendApi = async (fn) => {
    try { await fn(); send(200, 'application/json', '{"ok":true}'); }
    catch (e) { send(400, 'application/json', JSON.stringify({ error: e.message })); }
  };
  if (url.pathname === '/api/backends/baked' && req.method === 'GET')
    return send(200, 'application/json', JSON.stringify({ providers: await bakedProviderIds() }));
  if (url.pathname === '/api/backends' && req.method === 'POST')
    return backendApi(async () => { await addBackend(await readJson(req)); });
  // reachability probe — tests from 2pizzas's OWN vantage (the container that
  // calls the backend), not the host. POST = an arbitrary url (add-form, before
  // saving); GET :id/test = a saved backend. Always 200; the body carries
  // ok/models/error/hint so the UI can render the diagnostic.
  if (url.pathname === '/api/backends/test' && req.method === 'POST') {
    const f = await readJson(req);
    return send(200, 'application/json', JSON.stringify(await probeBackend({ url: String(f.url || ''), apiKey: String(f.apiKey || '') })));
  }
  const backendTestMatch = url.pathname.match(/^\/api\/backends\/([^/]+)\/test$/);
  if (backendTestMatch && req.method === 'GET') {
    const id = decodeURIComponent(backendTestMatch[1]);
    const b = readRegistry().find((x) => x.id === id);
    if (!b) return send(404, 'application/json', JSON.stringify({ error: `no backend ${id}` }));
    return send(200, 'application/json', JSON.stringify(await probeBackend(b)));
  }
  const backendItemMatch = url.pathname.match(/^\/api\/backends\/([^/]+)(?:\/(up|down))?$/);
  if (backendItemMatch && url.pathname !== '/api/backends/baked') {
    const id = decodeURIComponent(backendItemMatch[1]);
    if (req.method === 'DELETE') return backendApi(() => deleteBackend(id));
    if (req.method === 'PATCH') return backendApi(async () => { await updateBackend(id, await readJson(req)); });
    if (backendItemMatch[2] && req.method === 'POST') return backendApi(() => moveBackend(id, backendItemMatch[2]));
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
  if (url.pathname === '/settings') return send(200, 'text/html', await renderPage('settings', settingsPage(), { nav: 'settings' }));
  send(404, 'text/plain', 'not found');
});

server.listen(CFG.port, () => {
  console.log(`[2pizzas] listening on :${CFG.port}`);
  console.log(`[2pizzas] repos (poll fallback): ${managedRepos().join(', ') || '(none)'} — new repos self-enroll on @agent mention`);
  console.log(`[2pizzas] images: pi=${CFG.images.pi} opencode=${CFG.images.opencode} review=${CFG.images.review}`);
  console.log(`[2pizzas] review chain: ${CFG.review.token ? `enabled (max ${CFG.reviewMaxRounds} rounds)` : 'DISABLED (no REVIEW_TOKEN)'}`);
  console.log(`[2pizzas] webhook secret: ${CFG.secret ? 'set' : 'NOT SET (dev mode: signatures not verified)'}`);
  (async () => {
    try {
      for (const b of readRegistry()) {
        try {
          const ms = await backendModels(b);
          const loaded = ms.filter((m) => m.loaded).map((m) => m.id).join(', ') || 'none';
          console.log(`[inference] ${b.id} (p${b.priority}) ${b.url}: ${ms.map((m) => m.id).join(', ') || 'no models'} · loaded: ${loaded}`);
        } catch (e) { console.error(`[inference] ${b.id} (${b.url}): ${e.message}`); }
      }
      console.log(`[inference] pi baked default: ${JSON.stringify(await piDefaultModel())}`);
    } catch (e) { console.error(`[inference] ${e.message}`); }
  })();
});
