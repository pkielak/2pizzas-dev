<script>
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { connectLive } from './lib/live.mjs';
  import { currentRoute, navigate } from './lib/router.mjs';
  import ContextSidebar from './components/ContextSidebar.svelte';

  let open = $state(false);

  // the right sidebar mounts only for routes that have a panel (the
  // full-height chat session hides it) — .rsb-on drives the CSS layout
  const rsbOn = $derived(!$currentRoute?.app);

  const nav = [
    ['/', 'home'], ['/infra', 'infra'], ['/tasks', 'tasks'], ['/chat', 'chat'],
    ['/android', 'android'], ['/pages', 'pages'], ['/repos', 'repos'],
    ['/stats', 'stats'], ['/funky', 'funky'], ['/settings', 'settings'],
    ['/backends', 'backends'],
  ];

  $effect(() => {
    document.title = $currentRoute ? `${$currentRoute.title} — 2pizzas` : '2pizzas';
  });

  onMount(() => {
    connectLive();
  });
</script>

<div class="layout" class:rsb-on={rsbOn}>
  <header id="topbar">
    <button id="navToggle" aria-label="menu" onclick={() => (open = !open)}>☰</button>
    <span class="pgtitle">{$currentRoute ? $currentRoute.title : '2pizzas'}</span>
  </header>
  <div id="backdrop" class:show={open} onclick={() => (open = false)}></div>
  <aside class="sidebar" class:open={open}>
    <span class="brand">🍕 2pizzas</span>
    {#each nav as [href, label]}
      <a
        class="navl"
        class:on={$currentRoute && $currentRoute.nav === label}
        href={href}
        onclick={(e) => {
          if (navigate(href)) e.preventDefault();
        }}
      >{label}</a>
    {/each}
    <a class="navl sbfoot" href={location.protocol + '//' + location.hostname + ':3000'}>gitea ↗</a>
  </aside>
  <main class:app={$currentRoute?.app}>
    {#if $currentRoute}
      <!-- key: without it the {#if} stays truthy across route changes, so Svelte
           keeps the same element (and never re-runs the fly transition) — keying
           on the title forces a fresh element per route -->
      <div class="pagein" key={$currentRoute.title} transition:fly={{ y: 8, duration: 180, ease: (t) => 1 - Math.pow(1 - t, 3) }}>
        <svelte:component this={$currentRoute.component} {...$currentRoute.props} />
      </div>
    {/if}
  </main>
  {#if rsbOn}
    <aside class="rsb">
      <ContextSidebar />
    </aside>
  {/if}
</div>
