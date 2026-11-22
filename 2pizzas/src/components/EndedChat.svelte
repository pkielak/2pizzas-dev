<script>
  import { fmtTok } from '../lib/fmt.mjs';
  import { navigate } from '../lib/router.mjs';
  import TranscriptBlocks from './TranscriptBlocks.svelte';

  // read-only transcript of an ended session — shared by the /chat/r<rowid>
  // route and the live view's dead-session handover
  let { session, blocks, logMissing, logError, onContinue } = $props();
</script>

<div class="chatapp">
  <div class="chathead">
    <a class="back" href="/chat" onclick={(e) => { if (navigate('/chat')) e.preventDefault(); }}>←</a>
    <span class="chid">#{session.id}</span>
    <span class="badge">ended</span>
    <span class="meta">
      {session.end_reason ?? ''} · {session.messages} msg
      {#if session.tokens} · <span class="ctx">{fmtTok(session.tokens)} tok ctx</span>{/if}
      · {session.created_at?.slice(5, 16) ?? ''} → {session.ended_at?.slice(11, 19) ?? ''}
    </span>
  </div>
  <div id="msgs">
    {#if blocks.length}
      {#if logError}
        <div class="merr">transcript incomplete — {logError}</div>
      {/if}
      <TranscriptBlocks blocks={blocks} />
    {:else if logMissing || logError}
      <div class="merr">transcript unavailable — {logError || 'log file missing'}</div>
    {:else}
      <div class="msettle">empty session</div>
    {/if}
  </div>
  <div class="chatin endednote">
    <span class="meta">
      this session has ended — its transcript is preserved.
      {#if session.session_dir && onContinue}
        <button class="grantbtn" onclick={onContinue}>continue this session</button>
      {/if}
      <a href="/chat" onclick={(e) => { if (navigate('/chat')) e.preventDefault(); }}>start a new chat</a>
    </span>
  </div>
</div>
