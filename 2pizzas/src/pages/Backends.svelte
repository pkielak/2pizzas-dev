<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson, postJson } from '../lib/api.mjs';
  import BackendCard from '../components/BackendCard.svelte';
  import ProbeResult from '../components/ProbeResult.svelte';

  let data = $state(null);
  let err = $state('');

  const load = () =>
    getJson('/api/backends/full')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  $effect(() => { if ($live) load(); });

  // add form
  let id = $state('');
  let url = $state('');
  let key = $state('');
  let model = $state('');
  let probe = $state(null);
  let testing = $state(false);

  const add = async () => {
    try {
      await postJson('/api/backends', { id, url, apiKey: key, defaultModel: model });
      id = url = key = model = '';
      probe = null;
      load();
    } catch (e) { alert(e.message); }
  };

  const probeAdd = async () => {
    testing = true;
    probe = null;
    try {
      probe = await postJson('/api/backends/test', { url, apiKey: key });
    } catch (e) {
      probe = { ok: false, error: e.message };
    }
    testing = false;
  };
</script>

<style>
  .bform{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
  .bmodels{margin:8px 0 0 18px;padding:0;list-style:none}
  .btest{margin-top:8px;font-size:12.5px;line-height:1.5;word-break:break-word}
  .btest .badge{margin-right:4px}
  .btable{width:100%;margin-top:8px;border-collapse:collapse}
  .btable th,.btable td{text-align:left;padding:5px 8px;border-top:1px solid var(--line);font-size:13px}
  /* small screens: stack the forms, full-width inputs */
  @media (max-width:720px){
    .bform{flex-direction:column;align-items:stretch}
    .bform input{width:100%;min-width:0}
    .bform .btn{width:100%}
  }
</style>

{#if err}
  <p class="err">{err}</p>
{:else if !data}
  <p class="meta">loading…</p>
{:else}
  <h2>selection</h2>
  <div class="card">
    <div class="l1">next task will use <code>{data.picked.provider}/{data.picked.id}</code></div>
    <div class="l2">{data.picked.source}</div>
  </div>

  <h2>backends</h2>
  {#each data.backends as b, i (b.id)}
    <BackendCard b={b} ms={data.models[i]} index={i} count={data.backends.length} baked={data.baked} piDef={data.piDefault} onChanged={load} />
  {/each}

  <h2>add a backend</h2>
  <div class="card">
    <div class="l2" style="margin-top:0">any OpenAI-compatible /v1 endpoint — local llama.cpp, vLLM, Ollama, OpenRouter, …</div>
    <div class="bform">
      <input type="text" bind:value={id} style="flex:1;min-width:120px" placeholder="id (e.g. openrouter)">
      <input type="text" bind:value={url} style="flex:2;min-width:200px" placeholder="url (e.g. https://openrouter.ai/api)">
      <input type="password" bind:value={key} style="flex:1;min-width:120px" placeholder="api key (empty if none)">
      <input type="text" bind:value={model} style="flex:1;min-width:140px" placeholder="default model (empty = first listed)">
      <button class="btn" title="test this url from 2pizzas before adding" onclick={probeAdd}>test url</button>
      <button class="btn primary" onclick={add}>add</button>
    </div>
    {#if testing}<div class="btest"><span class="meta">testing from 2pizzas…</span></div>{/if}
    <ProbeResult result={probe} />
    <div class="l2">
      Changes apply to the <em>next</em> task immediately (2pizzas re-reads <code>inference.json</code>).
      A backend is only usable <em>inside the agents</em> after it is baked into the images —
      <code>./setup.sh --rebuild</code> — until then it shows a <span class="badge badge-warn">not baked</span> badge.
    </div>
  </div>

  <h2>agents</h2>
  <div class="card">
    <div class="l2" style="margin-top:0">
      images: {data.images.pi} · {data.images.opencode} — model lists are baked from <code>inference.json</code> at build time
    </div>
    <table class="btable">
      <thead><tr><th>agent</th><th>model config</th><th>default</th></tr></thead>
      <tbody>
        <tr>
          <td>pi</td><td>models.json (baked)</td>
          <td>{#if data.piDefault}<code>{data.piDefault.provider}/{data.piDefault.id}</code>{:else}—{/if}</td>
        </tr>
        <tr>
          <td>opencode</td><td>opencode.json (baked)</td>
          <td><code>{data.backends[0]?.id}/{data.models[0]?.[0]?.id ?? '—'}</code></td>
        </tr>
      </tbody>
    </table>
  </div>
{/if}
