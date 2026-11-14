<script>
  let { result } = $props();
</script>

{#if result}
  <div class="btest">
    {#if result.ok}
      <span class="badge badge-success">reachable</span> {result.count ?? 0} model(s) in {result.ms}ms:
      {#each result.models ?? [] as m}<code>{m}</code>{/each}
    {:else}
      <span class="badge badge-warn">NOT reachable</span> {result.error ?? ''}
      {#if result.hint}<br><em>💡 {result.hint}</em>{/if}
    {/if}
  </div>
{/if}
