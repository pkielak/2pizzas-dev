<script>
  import { onMount } from 'svelte';
  import { connectLive } from './lib/live.mjs';
  import { currentRoute, navigate } from './lib/router.mjs';

  let open = $state(false);

  const nav = [
    ['/', 'home'], ['/infra', 'infra'], ['/tasks', 'tasks'], ['/chat', 'chat'],
    ['/android', 'android'], ['/pages', 'pages'], ['/repos', 'repos'],
    ['/stats', 'stats'], ['/settings', 'settings'], ['/backends', 'backends'],
  ];

  $effect(() => {
    document.title = $currentRoute ? `${$currentRoute.title} — 2pizzas` : '2pizzas';
  });

  onMount(() => {
    connectLive();
  });
</script>

<div class="layout">
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
        class:on={$currentRoute && $currentRoute.title === label}
        href={href}
        onclick={(e) => {
          if (navigate(href)) e.preventDefault();
        }}
      >{label}</a>
    {/each}
    <a class="navl sbfoot" href={location.protocol + '//' + location.hostname + ':3000'}>gitea ↗</a>
  </aside>
  <main>
    {#if $currentRoute}
      <svelte:component this={$currentRoute.component} {...$currentRoute.props} />
    {:else}
      <p class="meta">this page has not been migrated to the SPA yet</p>
    {/if}
  </main>
</div>
