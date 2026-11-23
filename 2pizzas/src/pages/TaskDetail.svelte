<script>
  // Same chrome as the chat view (ChatView.svelte): .chatapp layout,
  // .chathead, scrollable #msgs box rendering TranscriptBlocks, .mstatus
  // line, .meta ctxline footer. The task log is a transcript — the filters
  // (assets/output_filter.mjs, opencode_filter.mjs) emit the SAME compact
  // chat events as chat.mjs's piLine, so the live SSE tail accumulates
  // blocks with the shared pushTranscriptLine() and the settled log is
  // parsed with parseTaskLine() (parseLine + plain-text fallback for
  // pre-transcript logs).
  import { getJson, postJson } from '../lib/api.mjs';
  import { navigate } from '../lib/router.mjs';
  import { ctxText, fmtTok } from '../lib/fmt.mjs';
  import { parseTaskLog } from '../lib/hl.mjs';
  import { pushTranscriptLine } from '../lib/transcript.mjs';
  import TranscriptBlocks from '../components/TranscriptBlocks.svelte';
  import Loading from '../components/Loading.svelte';

  let { taskId } = $props();
  let task = $state(null);
  let blocks = $state([]);
  let status = $state(''); // live status line (working / writing / running X…)
  let streaming = $state(false);
  let err = $state('');
  let box = $state(null);
  // live token readout parsed from the streaming log (the filter emits a
  // `[2pizzas] usage:` line per turn, so this climbs as the run progresses)
  let liveTokens = $state(null);
  let stick = true; // follow the bottom unless the user scrolls up

  const scrollDown = () => { if (box && stick) box.scrollTop = box.scrollHeight; };
  const onscroll = () => { if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60; };

  const load = (withLog = false) =>
    getJson(`/api/task/${taskId}`)
      .then((t) => {
        task = t;
        streaming = ['queued', 'running'].includes(t.status);
        liveTokens = null; // a settled task carries its own stored tokens
        status = '';
        if (withLog)
          return getJson(`/api/task/${taskId}/log`).then((d) => {
            blocks = parseTaskLog(d.log);
            scrollDown();
          });
      })
      .catch((e) => { err = e.message; });

  load(true);

  // the task's SSE stream (running only). Lives in a $effect whose cleanup
  // closes the EventSource — no dangling connections on navigation.
  $effect(() => {
    if (!streaming) return;
    const es = new EventSource(`/task/${taskId}/stream`);
    // every (re)connect replays the whole log from the start — clear the
    // blocks so the replay rebuilds them in lockstep
    es.onopen = () => { blocks = []; };
    es.onmessage = (ev) => {
      pushTranscriptLine(blocks, ev.data, {
        onStatus: (s) => { status = s; },
        onUsage: (_model, tokens) => { liveTokens = tokens; },
      });
      scrollDown();
    };
    // the stream reported the task settled → swap to the static (parsed) log
    es.addEventListener('done', () => { es.close(); load(true); });
    return () => es.close();
  });

  const stop = (e) => {
    e.preventDefault();
    postJson(`/api/tasks/${taskId}/stop`, {}).then(() => load(true)).catch((er) => { err = er.message; });
  };
  const retry = (e) => {
    e.preventDefault();
    postJson(`/api/tasks/${taskId}/retry`, {}).then((d) => {
      if (d.newTaskId) navigate(`/task/${d.newTaskId}`); else load(true);
    }).catch((er) => { err = er.message; });
  };
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !task}
  <Loading />
{:else}
  <div class="chatapp">
    <div class="chathead">
      <a class="back" href="/tasks" onclick={(e) => { if (navigate('/tasks')) e.preventDefault(); }}>←</a>
      <span class="chid">#{taskId}</span>
      <span class={task.status}>{task.status}</span>
      {#if streaming}<span class="live">live</span>{/if}
      <span class="meta" class:live={!!status}>{status || (streaming ? 'running' : '')}</span>
      {#if streaming && liveTokens != null}<span class="livetok">≈ {fmtTok(liveTokens)} tok</span>{/if}
      {#if streaming}
        <a class="back chclose" href="#" onclick={stop}>stop</a>
      {:else if task.status === 'failure' || task.status === 'canceled'}
        <a class="back chclose" href="#" onclick={retry}>retry</a>
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
    <div id="msgs" bind:this={box} onscroll={onscroll}>
      {#if !blocks.length && !status}<div class="msettle">waiting for output…</div>{/if}
      <TranscriptBlocks blocks={blocks} />
      {#if status}<div class="mstatus" key={status}>{status}</div>{/if}
    </div>
    <div class="meta ctxline">
      {#if task.model}<span class="model">{task.model}</span>{/if}
      {#if streaming && liveTokens != null}
        · <span class="ctx">≈ {fmtTok(liveTokens)} tok</span>
      {:else if ctxText(task)}
        · <span class="ctx">{ctxText(task)}</span>
      {/if}
    </div>
  </div>
{/if}
