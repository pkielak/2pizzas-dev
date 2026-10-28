// settings page — client-side token storage for the token-gated UI.
// The token never leaves the browser except as the gate check itself
// (?token= / cookie); localStorage is the persistence, the HttpOnly
// session cookie (set by the server on first successful unlock) is what
// keeps the bare pages working afterwards.
export function settingsPage() {
  return `<h2>ui token</h2>
<p class="meta">the 2pizzas UI is gated by <code>UI_TOKEN</code> (from <code>.env</code>; <code>CHAT_TOKEN</code> is
accepted as the value and as a fallback when <code>UI_TOKEN</code> is unset). the token is
stored only in <b>this browser</b> (localStorage) — it is sent to the server only as the gate
check. unlocking sets a 30-day <code>HttpOnly</code> session cookie, so after the first unlock
every page works with no token in the URL.</p>
<div class="item">
  <div class="l1">token <span id="tkstate" class="meta"></span></div>
  <div class="l2" style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
    <input type="password" id="tk" placeholder="ui token" style="flex:1;min-width:20ch;max-width:38ch;padding:6px 9px" autocomplete="off">
    <button id="tksave">save &amp; unlock</button>
    <button id="tkclear">clear saved</button>
    <button id="tkout">sign out</button>
  </div>
  <p class="meta" id="tkhelp"></p>
</div>
<p class="meta"><b>save &amp; unlock</b> stores the token in this browser and opens the home page with it
(sets the session cookie). <b>clear saved</b> removes it from localStorage only. <b>sign out</b> clears
the session cookies (the saved token stays). rotating <code>UI_TOKEN</code> in <code>.env</code> +
<code>docker compose up -d 2pizzas</code> revokes everything immediately.</p>
<script>
const tk = document.getElementById('tk');
const state = document.getElementById('tkstate');
const help = document.getElementById('tkhelp');
const saved = () => localStorage.getItem('tea_ui_token');
tk.value = saved() || '';
const showState = async () => {
  state.textContent = saved() ? '· saved in this browser' : '· not saved';
  help.textContent = '';
  try {
    const r = await fetch('/', { method: 'HEAD' });
    help.textContent = r.status === 401
      ? 'ui gate: locked — save a token to unlock'
      : 'ui gate: unlocked (open, or session cookie active)';
  } catch { help.textContent = ''; }
};
showState();
document.getElementById('tksave').onclick = () => {
  const v = tk.value.trim();
  if (!v) return;
  localStorage.setItem('tea_ui_token', v);
  location.href = '/?token=' + encodeURIComponent(v);
};
document.getElementById('tkclear').onclick = () => {
  localStorage.removeItem('tea_ui_token');
  tk.value = '';
  showState();
};
document.getElementById('tkout').onclick = async () => {
  const v = tk.value.trim() || saved() || '';
  const r = await fetch('/api/chat/logout' + (v ? '?token=' + encodeURIComponent(v) : ''), { method: 'POST' });
  if (r.ok) help.textContent = 'session cookies cleared';
  else help.textContent = 'sign out failed (' + r.status + ') — no active session?';
};
</script>`;
}
