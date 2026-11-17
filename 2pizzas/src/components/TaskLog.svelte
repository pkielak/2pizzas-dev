<script>
  // Live SSE tail of a running task's log. The EventSource lives in a
  // $effect whose cleanup closes it — no dangling connections on
  // navigation (the old page leaked one per innerHTML swap).
  let { taskId, onDone, onUsage } = $props();
  let pre = $state(null);
  let stick = true; // follow the bottom unless the user scrolls up

  const onscroll = () => {
    if (pre) stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
  };

  $effect(() => {
    const es = new EventSource(`/task/${taskId}/stream`);
    // every (re)connect replays the whole log from the start — keep the DOM
    // in lockstep by clearing on open, so a dropped+reconnected stream
    // can't duplicate lines
    es.onopen = () => { if (pre) pre.textContent = ''; };
    es.onmessage = (e) => {
      if (pre) {
        // the filter's final usage marker — surface it live in the header
        const m = e.data.match(/^\[2pizzas\] usage: model=(\S+) tokens=(\d+)/);
        if (m) onUsage?.(m[1], +m[2]);
        pre.textContent += e.data + '\n';
        if (stick) pre.scrollTop = pre.scrollHeight;
      }
    };
    es.addEventListener('done', () => { es.close(); onDone?.(); });
    return () => es.close();
  });
</script>

<div class="console" bind:this={pre} onscroll={onscroll}>(waiting for output…)</div>
