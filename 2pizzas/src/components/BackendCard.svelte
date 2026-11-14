<script>
  import { getJson } from '../lib/api.mjs';
  import ProbeResult from './ProbeResult.svelte';

  let { b, ms, index, count, baked, piDef, onChanged } = $props();
  let editing = $state(false);
  let url = $state(b.url);
  let key = $state(b.apiKey ?? '');
  let model = $state(b.defaultModel ?? '');
  let probe = $state(null);
  let testing = $state(false);

  const notBaked = !baked.includes(b.id);
  const isPiDefault = b.id === piDef?.provider && b.defaultModel === piDef.id;

  const openEdit = () => {
    url = b.url;
    key = b.apiKey ?? '';
    model = b.defaultModel ?? '';
    editing = true;
  };

  const save = async () => {
    try {
      const r = await fetch(`/api/backends/${encodeURIComponent(b.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, apiKey: key, defaultModel: model }),
      });
      if (r.ok) { editing = false; onChanged(); }
      else alert((await r.json().catch(() => ({}))).error || `request failed: ${r.status}`);
    } catch (e) { alert(e.message); }
  };

  const move = async (dir) => {
    try {
      const r = await fetch(`/api/backends/${encodeURIComponent(b.id)}/${dir}`, { method: 'POST' });
      if (r.ok) onChanged();
      else alert((await r.json().catch(() => ({}))).error || `request failed: ${r.status}`);
    } catch (e) { alert(e.message); }
  };

  const del = async () => {
    if (!confirm(`remove backend ${b.id}?`)) return;
    try {
      const r = await fetch(`/api/backends/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      if (r.ok) onChanged();
      else alert((await r.json().catch(() => ({}))).error || `request failed: ${r.status}`);
    } catch (e) { alert(e.message); }
  };

  const test = async () => {
    testing = true;
    probe = null;
    try {
      probe = await getJson(`/api/backends/${encodeURIComponent(b.id)}/test`);
    } catch (e) {
      probe = { ok: false, error: e.message };
    }
    testing = false;
  };
</script>

<div class="card">
  <div class="l1">
    {b.id}
    <span class="meta">priority {b.priority}</span>
    {#if isPiDefault}<span class="badge badge-success">★ pi default</span>{/if}
    {#if b.apiKey}<span class="badge badge-info">keyed</span>{/if}
    {#if notBaked}<span class="badge badge-warn" title="not in the baked agent images — run ./setup.sh --rebuild; until then tasks cannot use this backend">not baked</span>{/if}
    <span style="flex:1"></span>
    <button class="btn" onclick={() => move('up')} disabled={index === 0}>↑</button>
    <button class="btn" onclick={() => move('down')} disabled={index === count - 1}>↓</button>
    <button class="btn" onclick={openEdit}>edit</button>
    <button class="btn" title="test reachability from 2pizzas (the container that calls it)" onclick={test}>test</button>
    <button class="btn danger" title="remove" disabled={count <= 1} onclick={del}>✕</button>
  </div>
  <div class="l2">{b.url}</div>
  {#if testing}<div class="btest"><span class="meta">testing from 2pizzas…</span></div>{/if}
  <ProbeResult result={probe} />
  {#if editing}
    <div class="bform">
      <input type="text" bind:value={url} style="flex:2;min-width:200px" placeholder="url">
      <input type="password" bind:value={key} style="flex:1;min-width:120px" placeholder="api key (empty = none)">
      <input type="text" bind:value={model} style="flex:1;min-width:140px" placeholder="default model (empty = auto)">
      <button class="btn primary" onclick={save}>save</button>
      <button class="btn" onclick={() => (editing = false)}>cancel</button>
    </div>
  {/if}
  <details style="margin-top:8px">
    <summary class="meta" style="cursor:pointer">{ms ? `${ms.length} models` : 'models'}</summary>
    <ul class="bmodels">
      {#if ms}
        {#each ms as m}
          <li>
            {m.id}
            {#if m.loaded}<span class="badge badge-success">loaded</span>
            {:else if m.reportsLoad}<span class="meta">idle</span>{/if}
            {#if b.defaultModel === m.id}<span class="meta">★ default</span>{/if}
          </li>
        {/each}
      {:else}
        <li class="meta">unreachable</li>
      {/if}
    </ul>
  </details>
</div>
