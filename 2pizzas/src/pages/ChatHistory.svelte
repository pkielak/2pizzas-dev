<script>
  import { onMount } from 'svelte';
  import { authUrl } from '../lib/chatauth.mjs';
  import { getJson } from '../lib/api.mjs';
  import { parseLine } from '../lib/hl.mjs';
  import EndedChat from '../components/EndedChat.svelte';

  // /chat/r<rowid> — read-only transcript of a dead session (rowid is the
  // only globally-unique session key; bare ids shadow older runs)
  let { rowid } = $props();
  let hist = $state(null);
  let err = $state('');

  onMount(async () => {
    try {
      const h = await getJson(authUrl(`/api/chat/r${rowid}/history`));
      hist = { session: h.session, blocks: (h.lines || []).map(parseLine).filter(Boolean) };
    } catch (e) { err = e.message; }
  });
</script>

{#if err}
  <p class="err">{err}</p>
{:else if hist}
  <EndedChat session={hist.session} blocks={hist.blocks} />
{:else}
  <p class="meta">loading…</p>
{/if}
