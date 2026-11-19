<script>
  import { onMount } from 'svelte';

  // theme — saved in this browser (localStorage), applied to every page
  // immediately, no reload
  let theme = $state(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const setTheme = (dark) => {
    theme = dark ? 'dark' : 'light';
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { dark ? localStorage.setItem('tea_theme', 'dark') : localStorage.removeItem('tea_theme'); } catch { /* private mode */ }
  };

  // ui token — stored only in THIS browser (localStorage); sent to the
  // server only as the gate check. Unlocking sets the 30-day HttpOnly
  // session cookie, so after the first unlock every page works bare.
  let token = $state(localStorage.getItem('tea_ui_token') || '');
  let help = $state('');

  const showState = async () => {
    help = '';
    try {
      const r = await fetch('/', { method: 'HEAD' });
      help = r.status === 401
        ? 'ui gate: locked — save a token to unlock'
        : 'ui gate: unlocked (open, or session cookie active)';
    } catch { help = ''; }
  };

  onMount(showState);

  const save = () => {
    const v = token.trim();
    if (!v) return;
    localStorage.setItem('tea_ui_token', v);
    location.href = '/?token=' + encodeURIComponent(v);
  };

  const clearSaved = () => {
    localStorage.removeItem('tea_ui_token');
    token = '';
    showState();
  };

  const signOut = async () => {
    const v = token.trim() || localStorage.getItem('tea_ui_token') || '';
    const r = await fetch('/api/chat/logout' + (v ? '?token=' + encodeURIComponent(v) : ''), { method: 'POST' });
    help = r.ok ? 'session cookies cleared' : `sign out failed (${r.status}) — no active session?`;
  };
</script>

<h2>theme</h2>
<div class="list">
  <div class="item">
    <div class="l1">appearance <span class="meta">· {theme}</span></div>
    <div class="l2" style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
      <button class="btn" class:on={theme === 'light'} onclick={() => setTheme(false)}>☀ light</button>
      <button class="btn" class:on={theme === 'dark'} onclick={() => setTheme(true)}>☾ dark</button>
    </div>
    <p class="meta">saved in this browser (localStorage) — applies to every page immediately, no reload.</p>
  </div>
</div>

<h2>ui token</h2>
<div class="list">
  <div class="item">
    <p class="meta">
      the 2pizzas UI is gated by <code>UI_TOKEN</code> (from <code>.env</code>; <code>CHAT_TOKEN</code> is
      accepted as the value and as a fallback when <code>UI_TOKEN</code> is unset). the token is
      stored only in <b>this browser</b> (localStorage) — it is sent to the server only as the gate
      check. unlocking sets a 30-day <code>HttpOnly</code> session cookie, so after the first unlock
      every page works with no token in the URL.
    </p>
    <div class="l1">token <span class="meta">{token ? '· saved in this browser' : '· not saved'}</span></div>
    <div class="l2" style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
      <input type="password" bind:value={token} placeholder="ui token" style="flex:1;min-width:20ch;max-width:38ch;padding:6px 9px" autocomplete="off">
      <button class="btn" onclick={save}>save &amp; unlock</button>
      <button class="btn" onclick={clearSaved}>clear saved</button>
      <button class="btn" onclick={signOut}>sign out</button>
    </div>
    <p class="meta">{help}</p>
    <p class="meta">
      <b>save &amp; unlock</b> stores the token in this browser and opens the home page with it
      (sets the session cookie). <b>clear saved</b> removes it from localStorage only. <b>sign out</b> clears
      the session cookies (the saved token stays). rotating <code>UI_TOKEN</code> in <code>.env</code> +
      <code>docker compose up -d 2pizzas</code> revokes everything immediately.
    </p>
  </div>
</div>
