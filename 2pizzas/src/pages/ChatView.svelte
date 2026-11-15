<script>
  import { onMount } from 'svelte';
  import { getJson, postJson } from '../lib/api.mjs';
  import { authUrl } from '../lib/chatauth.mjs';
  import { navigate } from '../lib/router.mjs';
  import { fmtTok } from '../lib/fmt.mjs';
  import { parseLine } from '../lib/hl.mjs';
  import TranscriptBlocks from '../components/TranscriptBlocks.svelte';
  import EndedChat from '../components/EndedChat.svelte';
  import Loading from '../components/Loading.svelte';

  // One component for both modes: a LIVE session (SSE stream + input) and,
  // if the session dies (idle timeout / kill / container death), the
  // read-only transcript from its log — no reload, no redirect.
  let { sessionId } = $props();
  let session = $state(null); // live session json; null → dead/unknown
  let hist = $state(null); // dead-session transcript {session, blocks}
  let blocks = $state([]);
  let status = $state('');
  let ctx = $state({ t: 0, w: 0 });
  let ended = $state(false);
  let err = $state('');
  let box = $state(null);
  let ta = $state(null);
  let draft = $state('');
  let stick = true; // follow the bottom unless the user scrolls up

  const scrollDown = () => { if (box && stick) box.scrollTop = box.scrollHeight; };
  const onscroll = () => { if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60; };

  // the delta-built (un-settled) text block, if the last block is one
  const curText = () => {
    const last = blocks[blocks.length - 1];
    return last && last.kind === 'text' && !last.settled ? last : null;
  };

  const handle = (line) => {
    let e;
    try { e = JSON.parse(line); }
    catch {
      // non-JSON line: only the server's [2pizzas] markers reach here
      if (line.startsWith('[2pizzas]')) { blocks.push({ kind: 'settle', text: line }); scrollDown(); }
      return;
    }
    // transcript events (user_message, text_block, tool_call, settle,
    // gitea_ref, compacted, error) are REPLAYED on (re)connect — they
    // rebuild the full conversation; live events (text_delta, thinking,
    // working, tool_end, auto_retry, compaction, ctx) are not replayed —
    // they only drive the status line + incremental text
    if (e.type === 'user_message') {
      blocks.push({ kind: 'user', text: e.message });
    } else if (e.type === 'text_delta') {
      let t = curText();
      if (!t) {
        if (!e.delta || !e.delta.trim()) return; // don't start a block for whitespace-only deltas
        t = { kind: 'text', text: '', settled: false };
        blocks.push(t);
      }
      t.text += e.delta;
      status = 'writing…';
    } else if (e.type === 'text_block') {
      // settled block: finalize the delta-built block (same text — a visual
      // no-op) and mark it settled so the next live delta starts a FRESH
      // block; replay clients get it whole
      let t = curText();
      if (!t) t = { kind: 'text', text: '', settled: false };
      t.text = e.text;
      t.settled = true;
    } else if (e.type === 'gitea_ref') {
      blocks.push({ kind: 'ref', refKind: e.kind, number: e.number, url: e.url });
    } else if (e.type === 'tool_call') {
      blocks.push({ kind: 'tool', name: e.name, arg: String(e.arg).slice(0, 200) });
      status = `running ${e.name}…`;
    } else if (e.type === 'tool_end') status = 'thinking…';
    else if (e.type === 'thinking') status = 'thinking…';
    else if (e.type === 'working') status = 'working…';
    else if (e.type === 'settle') { status = ''; blocks.push({ kind: 'settle', text: 'settled' }); }
    else if (e.type === 'auto_retry') status = `retrying (${e.attempt}/${e.max})…`;
    else if (e.type === 'compaction') status = 'compacting context…';
    else if (e.type === 'compacted') blocks.push({ kind: 'compacted' });
    else if (e.type === 'ctx') ctx = { t: e.tokens, w: e.window };
    else if (e.type === 'error') { status = ''; blocks.push({ kind: 'error', message: e.message }); }
    scrollDown();
  };

  // the session's SSE stream. Lives in a $effect whose cleanup closes the
  // EventSource — no dangling connections on navigation.
  $effect(() => {
    if (!session) return;
    const es = new EventSource(authUrl(`/chat/${sessionId}/stream`));
    // every (re)connect replays the whole stream from the server — clear
    // the blocks so the replay rebuilds them in lockstep
    es.onopen = () => { blocks = []; };
    es.onmessage = (ev) => handle(ev.data);
    es.onerror = () => {
      // a dead session's stream 404s and EventSource would retry it FOREVER
      // — detect it and hand over to the read-only transcript
      fetch(authUrl(`/api/chat/${sessionId}`))
        .then((r) => { if (r.status === 404) loadDead(); })
        .catch(() => {}); // network blip — EventSource keeps retrying
    };
    // session ended (idle timeout / killed / container died): the server
    // sends the [2pizzas] chat closed line JUST BEFORE this event, so the
    // reason is already on screen — freeze the UI in place
    es.addEventListener('done', () => {
      ended = true;
      es.close();
      status = '';
    });
    return () => es.close();
  });

  const loadDead = async () => {
    session = null;
    try {
      const h = await getJson(authUrl(`/api/chat/${sessionId}/history`));
      hist = { session: h.session, blocks: (h.lines || []).map(parseLine).filter(Boolean) };
    } catch (e) { err = e.message; }
  };

  onMount(async () => {
    try {
      session = await getJson(authUrl(`/api/chat/${sessionId}`));
      ctx = { t: 0, w: session.modelCtx || 0 };
    } catch (e) {
      if (!String(e.message).includes('404')) { err = e.message; return; }
      await loadDead();
    }
  });

  const sendMsg = async () => {
    const t = draft.trim();
    if (!t) return;
    draft = '';
    status = 'sending…'; // the bubble arrives via the stream echo
    try {
      await postJson(authUrl(`/api/chat/${sessionId}/message`), { message: t });
    } catch (e) {
      blocks.push({ kind: 'error', message: e.message });
      status = '';
      scrollDown();
    }
  };

  const stop = () => postJson(authUrl(`/api/chat/${sessionId}/abort`), {}).catch(() => {});

  const close = async (e) => {
    e.preventDefault();
    await fetch(authUrl(`/api/chat/${sessionId}`), { method: 'DELETE' }).catch(() => {});
    navigate('/chat'); // the done banner fires on the way out
  };

  const resume = (rowid) =>
    postJson(authUrl('/api/chat'), { agent: 'pi', resumeFrom: rowid })
      .then((j) => { if (j.id) navigate(`/chat/${j.id}`); })
      .catch((e) => alert(e.message));
</script>

{#if err}
  <p class="err">{err}</p>
{:else if hist}
  <EndedChat session={hist.session} blocks={hist.blocks} onContinue={() => resume(hist.session.rowid)} />
{:else if !session}
  <Loading label="connecting" />
{:else}
  <div class="chatapp">
    <div class="chathead">
      <a class="back" href="/chat" onclick={(e) => { if (navigate('/chat')) e.preventDefault(); }}>←</a>
      <span class="chid">#{sessionId}</span>
      <span class="meta" class:live={!!status}>{status || (ended ? 'ended' : 'idle')}</span>
      <a class="back chclose" href="#" onclick={close}>close</a>
    </div>
    <div id="msgs" bind:this={box} onscroll={onscroll}>
      <TranscriptBlocks blocks={blocks} />
      {#if status}<div class="mstatus">{status}</div>{/if}
      {#if ended}
        <div class="mend">session ended — <a href="/chat" onclick={(e) => { if (navigate('/chat')) e.preventDefault(); }}>back to chats</a> (transcript kept under past sessions)</div>
      {/if}
    </div>
    <div class="chatin" class:endednote={ended}>
      <textarea
        bind:this={ta}
        bind:value={draft}
        rows="2"
        disabled={ended}
        placeholder="message {session.agent}… (Enter sends, Shift+Enter newline)"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } }}
      ></textarea>
      <div class="chatbtns">
        <button id="send" disabled={ended} onclick={sendMsg}><span class="ic">▷</span>send</button>
        <button id="stop" disabled={ended} onclick={stop}><span class="ic">□</span>stop</button>
      </div>
    </div>
    <div class="meta ctxline">
      {#if session.model}<span class="model">{session.model}</span>{/if}
      {#if ctx.w} · <span class="ctx">{fmtTok(ctx.t)}/{fmtTok(ctx.w)} tok ({Math.min(100, Math.round((ctx.t / ctx.w) * 100))}%)</span>{/if}
    </div>
  </div>
{/if}
