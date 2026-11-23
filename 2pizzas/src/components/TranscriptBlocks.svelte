<script>
  import { hlText, giteaHref } from '../lib/hl.mjs';

  let { blocks } = $props();
</script>

{#each blocks as b (b)}
  {#if b.kind === 'user'}
    <div class="muser">{b.text}</div>
  {:else if b.kind === 'text'}
    <div class="mtext" class:streaming={!b.settled}>{@html hlText(b.text)}</div>
  {:else if b.kind === 'thinking'}
    <!-- transient (live-lane only) — collapsed by default, native <details> -->
    <details class="mthinking">
      <summary>thinking</summary>
      <div class="mthinking-body">{b.text}</div>
    </details>
  {:else if b.kind === 'tool'}
    <div class="mtool">⚙ <b>{b.name}</b> <code>{b.arg}</code></div>
  {:else if b.kind === 'ref'}
    <div class="mref">🔗 <b>{b.refKind} #{b.number}</b> · <a href={giteaHref(b.url)} target="_blank" rel="noopener">{b.url}</a></div>
  {:else if b.kind === 'settle'}
    <div class="msettle">{b.text}</div>
  {:else if b.kind === 'compacted'}
    <div class="mcompacted">— context compacted —</div>
  {:else if b.kind === 'error'}
    <div class="merr">error: {b.message}</div>
  {:else if b.kind === 'console'}
    <!-- plain console line (pre-transcript task logs) — dim monospace -->
    <div class="mconsole">{b.text}</div>
  {/if}
{/each}
