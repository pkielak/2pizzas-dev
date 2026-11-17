<script>
  // A right-hand sidebar that adapts to the active view. Each panel fetches
  // its OWN lightweight JSON and refetches on any live event — the same
  // pattern the pages use. Full-height app views (chat session) hide the
  // whole sidebar (App.svelte only mounts it when the route has a panel).
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { authUrl } from '../lib/chatauth.mjs';
  import { currentRoute, navigate } from '../lib/router.mjs';
  import { fmtTok } from '../lib/fmt.mjs';

  const view = $derived($currentRoute?.nav ?? '');

  let data = $state(null);
  let err = $state('');
  let loadGen = 0; // stale responses (view changed / newer load) are dropped
  let loadedView = '';

  // quick theme toggle (mirrors Settings.svelte — localStorage, no reload)
  let dark = $state(document.documentElement.dataset.theme === 'dark');
  const setTheme = (d) => {
    dark = d;
    d ? (document.documentElement.dataset.theme = 'dark') : delete document.documentElement.dataset.theme;
    try { d ? localStorage.setItem('tea_theme', 'dark') : localStorage.removeItem('tea_theme'); } catch { /* private mode */ }
  };

  const inFlight = (r) => ['queued', 'waiting', 'pending', 'running'].includes(r.status);
  const counts = $derived.by(() => {
    if (!Array.isArray(data)) return [];
    const m = {};
    for (const t of data) m[t.status] = (m[t.status] || 0) + 1;
    return Object.entries(m);
  });

  const nav = (href) => (e) => { if (navigate(href)) e.preventDefault(); };

  const load = async () => {
    const gen = ++loadGen;
    const v = view; // the view this load was started for
    try {
      let d = null;
      switch (v) {
        case 'home': {
          const [t, c] = await Promise.all([getJson('/api/tasks'), getJson(authUrl('/api/chat/sessions'))]);
          d = { tasks: t, chats: c.filter((r) => r.active) };
          break;
        }
        case 'chat': {
          const rows = await getJson(authUrl('/api/chat/sessions'));
          d = { active: rows.filter((r) => r.active), past: rows.filter((r) => !r.active) };
          break;
        }
        case 'tasks': { d = await getJson('/api/tasks'); break; }
        case 'repos': { d = await getJson('/api/repos'); break; }
        case 'stats': { d = await getJson('/api/stats'); break; }
        case 'backends': { d = await getJson('/api/backends'); break; }
        case 'infra': { d = await getJson('/api/infra'); break; }
        case 'android': { d = await getJson('/api/android'); break; }
        case 'pages': { d = await getJson('/api/pages'); break; }
        case 'settings': { d = {}; break; }
        default: d = null;
      }
      // a newer load (navigation or live tick) superseded this one —
      // dropping the stale response keeps the template's `view`/`data` pair consistent
      if (gen === loadGen) { data = d; err = ''; }
    } catch (e) {
      if (gen === loadGen) err = e.message;
    }
  };

  // Clear the panel on view change BEFORE the render that reads the new
  // `view` — otherwise that render pairs the new view with the previous
  // panel's `data` and touches a property the new view doesn't have
  // (e.g. `.tasks` on the repos payload) → uncaught TypeError.
  $effect.pre(() => {
    const v = view;
    if (v !== loadedView) { loadedView = v; data = null; }
  });

  // refetch on navigation (view change) and on any live event
  $effect(() => {
    const v = view;
    void $live;
    if (v) load();
  });
</script>

{#if err}
  <h3>{view || 'context'}</h3>
  <div class="note">{err}</div>
{:else if view === 'home'}
  <h3>now</h3>
  {#if data?.tasks}
    <div class="sbrow"><span class="sbk">tasks in flight</span><span class="sbn">{data.tasks.filter(inFlight).length}</span></div>
    <div class="sbrow"><span class="sbk">active chats</span><span class="sbn">{data.chats?.length ?? 0}</span></div>
    <div class="sbrow"><span class="sbk">last task</span><span class="sbn">{data.tasks[0]?.status ?? '—'}</span></div>
  {/if}
  <div class="sblinks">
    <a href="/tasks" onclick={nav('/tasks')}>all tasks →</a>
    <a href="/chat" onclick={nav('/chat')}>chats →</a>
    <a href="/backends" onclick={nav('/backends')}>backends →</a>
  </div>
{:else if view === 'chat'}
  <h3>chats</h3>
  <div class="list">
    {#if data?.active?.length}
      {#each data.active as c (c.id)}
        <a class="item" href="/chat/{c.id}" onclick={nav(`/chat/${c.id}`)}>
          <div class="l1">#{c.id} <span>@{c.agent}</span>
            <span class={c.isStreaming ? 'running' : 'success'}>{c.isStreaming ? 'streaming' : 'idle'}</span>
          </div>
        </a>
      {/each}
    {:else}
      <div class="item"><div class="l2">no active chats</div></div>
    {/if}
  </div>
  {#if data?.past?.length}
    <h3>past</h3>
    <div class="list">
      {#each data.past.slice(0, 5) as r (r.rowid)}
        <a class="item" href="/chat/r{r.rowid}" onclick={nav(`/chat/r${r.rowid}`)}>
          <div class="l1">#{r.id} <span>@{r.agent}</span> <span class="badge">ended</span></div>
        </a>
      {/each}
    </div>
  {/if}
{:else if view === 'tasks'}
  <h3>tasks by status</h3>
  {#if counts.length}
    {#each counts as [k, n]}
      <div class="sbrow"><span class="sbk">{k}</span><span class="sbn">{n}</span></div>
    {/each}
  {:else if data}
    <div class="note">no tasks yet</div>
  {/if}
  <div class="sblinks"><a href="/stats" onclick={nav('/stats')}>usage →</a></div>
{:else if view === 'repos'}
  <h3>managed repos</h3>
  {#if data?.repos}
    <div class="sbrow"><span class="sbk">managed</span><span class="sbn">{data.repos.length}</span></div>
    {#each data.repos.slice(0, 8) as r (r.repo)}
      <div class="sbrow"><span class="sbk">{r.repo}</span><span class="sbn">{r.tot}</span></div>
    {/each}
  {/if}
{:else if view === 'stats'}
  <h3>usage</h3>
  {#if data?.total}
    <div class="sbrow"><span class="sbk">tasks</span><span class="sbn">{data.total}</span></div>
    <div class="sbrow"><span class="sbk">tokens</span><span class="sbn">{fmtTok(data.tok.s)}</span></div>
    {#each data.models.slice(0, 5) as m (m.model)}
      <div class="sbrow"><span class="sbk">{m.model}</span><span class="sbn">{m.n}</span></div>
    {/each}
  {:else if data}
    <div class="note">no tasks yet</div>
  {/if}
{:else if view === 'backends'}
  <h3>backends</h3>
  {#if Array.isArray(data)}
    {#each data as b (b.id)}
      <div class="sbrow"><span class="sbk">{b.id}</span><span class="sbn">{b.defaultModel || '—'}</span></div>
    {/each}
  {/if}
  <div class="sblinks"><a href="/backends" onclick={nav('/backends')}>manage →</a></div>
{:else if view === 'infra'}
  <h3>containers</h3>
  {#if data?.docker}
    {#each [['gitea', 'gitea'], ['dispatcher', '2pizzas'], ['runner', 'my-runner'], ['androidRunner', 'android'], ['pages', 'pages']] as [k, label]}
      <div class="sbrow">
        <span class="dot" class:ok={data.docker[k] === true} class:bad={data.docker[k] === false}></span>
        <span class="sbk">{label}</span>
      </div>
    {/each}
  {/if}
  {#if data?.managedN != null}
    <div class="sbrow"><span class="sbk">managed repos</span><span class="sbn">{data.managedN}</span></div>
  {/if}
{:else if view === 'android'}
  <h3>builds</h3>
  {#if data?.err}
    <div class="note">{data.err}</div>
  {:else if data?.runs}
    <div class="sbrow"><span class="sbk">in flight</span><span class="sbn">{data.runs.filter(inFlight).length}</span></div>
    <div class="sbrow"><span class="sbk">total</span><span class="sbn">{data.runs.length}</span></div>
  {/if}
{:else if view === 'pages'}
  <h3>pages</h3>
  {#if data?.sites}
    {#each data.sites as s (s.repo + ':' + s.port)}
      <div class="sbrow">
        <span class="dot" class:ok={!!s.commit}></span>
        <span class="sbk">{s.repo}</span><span class="sbn">:{s.port}</span>
      </div>
    {/each}
  {/if}
{:else if view === 'settings'}
  <h3>theme</h3>
  <div class="sbbtns">
    <button class="btn" class:on={!dark} onclick={() => setTheme(false)}>☀ light</button>
    <button class="btn" class:on={dark} onclick={() => setTheme(true)}>☾ dark</button>
  </div>
  <div class="note" style="margin-top:8px">token &amp; theme are stored in this browser.</div>
  <div class="sblinks"><a href="/settings" onclick={nav('/settings')}>open settings →</a></div>
{:else}
  <h3>quick links</h3>
  <div class="sblinks">
    <a href="/" onclick={nav('/')}>home</a>
    <a href="/tasks" onclick={nav('/tasks')}>tasks</a>
    <a href="/chat" onclick={nav('/chat')}>chats</a>
    <a href="/backends" onclick={nav('/backends')}>backends</a>
  </div>
{/if}
