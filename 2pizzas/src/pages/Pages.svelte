<script>
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api.mjs';
  import Loading from '../components/Loading.svelte';

  let sites = $state(null);
  let err = $state('');

  onMount(() =>
    getJson('/api/pages')
      .then((d) => { sites = d.sites; err = ''; })
      .catch((e) => { err = e.message; }));

  const siteHref = (s) => `https://${location.hostname}:${s.port}/`;
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !sites}
  <Loading />
{:else}
  <div class="list">
    {#if sites.length}
      {#each sites as s (s.repo + ':' + s.port)}
        <a class="item" href={siteHref(s)}>
          <div class="l1">{s.repo} <span class="meta">:{s.port}</span></div>
          <div class="l2">
            {#if s.commit}
              {s.commit.h} · {s.commit.at} · {s.commit.s}
            {:else}
              <span class="err">not synced ({s.err ?? 'no checkout'})</span>
            {/if}
          </div>
        </a>
      {/each}
    {:else}
      <div class="item">
        <div class="l2">no sites — set PAGES_SITES in .env (repo:port:container per pages service)</div>
      </div>
    {/if}
    <div class="item">
      <div class="l2">
        each site is a <code>pages/</code> compose service serving a repo's <code>gh-pages</code> branch (CI pushes the
        branch, the server syncs every 60s). add one: new compose service (see <code>browser-llm-bench-pages</code>) →
        append <code>repo:port:container</code> to PAGES_SITES → <code>docker compose up -d 2pizzas</code>
      </div>
    </div>
  </div>
{/if}
