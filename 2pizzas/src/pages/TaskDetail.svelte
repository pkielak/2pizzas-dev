<script>
  import { onMount } from 'svelte';
  import { getJson, postJson } from '../lib/api.mjs';
  import { navigate } from '../lib/router.mjs';
  import { ctxText, fmtTok } from '../lib/fmt.mjs';
  import TaskLog from '../components/TaskLog.svelte';
  import Loading from '../components/Loading.svelte';

  let { taskId } = $props();
  let task = $state(null);
  let log = $state('');
  let streaming = $state(false);
  let err = $state('');
  // live token readout parsed from the streaming log (the filter emits a
  // `[2pizzas] usage:` line per turn, so this climbs as the run progresses)
  let liveTokens = $state(null);

  const onUsage = (_model, tokens) => { liveTokens = tokens; };

  const load = (withLog = false) =>
    getJson(`/api/task/${taskId}`)
      .then((t) => {
        task = t;
        streaming = ['queued', 'running'].includes(t.status);
        liveTokens = null; // a settled task carries its own stored tokens
        if (withLog) return getJson(`/api/task/${taskId}/log`).then((d) => { log = d.log; });
      })
      .catch((e) => { err = e.message; });

  onMount(() => load(true));

  // the SSE stream reported the task settled → swap to the static log
  const settle = () => load(true);

  const stop = () => postJson(`/api/tasks/${taskId}/stop`, {}).then(() => load(true)).catch((e) => { err = e.message; });
  const retry = () => postJson(`/api/tasks/${taskId}/retry`, {}).then((d) => { if (d.newTaskId) navigate(`/task/${d.newTaskId}`); else load(true); }).catch((e) => { err = e.message; });
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !task}
  <Loading />
{:else}
  <a class="back" href="/tasks" onclick={(e) => { if (navigate('/tasks')) e.preventDefault(); }}>← back to tasks</a>
  <div class="pagehead">
    <span class={task.status}>{task.status}</span>
    {#if streaming}<span class="live">live</span>{/if}
    {#if streaming && liveTokens != null}<span class="livetok">≈ {fmtTok(liveTokens)} tok</span>{/if}
    {#if streaming}
      <button class="btn danger" onclick={stop}>stop task</button>
    {:else if task.status === 'failure' || task.status === 'canceled'}
      <button class="btn" onclick={retry}>retry task</button>
    {/if}
  </div>
  <p class="meta">
    {task.repo}#{task.issue} · @{task.agent}
    {#if task.model} · <span class="model">{task.model}</span>{/if}
    {#if ctxText(task)} · <span class="ctx">{ctxText(task)}</span>{/if}
    · {task.kind} · created {task.created_at}
    · started {task.started_at ?? '—'} · finished {task.finished_at ?? '—'}
    {#if (task.round ?? 1) > 1} · round {task.round}{/if}
    {#if task.parent_id}
      · parent
      <a href="/task/{task.parent_id}" onclick={(e) => { if (navigate(`/task/${task.parent_id}`)) e.preventDefault(); }}>#{task.parent_id}</a>
    {/if}
    {#if task.kids && task.kids.length}
      · spawned
      {#each task.kids as k, i}
        {#if i > 0}, {/if}
        <a href="/task/{k}" onclick={(e) => { if (navigate(`/task/${k}`)) e.preventDefault(); }}>#{k}</a>
      {/each}
    {/if}
    {#if task.error}<br><span class="err">{task.error}</span>{/if}
  </p>
  {#if streaming}
    <TaskLog taskId={taskId} onDone={settle} onUsage={onUsage} />
  {:else}
    <div class="console">{log}</div>
  {/if}
{/if}
