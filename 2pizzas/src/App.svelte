<script>
  import { onMount } from 'svelte';
  import { connectLive } from './lib/live.mjs';
  import Stats from './pages/Stats.svelte';

  // Migrated routes (SPA). Everything else in the nav is a plain anchor →
  // full load of the server-rendered page (ui/*.mjs) until it migrates.
  const routes = {
    '/stats': { component: Stats, title: 'stats' },
  };

  const nav = [
    ['/', 'home'], ['/infra', 'infra'], ['/tasks', 'tasks'], ['/chat', 'chat'],
    ['/android', 'android'], ['/pages', 'pages'], ['/repos', 'repos'],
    ['/stats', 'stats'], ['/settings', 'settings'], ['/backends', 'backends'],
  ];

  let path = $state(location.pathname);
  let entry = $state(routes[path] ?? null);
  let open = $state(false);

  $effect(() => {
    document.title = entry ? `${entry.title} — 2pizzas` : '2pizzas';
  });

  onMount(() => {
    connectLive();
    const onpop = () => { path = location.pathname; entry = routes[path] ?? null; };
    addEventListener('popstate', onpop);
    return () => removeEventListener('popstate', onpop);
  });

  const go = (href) => {
    open = false;
    if (routes[href]) {
      history.pushState({}, '', href);
      path = href;
      entry = routes[href];
    }
    // non-SPA route: default anchor navigation (full page load)
  };
</script>

<div class="layout">
  <header id="topbar">
    <button id="navToggle" aria-label="menu" onclick={() => (open = !open)}>☰</button>
    <span class="pgtitle">{entry ? entry.title : '2pizzas'}</span>
  </header>
  <div id="backdrop" class:show={open} onclick={() => (open = false)}></div>
  <aside class="sidebar" class:open={open}>
    <span class="brand">🍕 2pizzas</span>
    {#each nav as [href, label]}
      <a
        class="navl"
        class:on={path === href}
        href={href}
        onclick={(e) => {
          if (routes[href]) { e.preventDefault(); go(href); }
        }}
      >{label}</a>
    {/each}
    <a class="navl sbfoot" href={location.protocol + '//' + location.hostname + ':3000'}>gitea ↗</a>
  </aside>
  <main>
    {#if entry}
      <svelte:component this={entry.component} />
    {:else}
      <p class="meta">this page has not been migrated to the SPA yet</p>
    {/if}
  </main>
</div>
