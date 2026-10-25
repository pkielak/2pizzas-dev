import { CFG } from '../config.mjs';
import { db } from '../db.mjs';
import { apiGet } from '../gitea.mjs';
import { chats, chatSessions, chatHistory } from '../chat.mjs';
import { esc } from './layout.mjs';

// one line of the persisted transcript (log line: parsed event or plain
// marker text) → a rendered message block (same classes as the live view)
const historyBlock = (line) => {
  let e;
  try { e = JSON.parse(line); } catch { e = line; }
  if (typeof e === 'string')
    return `<div class="msettle">${esc(e)}</div>`;
  switch (e.type) {
    case 'user_message': return `<div class="muser">${esc(e.message)}</div>`;
    case 'text_block': return `<div class="mtext">${esc(e.text)}</div>`;
    case 'tool_call': return `<div class="mtool">⚙ <b>${esc(e.name)}</b> <code>${esc(String(e.arg).slice(0, 200))}</code></div>`;
    case 'settle': return `<div class="msettle">settled</div>`;
    case 'compacted': return `<div class="mcompacted">— context compacted —</div>`;
    case 'error': return `<div class="merr">error: ${esc(e.message)}</div>`;
    default: return ''; // live-only events never reach the log
  }
};

// ── chat pages ─────────────────────────────────────────────────────────────

export async function chatListPage() {
  const rows = [...chats.values()].map((c) => `<a class="item" href="/chat/${c.id}">
    <div class="l1">@${esc(c.agent)} <span>#${c.id}</span> ${c.isStreaming ? '<span class="running">streaming</span>' : '<span class="success">idle</span>'}</div>
    <div class="l2">${c.model ? `model <span class="model">${esc(c.model)}</span> · ` : ''}started ${esc(new Date(c.startedAt).toISOString().slice(5, 16).replace('T', ' '))} UTC · last activity ${esc(new Date(c.lastActive).toISOString().slice(11, 19))} UTC</div>
  </a>`).join('\n');
  // past sessions: persisted rows (chat_sessions) — the whole history is
  // still readable from each session's log file
  const past = chatSessions(100)
    .filter((r) => !chats.has(r.id)) // live ones are in the section above
    .map((r) => `<a class="item" href="/chat/${r.id}">
    <div class="l1">@${esc(r.agent)} <span>#${r.id}</span> <span class="badge">ended</span></div>
    <div class="l2">${esc(r.created_at?.slice(5, 16) ?? '')} → ${esc(r.ended_at?.slice(11, 19) ?? '?')} UTC · ${esc(r.end_reason ?? '?')} · ${r.messages} message${r.messages === 1 ? '' : 's'}</div>
  </a>`).join('\n');
  // grant UI: every repo on the instance, with a per-repo grant/revoke toggle
  let grantUi = '';
  if (CFG.chatGiteaToken) {
    const grantAt = Object.fromEntries(
      db.prepare('SELECT repo, granted_at FROM chat_grants').all().map((g) => [g.repo, g.granted_at]));
    // drift cleanup: chat_grants is our OWN record — a human can revoke the
    // collaborator in Gitea directly, leaving a stale "write since" row.
    // Verify each recorded grant against the real permission (204 = yes,
    // 404 = no) and drop the stale ones
    for (const repo of [...Object.keys(grantAt)]) {
      let state; // 'yes' | 'no' | 'unknown'
      try {
        state = (await apiGet(`/repos/${repo}/collaborators/${CFG.chatLogin}`, { token: CFG.chatGiteaToken, ok404: true })) !== null ? 'yes' : 'no';
      } catch { state = 'unknown'; } // Gitea blip — never drop a row on an error
      if (state === 'no') {
        db.prepare('DELETE FROM chat_grants WHERE repo=?').run(repo);
        delete grantAt[repo];
      }
    }
    let allRepos = [], repoErr = null;
    try {
      // /admin/repos does not exist in Gitea 1.27 — search covers all repos
      // the admin token can see (private included). No total_count in the
      // response, so paginate until a short page (was a blind limit=250)
      for (let page = 1; ; page++) {
        const rs = await apiGet(`/repos/search?limit=50&page=${page}`, { token: CFG.adminToken });
        const batch = (rs.data ?? []).map((r) => r.full_name);
        allRepos.push(...batch);
        if (batch.length < 50) break;
      }
      allRepos.sort();
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
  const html = `<form id="newchat">
  <button type="submit">start chat</button>
</form>
<h2>active</h2>
<div class="list">${rows || '<div class="item"><div class="l2">no active chats</div></div>'}</div>
<h2>past sessions</h2>
<div class="list">${past || '<div class="item"><div class="l2">none yet</div></div>'}</div>
${grantUi}
<p class="meta">each chat is a long-lived gVisor sandbox with one agent.${CFG.chatGiteaToken ? ` it has Gitea access as <code>${esc(CFG.chatLogin)}</code> (write where granted above)` : ' no Gitea token — it chats and can read the 00-tea task API, but cannot push or post.'} chats die on 00-tea restart or after ${CFG.chatIdleMs / 60000} min idle — their transcripts stay readable under <i>past sessions</i>.</p>`;
  return {
    html,
    script: `<script>window.__pageInit = function(){
// token carrier fallback (the session cookie is primary; this covers
// cookie-blocked browsers) — URL param, else the localStorage saved token
const tk = new URLSearchParams(location.search).get('token') || localStorage.getItem('tea_chat_token');
const auth = (p) => p + (tk ? '?token=' + encodeURIComponent(tk) : '');
const form = document.getElementById('newchat');
if (form) form.onsubmit = async function (e) {
  e.preventDefault();
  const r = await fetch(auth('/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'pi' }) });
  const j = await r.json();
  if (r.ok) location.href = '/chat/' + j.id; else alert(j.error || 'failed to start chat');
};
document.querySelectorAll('.grantbtn').forEach(b => b.onclick = async () => {
  const grant = b.dataset.grant === '1';
  if (!grant && !confirm('revoke ' + b.dataset.repo + ' write access for the chat agent?')) return;
  const r = await fetch(auth('/api/chat/grant'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: b.dataset.repo, grant }) });
  if (r.ok) location.reload(); else alert((await r.json()).error || 'grant failed');
});
};</script>`,
  };
}

export function chatView(c) {
  // one compact header bar (the transcript's start marker already carries
  // model + start time, so no separate meta row)
  return `<div class="chatapp">
<div class="chathead">
<a class="back" href="/chat">←</a><span class="chid">#${c.id}</span><span class="meta" id="chatstate">idle</span>
<a class="back chclose" href="#" id="closechat">close</a>
</div>
<div id="msgs"></div>
<div class="chatin">
  <textarea id="msg" rows="2" placeholder="message ${esc(c.agent)}… (Enter sends, Shift+Enter newline)"></textarea>
  <div class="chatbtns"><button id="send"><span class="ic">▷</span>send</button><button id="stop"><span class="ic">□</span>stop</button></div>
</div>
</div>
<script>
// token carrier fallback (the session cookie is primary; this covers
// cookie-blocked browsers) — URL param, else the localStorage saved token
const tk = new URLSearchParams(location.search).get('token') || localStorage.getItem('tea_chat_token');
const auth = (p) => p + (tk ? '?token=' + encodeURIComponent(tk) : '');
document.querySelector('.back').href = auth('/chat');
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
const textBlock = () => { curText = addEl('mtext', ''); };
const toolBlock = (name, arg) => addEl('mtool', '⚙ <b>' + escH(name) + '</b> <code>' + escH(String(arg).slice(0, 200)) + '</code>');
const handle = (line) => {
  let e; try { e = JSON.parse(line); } catch { if (line.startsWith('[00-tea]')) addEl('msettle', escH(line)); return; }
  // transcript events (user_message, text_block, tool_call, settle, error)
  // are replayed on (re)connect — they rebuild the FULL conversation;
  // live events (text_delta, thinking, working, tool_end, auto_retry) are
  // not replayed — they only drive the status line + incremental text
  if (e.type === 'user_message') { userMsg(e.message); return; }
  if (e.type === 'text_delta') {
    if (!curText || curText.dataset.settled) textBlock(); // a settled block must never receive live deltas
    curText.textContent += e.delta;
    box.scrollTop = box.scrollHeight;
    setStatus('writing…');
  } else if (e.type === 'text_block') {
    // settled block: live clients finalize their delta-built block (same
    // text — a visual no-op), replay clients get it whole; mark it settled
    // so the next live delta starts a FRESH block
    if (!curText || curText.dataset.settled) textBlock();
    curText.textContent = e.text;
    curText.dataset.settled = 1;
    box.scrollTop = box.scrollHeight;
  } else if (e.type === 'tool_call') {
    curText = null;
    toolBlock(e.name, e.arg);
    setStatus('running ' + e.name + '…');
  } else if (e.type === 'tool_end') setStatus('thinking…');
  else if (e.type === 'thinking') setStatus('thinking…');
  else if (e.type === 'working') setStatus('working…');
  else if (e.type === 'settle') { curText = null; setStatus(''); addEl('msettle', 'settled'); }
  else if (e.type === 'auto_retry') setStatus('retrying (' + e.attempt + '/' + e.max + ')…');
  else if (e.type === 'compaction') setStatus('compacting context…');
  else if (e.type === 'compacted') { curText = null; addEl('mcompacted', '— context compacted —'); }
  else if (e.type === 'error') { setStatus(''); addEl('merr', 'error: ' + escH(e.message)); }
};
const es = new EventSource(auth('/chat/${c.id}/stream'));
// every (re)connect replays the whole stream from the server — clear on open;
// statusEl MUST be re-attached: addEl() inserts before it, and insertBefore
// with a detached reference throws, silently killing all rendering
es.onopen = () => { box.innerHTML = ''; box.appendChild(statusEl); };
es.onmessage = (ev) => handle(ev.data);
// session ended (idle timeout / killed / container died): the server sends
// the [00-tea] chat closed line JUST BEFORE this event, so the reason is
// already on screen — freeze the UI in place instead of a silent redirect
es.addEventListener('done', () => {
  es.close();
  setStatus('');
  stateEl.textContent = 'ended';
  stateEl.className = 'meta';
  const b = document.createElement('div');
  b.className = 'mend';
  b.innerHTML = 'session ended — <a href="' + auth('/chat') + '">back to chats</a> (transcript kept under past sessions)';
  box.insertBefore(b, statusEl);
  box.scrollTop = box.scrollHeight;
  ta.disabled = true;
  document.getElementById('send').disabled = true;
  document.getElementById('stop').disabled = true;
});
async function sendMsg() {
  const t = ta.value.trim();
  if (!t) return;
  ta.value = '';
  setStatus('sending…'); // the bubble arrives via the stream echo
  const r = await fetch(auth('/api/chat/${c.id}/message'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: t }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); addEl('merr', j.error || 'send failed'); setStatus(''); }
}
document.getElementById('send').onclick = sendMsg;
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
document.getElementById('stop').onclick = () => fetch(auth('/api/chat/${c.id}/abort'), { method: 'POST' });
document.getElementById('closechat').onclick = async (e) => {
  e.preventDefault();
  await fetch(auth('/api/chat/${c.id}'), { method: 'DELETE' });
  location.href = auth('/chat'); // the done banner fires on the way out
};
</script>`;
}

// read-only transcript of a dead session (log file → message blocks)
export function chatHistoryView(row) {
  const blocks = chatHistory(row).map(historyBlock).join('\n');
  return `<div class="chatapp">
<div class="chathead">
<a class="back" href="/chat">←</a><span class="chid">#${row.id}</span><span class="badge">ended</span>
<span class="meta">${esc(row.end_reason ?? '')} · ${row.messages} msg · ${esc(row.created_at?.slice(5, 16) ?? '')} → ${esc(row.ended_at?.slice(11, 19) ?? '')}</span>
</div>
<div id="msgs">${blocks || '<div class="msettle">empty session</div>'}</div>
<div class="chatin endednote"><span class="meta">this session has ended — its transcript is preserved. <a href="/chat">start a new chat</a></span></div>
</div>`;
}
