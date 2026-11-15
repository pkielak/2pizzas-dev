<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { navigate } from '../lib/router.mjs';
  import { runPill } from '../lib/fmt.mjs';
  import TaskRow from '../components/TaskRow.svelte';
  import Loading from '../components/Loading.svelte';

  let tasks = $state(null);
  let runs = $state(null);
  let sites = $state(null);
  let err = $state('');

  const load = () =>
    Promise.all([getJson('/api/tasks'), getJson('/api/android'), getJson('/api/pages')])
      .then(([t, a, p]) => { tasks = t; runs = a.runs; sites = p.sites; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  // refetch on any live event — the in-flight count updates without a swap
  $effect(() => { if ($live) load(); });

  const inFlight = (r) => ['queued', 'waiting', 'pending', 'running'].includes(r.status);

</script>

{#if err}
  <p class="err">{err}</p>
{:else if !tasks || !runs || !sites}
  <Loading />
{:else}
  <p class="meta">
    {#if tasks.filter((t) => inFlight(t)).length}
      <span class="running">{tasks.filter((t) => inFlight(t)).length} task{tasks.filter((t) => inFlight(t)).length > 1 ? 's' : ''} in flight</span> ·
    {/if}
    {#if tasks[0]}last task {tasks[0].status} at {tasks[0].created_at}{:else}no tasks yet{/if}
    {#if runs.filter((r) => inFlight(r)).length}
      · <span class="running">{runs.filter((r) => inFlight(r)).length} android build{runs.filter((r) => inFlight(r)).length > 1 ? 's' : ''} in flight</span>
    {/if}
  </p>

  <h2>latest tasks</h2>
  <div class="list">
    {#if tasks.length}
      {#each tasks.slice(0, 5) as t (t.id)}
        <TaskRow t={t} />
      {/each}
    {:else}
      <div class="item"><div class="l2">no tasks yet</div></div>
    {/if}
  </div>
  <p><a href="/tasks" onclick={(e) => { if (navigate('/tasks')) e.preventDefault(); }}>all tasks →</a></p>

  <h2>latest android builds</h2>
  <div class="list">
    {#if runs.length}
      {#each runs.slice(0, 8) as r (r.id)}
        <a class="item" href={`https://${location.hostname}:3000/${r.repo}/actions/runs/${r.id}`}>
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
      <div class="item"><div class="l2">no android builds yet</div></div>
    {/if}
  </div>
  <p><a href="/android" onclick={(e) => { if (navigate('/android')) e.preventDefault(); }}>all builds →</a></p>

  <h2>pages</h2>
  <div class="list">
    {#if sites.length}
      {#each sites as s (s.repo + ':' + s.port)}
        <a class="item" href={`https://${location.hostname}:${s.port}/`}>
          <div class="l1">{s.repo} <span class="meta">:{s.port}</span></div>
          <div class="l2">
            {#if s.commit}{s.commit.h} · {s.commit.at} · {s.commit.s}
            {:else}<span class="err">not synced ({s.err ?? 'no checkout'})</span>{/if}
          </div>
        </a>
      {/each}
    {:else}
      <div class="item"><div class="l2">no sites configured</div></div>
    {/if}
  </div>
  <p><a href="/pages" onclick={(e) => { if (navigate('/pages')) e.preventDefault(); }}>pages →</a></p>
{/if}
