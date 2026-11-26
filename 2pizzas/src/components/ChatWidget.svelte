<script>
  import { onMount, onDestroy } from 'svelte';
  import { getJson, postJson } from '../lib/api.mjs';
  import { authUrl } from '../lib/chatauth.mjs';
  import { navigate } from '../lib/router.mjs';
  import { pushTranscriptLine } from '../lib/transcript.mjs';
  import TranscriptBlocks from './TranscriptBlocks.svelte';

  // Compact live view of the PERSISTENT (pinned) chat — always-on: the
  // backend auto-creates it at startup and resumes the conversation across
  // restarts. `full` renders it inside the mobile full-screen sheet (fills
  // it); the default compact mode lives in the right sidebar.
  let { full = false } = $props();

  let sess = $state(null); // GET /api/chat/persistent → {id, rowid, live, …}
  let blocks = $state([]);
  let status = $state('');
  let wait = $state(''); // transient note while no stream is open
  let draft = $state('');
  let box = $state(null);
  let stick = true; // follow the bottom unless the user scrolls up

  const scrollDown = () => { if (box && stick) box.scrollTop = box.scrollHeight; };
  const onscroll = () => { if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60; };

  // one line → transcript blocks (the same shared accumulator the full chat
  // view uses). The replay on every (re)connect rebuilds the blocks in
  // lockstep — cap the in-memory list so a long-lived session stays light.
  const handle = (line) => {
    pushTranscriptLine(blocks, line, { onStatus: (s) => { status = s; } });
    if (blocks.length > 400) blocks.splice(0, blocks.length - 400);
    scrollDown();
  };

  let es = null;
  let destroyed = false;
  const closeStream = () => { if (es) { es.close(); es = null; } };
  // the widget unmounts on navigation to a full-height app route (and the
  // sheet's instance on close) — no dangling SSE client / reconnect timer
  onDestroy(() => { destroyed = true; closeStream(); });

  const openStream = (id) => {
    closeStream();
    es = new EventSource(authUrl(`/chat/${id}/stream`));
    // every (re)connect replays the whole stream — clear the blocks so the
    // replay rebuilds them in lockstep
    es.onopen = () => { blocks = []; wait = ''; };
    es.onmessage = (ev) => handle(ev.data);
    es.addEventListener('done', () => { closeStream(); reconnect(); });
    // a dead session's stream 404s (dispatcher restart, chat killed) and
    // EventSource would retry it forever — re-resolve the persistent id
    es.onerror = () => { closeStream(); reconnect(); };
  };

  let resolving = false;
  const reconnect = () => {
    wait = 'reconnecting…';
    fetchPersistent();
  };

  const fetchPersistent = async () => {
    if (resolving) return;
    resolving = true;
    try {
      const p = await getJson(authUrl('/api/chat/persistent'));
      if (destroyed) return;
      if (!p || !p.live) {
        // boot window (startup's auto-create still running) — poll. Drop any
        // stale live session: with sess still live, the input stays enabled
        // and POSTs to a dead id (error bubble), and the header keeps
        // showing the dead #id while "starting…" is displayed
        sess = null;
        wait = 'starting…';
        setTimeout(fetchPersistent, 3000);
        return;
      }
      sess = p;
      openStream(p.id);
    } catch {
      if (!destroyed) wait = 'unavailable';
      if (!destroyed) setTimeout(fetchPersistent, 5000);
    } finally {
      resolving = false;
    }
  };

  onMount(fetchPersistent);

  const send = async () => {
    const t = draft.trim();
    if (!t || !sess?.live) return;
    draft = '';
    status = 'sending…'; // the echo bubble arrives via the stream
    try {
      await postJson(authUrl(`/api/chat/${sess.id}/message`), { message: t });
    } catch (e) {
      blocks.push({ kind: 'error', message: e.message });
      status = '';
      scrollDown();
    }
  };

  const expandHref = $derived(sess?.live ? `/chat/${sess.id}` : '/chat');
</script>

<div class="chatwidget" class:full={full}>
  <div class="cwhead">
    <span class="cwt">chat</span>
    {#if sess?.live}<span class="cwid">#{sess.id}</span>{/if}
    <span class="cwstatus" class:busy={!!status}>{status || (sess?.live ? '' : (wait || '…'))}</span>
    <a class="cwfull" href={expandHref}
       onclick={(e) => { if (navigate(e.currentTarget.getAttribute('href'))) e.preventDefault(); }}>expand ↗</a>
  </div>
  <div class="cwbox" bind:this={box} onscroll={onscroll}>
    {#if blocks.length}
      <!-- compact mode renders only the tail — the box is the scroll area -->
      <TranscriptBlocks blocks={blocks.slice(full ? 0 : -50)} />
    {:else}
      <div class="cwempty">{wait || 'starting…'}</div>
    {/if}
    {#if status}<div class="mstatus">{status}</div>{/if}
  </div>
  <form class="cwinput" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <input type="text" bind:value={draft} placeholder="message chat…" disabled={!sess?.live} />
    <button type="submit" disabled={!sess?.live || !draft.trim()}>send</button>
  </form>
</div>
