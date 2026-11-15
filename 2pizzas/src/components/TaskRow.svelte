<script>
  import { navigate } from '../lib/router.mjs';
  import { ctxText } from '../lib/fmt.mjs';

  // one task list item — shared by the /tasks list and the home page
  let { t } = $props();
</script>

<a
  class="item"
  href="/task/{t.id}"
  onclick={(e) => { if (navigate(`/task/${t.id}`)) e.preventDefault(); }}
>
  <div class="l1"><span class={t.status}>{t.status}</span> <span>#{t.id}</span> {t.repo}#{t.issue}</div>
  <div class="l2">
    @{t.agent}
    {#if t.kind === 'agent-review' || t.kind === 'rework'} · {t.kind}{/if}
    {#if (t.round ?? 1) > 1} · round {t.round}{/if}
    {#if t.parent_id} · from #{t.parent_id}{/if}
    {#if t.model} · <span class="model">{t.model}</span>{/if}
    {#if ctxText(t)} · <span class="ctx">{ctxText(t)}</span>{/if}
    · {t.created_at}
  </div>
  {#if t.error}<div class="err">{t.error}</div>{/if}
</a>
