<script>
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api.mjs';
  import { runPill } from '../lib/fmt.mjs';
  import { giteaRepoHref } from '../lib/hl.mjs';
  import Loading from '../components/Loading.svelte';

  let data = $state(null);
  let err = $state('');

  onMount(() =>
    getJson('/api/android')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; }));

</script>

{#if err}
  <p class="err">{err}</p>
{:else if !data}
  <Loading />
{:else}
  {#if data.err}<p class="err">{data.err}</p>{/if}
  <div class="list">
    {#if data.runs.length}
      {#each data.runs as r (r.id)}
        <a class="item" href={giteaRepoHref(r.repo, `actions/runs/${r.id}`)}>
          <div class="l1">
            <span class={runPill(r).cls}>{runPill(r).text}</span>
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
    <div class="item">
      <div class="l2">
        built on <code>android-runner</code> (label <code>android</code>, image <code>gitea-android:latest</code>: JDK 21 +
        Android SDK + warm ~/.gradle) — separate from <code>my-runner</code> (ordinary CI)
      </div>
    </div>
  </div>
{/if}
