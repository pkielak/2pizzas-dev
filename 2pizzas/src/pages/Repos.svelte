<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { giteaRepoHref } from '../lib/hl.mjs';

  let data = $state(null);
  let err = $state('');

  const load = () =>
    getJson('/api/repos')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  $effect(() => { if ($live) load(); });

  const del = async (repo) => {
    if (!confirm(`remove ${repo} from managed repos?`)) return;
    try {
      const r = await fetch(`/api/repos/${encodeURIComponent(repo)}`, { method: 'DELETE' });
      if (r.ok) load();
      else alert((await r.json().catch(() => ({}))).error || `request failed: ${r.status}`);
    } catch (e) { alert(e.message); }
  };
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !data}
  <p class="meta">loading…</p>
{:else}
  <p>
    global webhook:
    {#if data.webhook.ok}
      <span class="hook ok">✓ id {data.webhook.id} — fires for every repo, new ones included</span>
    {:else}
      <span class="hook bad">✗ {data.webhook.msg}</span>
    {/if}
  </p>
  <div class="list">
    {#each data.repos as r (r.repo)}
      <a class="item" href={giteaRepoHref(r.repo)}>
        <div class="l1">
          {r.repo}
          <span class="meta">{r.auto ? `auto · ${r.added ?? ''}` : 'env'}</span>
          {#if r.auto}<span class="del" title="remove from managed repos"
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); del(r.repo); }}>✕</span>{/if}
        </div>
        <div class="l2">{r.tot} tasks ({r.ok} ok / {r.bad} failed) · last activity: {r.last ?? '—'}</div>
      </a>
    {/each}
  </div>
  <p class="meta">
    repos self-enroll: mention <code>@pi</code>, <code>@opencode</code> or <code>@infra</code> on an issue in ANY repo —
    2pizzas persists it and grants the agent users write access automatically. <code>AGENTD_REPOS</code> in .env
    pins repos (no ✕); the ✕ removes a self-enrolled repo (its collaborator grants stay in Gitea — remove them there
    too if you want them gone)
  </p>
{/if}
