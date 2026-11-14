<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { navigate } from '../lib/router.mjs';
  import { ctxText } from '../lib/fmt.mjs';

  let tasks = $state([]);
  let err = $state('');

  const load = () =>
    getJson('/api/tasks')
      .then((d) => { tasks = d; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  // refetch this page's JSON on any live event — no HTML swap, focus-safe
  $effect(() => { if ($live) load(); });
</script>

{#if err}
  <p class="err">{err}</p>
{/if}
<div class="list">
  {#each tasks as t (t.id)}
    <a
      class="item"
      href="/task/{t.id}"
      onclick={(e) => { if (navigate(`/task/${t.id}`)) e.preventDefault(); }}
    >
      <div class="l1"><span class={t.status}>{t.status}</span> <span>#{t.id}</span> {t.repo}#{t.issue}</div>
      <div class="l2">
        @{t.agent}
        {#if t.kind === 'agent-review' || t.kind === 'rework'} · {t.kind}{/if}
        {#if (t.round ?? 1) > 1} · round {t.round}{/if}
        {#if t.parent_id} · from #{t.parent_id}{/if}
        {#if t.model} · <span class="model">{t.model}</span>{/if}
        {#if ctxText(t)} · <span class="ctx">{ctxText(t)}</span>{/if}
        · {t.created_at}
      </div>
      {#if t.error}<div class="err">{t.error}</div>{/if}
    </a>
  {/each}
</div>
