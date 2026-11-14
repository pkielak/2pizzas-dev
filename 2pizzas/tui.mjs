#!/usr/bin/env node
// 2pizzas TUI — a zero-dependency terminal dashboard over the same HTTP API
// as the web UI. Run:  node 2pizzas/tui.mjs
//   env: PIZZAS_URL (default http://127.0.0.1:3001), UI_TOKEN (if the UI is gated)
//
// Home boots. `c` opens the chat REPL (claude / pi coding-agent TUI
// style) — type to talk, /commands to control:
//   /new /stop /model /clear /task <id> /tasks /backends /chats /home
//   /help /quit
//   esc in chat   = clear input / abort the turn (a dead chat: back to the list)
//   esc in a list = back to the chat you came from (else no-op)
//   in chat `q` is a character (ctrl-c always quits); elsewhere q quits
// Views:  1 home · 2 tasks · 3 backends · 4 chats
//   list:    j/k or ↑/↓ scroll (5-row pages) · pgup/pgdn · g/G top/bottom
//            · enter open · r refresh · esc/q quit
//   home:    overview — latest 5 tasks (enter → log), backends, chat counts
//   task:    live log tail (SSE) · j/k/wheel scroll (pins like tail -f) · g tail · esc back
//   backends: t = probe reachability from 2pizzas's vantage
//   chat:    live transcript (SSE) · type + enter to send · /commands · esc back

import { StringDecoder } from 'node:string_decoder';

const BASE = (process.env.PIZZAS_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const TOKEN = process.env.UI_TOKEN || '';
// Gitea is on the SAME host as the 2pizzas UI (port 3000). The URLs the chat
// agent emits use host.docker.internal (only reachable from job containers),
// so re-point them at the host this TUI reaches the UI on — copy-paste-able.
const giteaUrl = (u) => {
  const m = /^https?:\/\/[^/]+(\/[^#?]*?\/(?:issues|pulls)\/\d+)/.exec(u);
  return m ? `${new URL(BASE).protocol}//${new URL(BASE).hostname}:3000${m[1]}` : u;
};
const authed = (p) => (TOKEN ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : p);

// ── terminal ─────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
// pizza palette (same as the web UI) — truecolor, so the exact brand hexes
const tc = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const P = {
  sauce: tc(221, 74, 72),   // --sauce   errors, active tab
  cheese: tc(238, 221, 178), // --cheese  brand, running, notes
  olives: tc(78, 135, 82),   // --olives  success, live
};
const col = (s, c) => `${c}${s}${C.reset}`;

let lastOut = '';
let lastW = 0, lastH = 0;
function paint(screen) {
  // a resize invalidates every layout — full clear before the next frame
  if (W() !== lastW || H() !== lastH) { lastW = W(); lastH = H(); lastOut = ''; process.stdout.write('\x1b[H\x1b[2J'); }
  if (screen === lastOut) return;
  lastOut = screen;
  // \x1b[K on every row (a shorter line must not leave the previous frame's
  // longer line's tail on the right) + \x1b[J (frames are not always
  // full-height — without it a shorter frame leaves the previous frame's
  // tail rows on screen, looks like rows "multiplying")
  const framed = screen.split('\n').map((l) => l + '\x1b[K').join('\n');
  process.stdout.write(`\x1b[H${framed}\x1b[J`);
}
const W = () => process.stdout.columns || 80;
const H = () => process.stdout.rows || 24;
// agent logs carry raw control chars (\r progress bars, embedded ANSI) —
// writing them verbatim moves the cursor and garbles the frame (the
// "top bar glitch" when scrolling over such a line)
const clean = (s) => String(s)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b[=>]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
  .replace(/\r/g, ' ');
const vis = (s) => clean(s).length;
const fit = (s, w) => { s = String(s); return vis(s) > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s; };
function wrap(s, w) {
  const out = [];
  for (const raw of String(s).split('\n')) {
    let line = raw;
    while (vis(line) > w) {
      let cut = w;
      while (cut > 0 && vis(line.slice(0, cut)) > w) cut--;
      out.push(line.slice(0, cut)); line = ' ' + line.slice(cut);
    }
    out.push(line);
  }
  return out;
}
const pad = (s, w) => { s = fit(s, w); return s + ' '.repeat(Math.max(0, w - vis(s))); };
// W()-1: a line of exactly W chars leaves the cursor in the delayed-wrap
// state at the last column — the following \n can skip a row on some terminals
const hr = (w) => C.dim + '─'.repeat(Math.max(0, w - 1)) + C.reset;

// ── api ──────────────────────────────────────────────────────────────────────

async function jget(p) {
  const res = await fetch(authed(BASE + p), { headers: TOKEN ? { 'x-ui-token': TOKEN } : {} });
  if (res.status === 401) throw new Error('401 — set UI_TOKEN');
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json();
}
async function jpost(p, body) {
  const res = await fetch(authed(BASE + p), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-ui-token': TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${p} → ${res.status}`);
  return j;
}

// SSE reader: replays existing frames then streams live ones.
function sse(p, onData, onDone) {
  const dec = new StringDecoder('utf8');
  let buf = '', done = false;
  const finish = (err) => { if (!done) { done = true; onDone(err); } };
  (async () => {
    try {
      const res = await fetch(authed(BASE + p), { headers: TOKEN ? { 'x-ui-token': TOKEN } : {} });
      if (!res.ok) { finish(`http ${res.status}`); return; }
      for await (const chunk of res.body) {
        buf += dec.write(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: done')) { finish(null); return; }
            if (line.startsWith('data: ')) onData(line.slice(6));
          }
        }
      }
      finish(null);
    } catch (e) { finish(e.message); }
  })();
}

// ── state ────────────────────────────────────────────────────────────────────

const PAGE = 5;           // list rows per page (scrollable)
const state = {
  view: 'home',           // 'home' | 'tasks' | 'backends' | 'chats' | 'tasklog' | 'chatview'
  home: null,             // home-view extras (health, backends, sessions)
  sel: 0, items: [],
  detail: null,           // { kind:'task', id, lines[], status } | { kind:'chat', id, lines[], input }
  returnChat: null,       // chat id to go back to (chat is home — lists are excursions)
  note: '',               // status bar note (transient)
  err: '',                // persistent error banner
  lastUpdate: 0,
};
let pollTimer = null;
let detailOpen = false;   // a detail view is open → stop list polling

const statusColor = { success: P.olives, failure: P.sauce, running: P.cheese, queued: C.dim };

// ── list views ───────────────────────────────────────────────────────────────

async function loadTasks() {
  state.items = await jget('/api/tasks');
  state.sel = Math.min(state.sel, Math.max(0, state.items.length - 1));
}
async function loadHome() {
  const [health, tasks, backends, sessions] = await Promise.all([
    jget('/healthz'), jget('/api/tasks'), jget('/api/backends'), jget('/api/chat/sessions'),
  ]);
  state.items = tasks.slice(0, PAGE);
  state.home = { health, backends, sessions };
  state.sel = Math.min(state.sel, Math.max(0, state.items.length - 1));
}
async function loadBackends() {
  const [backends, baked] = await Promise.all([jget('/api/backends'), jget('/api/backends/baked').catch(() => ({ providers: [] }))]);
  state.items = backends.map((b) => ({ ...b, baked: baked.providers.includes(b.id) }));
  state.sel = Math.min(state.sel, Math.max(0, state.items.length - 1));
}
async function loadChats() {
  state.items = await jget('/api/chat/sessions');
  state.sel = Math.min(state.sel, Math.max(0, state.items.length - 1));
}
const LOADERS = { home: loadHome, tasks: loadTasks, backends: loadBackends, chats: loadChats };

async function refresh() {
  state.err = '';
  try {
    if (!detailOpen) await LOADERS[state.view]();
    state.lastUpdate = Date.now();
    state.note = '';
  } catch (e) { state.err = e.message; }
  render();
}

// ── detail views ─────────────────────────────────────────────────────────────

function openTask(id) {
  detailOpen = true;
  state.view = 'tasklog';
  // pin = absolute index of the bottom visible line; null = follow the tail
  state.detail = { kind: 'task', id, lines: [], status: '…', done: false, note: '', pin: null };
  sse(`/task/${id}/stream`,
    (line) => { state.detail.lines.push(line); if (state.detail.lines.length > 5000) state.detail.lines.shift(); render(); },
    () => { state.detail.done = true; render(); });
  jget(`/api/task/${id}`).then((t) => { if (state.detail) state.detail.status = t.status; render(); }).catch(() => {});
  render();
}
function openChat(id, row) {
  detailOpen = true;
  state.view = 'chatview';
  state.returnChat = null; // the chat IS home
  state.detail = { kind: 'chat', id, rowid: row?.rowid ?? null, lines: [], input: '', done: false, help: false };
  // session meta (model) — /model shows it
  jget('/api/chat/sessions').then((ss) => {
    const s = (ss || []).find((x) => x.id === id);
    if (s && state.detail?.kind === 'chat') state.detail.model = s.model;
    render();
  }).catch(() => {});
  sse(`/chat/${id}/stream`,
    (line) => { state.detail.lines.push(line); state.detail.help = false; if (state.detail.lines.length > 5000) state.detail.lines.shift(); render(); },
    (err) => {
      state.detail.done = true; state.detail.errNote = err || 'stream closed';
      // dead session: the stream 404s — load the recorded transcript instead.
      // Replace the raw "http 404" errNote with the session's end reason —
      // the 404 is just how dead streams answer, not an error for the user.
      // A list row carries its rowid — the only unique key (chatSeq ids
      // restart per run, so a bare-id lookup shadows older same-id rows).
      if (!state.detail.lines.length && /404/.test(err || ''))
        jget(state.detail.rowid ? `/api/chat/r${state.detail.rowid}/history` : `/api/chat/${id}/history`).then((h) => {
          if (state.detail?.kind === 'chat') {
            state.detail.lines = h.lines || [];
            state.detail.errNote = h.session?.end_reason || 'ended';
            render();
          }
        }).catch(() => {});
      render();
    });
  render();
}
function closeDetail() {
  detailOpen = false;
  const prev = state.detail;
  state.detail = null;
  // a task log opened from a chat goes back to that chat, not the list
  if (prev?.kind === 'task' && state.returnChat != null) { openChat(state.returnChat); return; }
  state.view = prev?.kind === 'task' ? 'tasks' : 'chats';
  if (prev?.kind !== 'chat') state.returnChat = null;
  render();
  refresh();
}

// boot into a fresh chat REPL (chat-first); fall back to home on failure
async function startChat() {
  try {
    const c = await jpost('/api/chat', { agent: 'pi' });
    openChat(c.id);
  } catch (e) {
    if (detailOpen) closeDetail();
    state.err = e.message; refresh();
  }
}

// claude/pi-style /commands in the chat REPL
const CHAT_HELP = [
  '/new                fresh chat (ends this session)',
  '/stop               abort the current turn',
  '/model              show the model in use',
  '/task <id>          open a task log',
  '/tasks /backends /chats /home   list views (esc returns)',
  '/clear              clear the transcript view',
  '/help               toggle this help',
  '/quit               exit',
  'esc                 abort turn · clear input (dead chat: back to the list)',
];
function chatCmd(d, cmd) {
  const [name, ...args] = cmd.split(/\s+/);
  const arg = args.join(' ');
  switch (name) {
    case 'help': d.help = !d.help; render(); break;
    case 'new':
      // end this session (like the web UI's close) before starting the fresh one
      fetch(authed(BASE + `/api/chat/${d.id}`), { method: 'DELETE', headers: TOKEN ? { 'x-ui-token': TOKEN } : {} }).catch(() => {});
      startChat();
      break;
    case 'stop': jpost(`/api/chat/${d.id}/abort`).catch((e) => { d.note = e.message; }).finally(render); break;
    case 'model': d.note = d.model ? `model: ${d.model}` : 'model: server-picked (see /backends)'; render(); break;
    case 'clear': d.lines = []; d.note = 'transcript view cleared (the server log is untouched)'; render(); break;
    case 'task': {
      const id = +arg;
      if (!id) { d.note = 'usage: /task <id>'; render(); return; }
      jget(`/api/task/${id}`).then(() => { state.returnChat = d.id; openTask(id); })
        .catch((e) => { d.note = e.message; render(); });
      break;
    }
    case 'tasks': case 'backends': case 'chats': case 'home': go(name); break;
    case 'quit': shutdown(); break;
    default: d.note = `unknown command /${name || '?'} — /help`; render();
  }
}

// chat lines are JSON event objects (stringified in the SSE stream, parsed
// objects from /history) or raw marker strings
function chatLine(l) {
  if (typeof l !== 'string') l = JSON.stringify(l);
  let e; try { e = JSON.parse(l); } catch { return [{ pre: C.dim, text: l }]; }
  // transient chatLive events (deltas/status — clients only, never part of
  // the transcript). The settled text_block/tool_call that follow ARE the
  // nice rendering, so these must not show as raw JSON. They become a single
  // transient status line (renderChat keeps only the LAST one).
  const status = {
    working: '… working',
    thinking: '… thinking',
    compaction: e.phase === 'start' ? `… compacting (${e.reason || 'threshold'})` : null,
    auto_retry: `… retrying (${e.attempt}/${e.max})`,
    tool_end: '… tool finished',
  }[e.type];
  if (status) return [{ pre: C.dim, text: status, transient: true }];
  if (e.type === 'text_delta' || e.type === 'ctx' || e.type === 'compaction') return [];
  switch (e.type) {
    // chat view is deliberately low-color (dark blue/magenta are hard to read
    // in terminals) — palette accents for structure, plain for content, red for
    // errors
    case 'user_message': return wrap(e.message, W() - 8).map((t) => ({ pre: C.bold + P.cheese + ' you » ' + C.reset, text: t }));
    case 'text_block': {
      // highlight host commands (./setup.sh --deploy etc.) in bold cheese
      // and Gitea issue/PR URLs in cyan — created refs land here too
      const hl = (t) => t
        .replace(/\.\/(setup\.sh\s+\S+|deploy\.sh)/g, `${C.bold}${P.cheese}$&${C.reset}`)
        .replace(/https?:\/\/[^\s"'<>]+?\/(issues|pulls)\/\d+/g, (u) => `${C.cyan}${giteaUrl(u)}${C.reset}`);
      return wrap(hl(e.text), W() - 14).map((t, i) => ({ pre: i === 0 ? C.bold + P.olives + ' assistant » ' + C.reset : '            ', text: t }));
    }
    case 'gitea_ref': return [{ pre: P.olives + ' 🔗 ' + C.reset, text: `${C.bold}${e.kind} #${e.number}${C.reset} ${C.cyan}${giteaUrl(e.url)}${C.reset}` }];
    case 'tool_call': return [{ pre: P.olives + ' ⚙ ' + C.reset, text: `${C.bold}${e.name}${C.reset} ${C.dim}${fit(e.arg || '', W() - 20)}${C.reset}` }];
    case 'settle': return [{ pre: C.dim, text: '─ done ─' }];
    case 'compacted': return [{ pre: C.dim, text: `─ compacted (${e.reason || 'threshold'}) ─` }];
    case 'error': return [{ pre: P.sauce + ' ✗ ', text: e.message || 'error' }];
    default: return [{ pre: C.dim, text: fit(l, W() - 2) }];
  }
}

// ── render ───────────────────────────────────────────────────────────────────

function header() {
  const tab = (n, name) => state.view.startsWith(n[0]) ? `${C.bold}${P.sauce}${name}${C.reset}` : `${C.dim}${name}${C.reset}`;
  const right = state.err
    ? col(` ✗ ${state.err} `, P.sauce)
    : (state.lastUpdate ? col(` updated ${new Date(state.lastUpdate).toLocaleTimeString()} `, C.dim) : '');
  const left = ` ${C.bold}${P.cheese}🍕 2pizzas${C.reset}   ${tab('home', '1·home')}  ${tab('tasks', '2·tasks')}  ${tab('backends', '3·backends')}  ${tab('chats', '4·chats')} `;
  // W()-1: never write the last column (delayed-wrap state garbles \n on some terminals)
  return left + ' '.repeat(Math.max(1, W() - 1 - vis(left) - vis(right))) + right;
}

// scrollable PAGE-row window: the selection follows, the page edges at 2
// rows above/below it (so j/k at the window edge scrolls)
function rowsView(build, hint) {
  const out = [header(), hr(W()), ''];
  const n = state.items.length;
  const top = n <= PAGE ? 0 : Math.max(0, Math.min(state.sel - 2, n - PAGE));
  state.items.slice(top, top + PAGE).forEach((it, i) => {
    const sel = top + i === state.sel;
    out.push(sel ? col(build(it, true), C.bold) : build(it, false));
  });
  if (!n) out.push(C.dim + '  (empty)' + C.reset);
  if (n > PAGE) out.push(C.dim + `  ${top > 0 ? `↑ ${top} · ` : ''}${n - top - PAGE} more ↓` + C.reset);
  out.push('', hr(W()), col(hint, C.dim));
  if (state.note) out.push(col(state.note, P.cheese));
  return out.join('\n');
}

function render() {
  switch (state.view) {
    case 'home': {
      const h = state.home;
      if (!h) { paint(''); break; }
      const out = [header(), hr(W()), ''];
      out.push(fit(`  dispatcher ${P.olives}ok${C.reset} · ${h.health.active} active task(s) · repos: ${h.health.repos.join(', ') || '—'}`, W() - 1));
      out.push('');
      out.push(`${C.bold}${P.cheese}  latest tasks${C.reset}`);
      state.items.forEach((t, i) => {
        const st = col(fit(t.status, 8), statusColor[t.status] || '');
        out.push(`${i === state.sel ? col('>', P.sauce) + ' ' : '  '}${pad(t.id, 5)}${st}${pad(t.agent, 9)}${pad(t.repo + '#' + t.issue, 26)}${t.created_at || ''}`);
      });
      if (!state.items.length) out.push(C.dim + '  (none)' + C.reset);
      out.push('');
      out.push(`${C.bold}${P.cheese}  backends${C.reset}`);
      for (const b of h.backends)
        out.push(`  ${pad(b.id, 14)}${pad(b.defaultModel || '—', 24)}${fit(b.url, W() - 42)}`);
      out.push('');
      const live = h.sessions.filter((s) => s.active).length;
      out.push(`  chats: ${live} live · ${h.sessions.length - live} past`);
      while (out.length < H() - 4) out.push(''); // frame ends with hr + hint (+note) → ≤ H()-1
      out.push(hr(W()));
      out.push(col('j/k pick task · enter log · c chat · 2/3/4 lists · r refresh · q quit', C.dim));
      if (state.note) out.push(col(state.note, P.cheese));
      paint(out.join('\n'));
      break;
    }
    case 'tasks': {
      paint(rowsView((t, sel) => {
        const st = col(fit(t.status, 8), statusColor[t.status] || '');
        // total row width must stay ≤ W()-1 (wrap mid-row shifts the frame)
        const wModel = Math.max(8, W() - 2 - 5 - 8 - 9 - 13 - 22 - 16 - 1);
        return `${sel ? col('>', P.sauce) + ' ' : '  '}${pad(t.id, 5)}${st}${pad(t.agent, 9)}${pad(t.kind, 13)}${pad(t.repo + '#' + t.issue, 22)}${pad(t.model || '—', wModel)}${fit(t.created_at || '', 16)}`;
      }, 'j/k scroll · pgup/pgdn · g top · G bottom · enter log · r · 1 home · q quit'));
      break;
    }
    case 'backends': {
      paint(rowsView((b, sel) => {
        const baked = b.baked ? '' : col(' not-baked', P.cheese);
        return `${sel ? col('>', P.sauce) + ' ' : '  '}${pad(b.id, 16)}${pad(b.defaultModel || '—', 24)}${pad(b.url, W() - 2 - 16 - 24 - 10 - 1)}${baked}`;
      }, 'j/k scroll · t test · r · 1 home · q quit'));
      break;
    }
    case 'chats': {
      paint(rowsView((c, sel) => {
        const st = c.active ? (c.isStreaming ? col('streaming', P.cheese) : col('live', P.olives)) : C.dim + 'ended' + C.reset;
        return `${sel ? col('>', P.sauce) + ' ' : '  '}${pad(c.id, 5)}${pad(c.agent, 9)}${pad(c.model || '—', 22)}${pad(c.messages ?? 0, 4)}${pad(c.tokens ?? '—', 7)}${pad(c.created_at, 18)}${st}`;
      }, 'j/k scroll · enter open · n new · r · 1 home · q quit'));
      break;
    }
    case 'tasklog': {
      const d = state.detail; if (!d) return;
      const mode = d.pin == null
        ? (d.done ? 'finished' : 'live tail')
        : `paused ↑${d.lines.length - 1 - d.pin} from tail`;
      paint(renderLog(d, `task #${d.id} · ${col(d.status, statusColor[d.status] || '')} · ${col(mode, d.pin == null ? '' : P.cheese)}`));
      break;
    }
    case 'chatview': {
      const d = state.detail; if (!d) return;
      const out = [header(), hr(W())];
      out.push(col(`  chat #${d.id} · ${d.done ? (d.errNote || 'ended') : 'live'}`, C.bold));
      out.push('');
      const rendered = [];
      for (const l of d.lines) for (const r of chatLine(l)) rendered.push(r);
      // one transient status line at most — the newest replaces the last
      for (let i = rendered.length - 2; i >= 0; i--) if (rendered[i].transient) rendered.splice(i, 1);
      const helpN = d.help ? 1 + CHAT_HELP.length : 0; // counted against the budget so the input line is never clipped
      const bodyH = H() - 6 - helpN;
      const start = Math.max(0, rendered.length - bodyH);
      for (const r of rendered.slice(start)) out.push(r.pre + fit(clean(r.text), W() - vis(r.pre) - 1));
      while (out.length < H() - 3 - helpN) out.push('');
      if (d.help) { out.push(''); for (const l of CHAT_HELP) out.push(col('  ' + l, C.dim)); }
      out.push(hr(W()));
      out.push(`${C.bold}${P.cheese} > ${C.reset}` + fit(d.input, W() - 40) // room for the suffix
        + (d.done ? C.dim + '  (ended — esc to go back)' + C.reset
           : d.note ? ' ' + col(d.note, P.sauce)
           : d.help ? ' ' + col('/help again to hide', C.dim)
           : ' ' + col('/help for commands', C.dim)));
      paint(out.slice(0, H()).join('\n'));
      break;
    }
  }
}

function renderLog(d, title) {
  const out = [header(), hr(W()), col(`  ${title}`, C.bold), ''];
  // 4 header rows + bodyH + hr + hint (+note) must stay ≤ H()-1 — a frame
  // taller than the terminal auto-scrolls on every render (the "top bar
  // phase"): the whole frame drifts up a row per draw
  const bodyH = H() - 7;
  const end = d.pin == null ? d.lines.length : d.pin + 1;
  const start = Math.max(0, end - bodyH);
  for (const l of d.lines.slice(start, end)) out.push(fit(clean(l), W() - 1));
  // H()-3: the frame ends with hr + hint → H()-1 rows total; the bottom row
  // must stay EMPTY (a corner write auto-scrolls the terminal and shifts
  // the whole frame — the "top bar phase")
  while (out.length < H() - 3) out.push('');
  out.push(hr(W()));
  const above = start > 0 ? ` ↑ ${start}` : '';
  out.push(col(` esc back · j/k or wheel scroll · g tail${above} · q quit`, C.dim));
  if (d.note) out.push(col(d.note, P.cheese));
  return out.join('\n');
}

// ── input ────────────────────────────────────────────────────────────────────

async function onKey(key) {
  // global
  if (key === '\x03') { shutdown(); return; } // ctrl-c quits everywhere (q is a character in chat)

  if (state.view === 'tasklog') {
    const d = state.detail;
    if (key === '\x1b') { closeDetail(); return; }
    if (key === 'q') { shutdown(); return; }
    const up = key === '\x1b[A' || key === 'k' ? 1 : (key === '\x1b[5~' || key === '\x1b[65~' ? PAGE : 0);
    const dn = key === '\x1b[B' || key === 'j' ? 1 : (key === '\x1b[6~' || key === '\x1b[64~' ? PAGE : 0);
    if (up) {
      // pin the view at the current bottom line, then move up — new log
      // lines keep appending BELOW the pinned window (like tail -f paused)
      d.pin = d.pin == null ? d.lines.length - 1 : d.pin;
      d.pin = Math.max(0, d.pin - up);
      render();
    } else if (dn) {
      if (d.pin == null) return; // already at the live tail
      d.pin = Math.min(d.lines.length - 1, d.pin + dn);
      if (d.pin === d.lines.length - 1) d.pin = null; // back on the tail
      render();
    } else if (key === 'g' || key === 'G') {
      d.pin = null;
      render();
    }
    return;
  }
  if (state.view === 'chatview') {
    const d = state.detail;
    if (key === '\x1b') {
      // chat is home — esc never leaves a live chat:
      // clear the input, or abort the running turn
      if (d.input) { d.input = ''; render(); return; }
      if (d.done) { closeDetail(); return; }
      jpost(`/api/chat/${d.id}/abort`).catch((e) => { d.note = e.message; }).finally(render);
      return;
    }
    if (key === '\r') {
      const msg = d.input.trim(); d.input = '';
      if (!msg) return;
      if (msg.startsWith('/')) { chatCmd(d, msg.slice(1).trim()); return; } // /commands
      jpost(`/api/chat/${d.id}/message`, { message: msg }).catch((e) => { d.note = e.message; }).finally(render);
      return;
    }
    if (key === '\x7f' || key === '\x08') { d.input = d.input.slice(0, -1); render(); return; }
    if (key.length === 1 && key >= ' ' && !d.done) { d.input += key; render(); return; }
    return;
  }

  // list views (home included — its selectable rows are the latest tasks)
  if (key === 'q') { shutdown(); return; }
  const n = state.items.length;
  const clampSel = (v) => { state.sel = Math.max(0, Math.min(n - 1, v)); render(); };
  switch (key) {
    case '\x1b[A': case 'k': if (n) clampSel(state.sel - 1); break;
    case '\x1b[B': case 'j': if (n) clampSel(state.sel + 1); break;
    case '\x1b[5~': case '\x1b[65~': if (n) clampSel(state.sel - PAGE); break;  // pgup / wheel-up
    case '\x1b[6~': case '\x1b[64~': if (n) clampSel(state.sel + PAGE); break;  // pgdn / wheel-down
    case 'g': if (n) clampSel(0); break;
    case 'G': if (n) clampSel(n - 1); break;
    case '\x1b':
      // back to the chat (chat is home)
      if (state.returnChat != null) openChat(state.returnChat);
      break;
    case 'r': refresh(); break;
    case '1': case '\x1b1': go('home'); break;
    case '2': case '\x1b2': go('tasks'); break;
    case '3': case '\x1b3': go('backends'); break;
    case '4': case '\x1b4': go('chats'); break;
    case '\r':
      if ((state.view === 'tasks' || state.view === 'home') && state.items[state.sel]) openTask(state.items[state.sel].id);
      else if (state.view === 'chats' && state.items[state.sel]) openChat(state.items[state.sel].id, state.items[state.sel]);
      break;
    case 'c':
      startChat();
      break;
    case 'n':
      if (state.view === 'chats') {
        const c = await jpost('/api/chat', { agent: 'pi' }).catch((e) => { state.note = e.message; render(); return; });
        state.note = `chat #${c.id} started`;
        openChat(c.id);
      }
      break;
    case 't':
      if (state.view === 'backends' && state.items[state.sel]) {
        const b = state.items[state.sel];
        state.note = `testing ${b.id}…`; render();
        jget(`/api/backends/${encodeURIComponent(b.id)}/test`)
          .then((j) => { state.note = j.ok ? `ok · ${j.count} model(s) in ${j.ms}ms: ${(j.models || []).join(', ')}` : `NOT reachable · ${j.error} ${j.hint || ''}`; })
          .catch((e) => { state.note = e.message; })
          .finally(render);
      }
      break;
  }
}
function go(view) {
  state.returnChat = state.detail?.kind === 'chat' ? state.detail.id : null;
  if (detailOpen) closeDetail();
  state.view = view; state.sel = 0; state.items = [];
  render(); refresh();
}

function shutdown() {
  process.stdin.setRawMode?.(false);
  process.stdout.write('\x1b[?25h\x1b[H\x1b[J'); // show cursor, clear
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdout.write('\x1b]2;🍕 2pizzas\x07'); // terminal title (branding)
process.stdout.write('\x1b[?25l\x1b[H\x1b[2J'); // hide cursor, clear

let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  while (pending.length) {
    if (pending.startsWith('\x1b[')) {
      const m = pending.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
      if (!m) { if (pending.length > 8) pending = pending.slice(1); else return; } // wait for full sequence
      onKey(m[0]); pending = pending.slice(m[0].length);
    } else if (pending.startsWith('\x1b')) {
      onKey(pending.length === 1 ? '\x1b' : pending[1]); // lone esc, or alt+key
      pending = pending.slice(1);
    } else {
      onKey(pending[0]); pending = pending.slice(1);
    }
  }
});

// background polling for list views (+ task status while in the log view)
pollTimer = setInterval(() => {
  if (state.view === 'tasklog' && state.detail)
    jget(`/api/task/${state.detail.id}`).then((t) => { state.detail.status = t.status; render(); }).catch(() => {});
  else if (!detailOpen && !state.err) refresh().catch(() => {});
}, 4000);
refresh(); // home boots
