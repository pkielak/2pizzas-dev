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

  const siteHref = (s) => `http://${location.hostname}:${s.port}/`;
  const siteHttpsHref = (s) => `https://${location.hostname}:${s.https_port}/`;
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !sites}
  <Loading />
{:else}
  <div class="list">
    {#if sites.length}
      {#each sites as s (s.repo + ':' + s.port)}
        {#if s.https_port}
          <div class="item chatrow">
            <a class="chatlink" href={siteHref(s)} target="_blank" rel="noopener">
              <div class="l1">{s.repo} <span class="meta">:{s.port}</span></div>
              <div class="l2">
                {#if s.commit}
                  {s.commit.h} · {s.commit.at} · {s.commit.s}
                {:else}
                  <span class="err">not synced ({s.err ?? 'no checkout'})</span>
                {/if}
              </div>
            </a>
            <a class="badge badge-success" href={siteHttpsHref(s)} target="_blank" rel="noopener" title={`open over https (:${s.https_port})`}>https</a>
          </div>
        {:else}
          <a class="item" href={siteHref(s)} target="_blank" rel="noopener">
            <div class="l1">{s.repo} <span class="meta">:{s.port}</span></div>
            <div class="l2">
              {#if s.commit}
                {s.commit.h} · {s.commit.at} · {s.commit.s}
              {:else}
                <span class="err">not synced ({s.err ?? 'no checkout'})</span>
              {/if}
            </div>
          </a>
        {/if}
      {/each}
    {:else}
      <div class="item">
        <div class="l2">no sites — set PAGES_SITES in .env (repo:port:container[:https_port] per pages service)</div>
      </div>
    {/if}
    <div class="item">
      <div class="l2">
        each site is a <code>pages/</code> compose service serving a repo's <code>gh-pages</code> branch (CI pushes the
        branch, the server syncs every 60s). add one: new compose service (see <code>browser-llm-bench-pages</code>) →
        append <code>repo:port:container</code> to PAGES_SITES → <code>docker compose up -d 2pizzas</code>. the https link
        appears whenever the service maps its 8443 TLS port — it goes live once a real (CA-signed) cert is
        dropped into <code>pages/certs/</code> + the service recreated (no config edit)
      </div>
    </div>
  </div>
{/if}
