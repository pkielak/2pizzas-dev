<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import TaskRow from '../components/TaskRow.svelte';
  import Loading from '../components/Loading.svelte';

  let tasks = $state(null);
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
{:else if !tasks}
  <Loading />
{:else}
  <div class="list">
    {#each tasks as t (t.id)}
      <TaskRow t={t} />
    {/each}
  </div>
{/if}
