<script>
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api.mjs';
  import { giteaRepoHref } from '../lib/hl.mjs';

  let data = $state(null);
  let err = $state('');

  onMount(() =>
    getJson('/api/android')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; }));

  const pill = (r) => {
    if (['queued', 'waiting', 'pending', 'running'].includes(r.status)) return { cls: 'running', text: r.status };
    if (r.conclusion === 'success') return { cls: 'success', text: 'success' };
    if (r.conclusion === 'failure') return { cls: 'failure', text: 'failure' };
    if (r.conclusion === 'cancelled') return { cls: 'queued', text: 'cancelled' };
    return { cls: 'queued', text: r.status || '—' };
  };
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !data}
  <p class="meta">loading…</p>
{:else}
  {#if data.err}<p class="err">{data.err}</p>{/if}
  <div class="list">
    {#if data.runs.length}
      {#each data.runs as r (r.id)}
        <a class="item" href={giteaRepoHref(r.repo, `actions/runs/${r.id}`)}>
          <div class="l1">
            <span class={pill(r).cls}>{pill(r).text}</span>
            <span>#{r.id}</span> {r.repo} · {r.head_branch}
          </div>
          <div class="l2">
            {r.display_title.slice(0, 140)}{r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ''} ·
            {(r.started_at || '—').replace('T', ' ').slice(0, 19)}
          </div>
        </a>
      {/each}
    {:else}
      <div class="item">
        <div class="l2">no android builds yet — jobs opt in with <code>runs-on: android</code></div>
      </div>
    {/if}
  </div>
  <p class="meta">
    built on <code>android-runner</code> (label <code>android</code>, image <code>gitea-android:latest</code>: JDK 21 +
    Android SDK + warm ~/.gradle) — separate from <code>my-runner</code> (ordinary CI)
  </p>
{/if}
