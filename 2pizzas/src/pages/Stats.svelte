<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { fmtTok } from '../lib/fmt.mjs';

  let data = $state(null);
  let err = $state('');

  const load = () =>
    getJson('/api/stats')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  // refetch this page's JSON on any live event — no HTML swap, focus-safe
  $effect(() => { if ($live) load(); });

  const tk = (v) => (v == null ? '—' : fmtTok(Math.round(v)));
</script>

{#if err}
  <p class="err">{err}</p>
{:else if data === null}
  <p class="meta">loading…</p>
{:else if !data.total}
  <p class="meta">no tasks yet</p>
{:else}
  <p class="meta">
    {data.total} tasks ·
    <span class="success">{data.st.success ?? 0} success</span> ·
    <span class="failure">{data.st.failure ?? 0} failed</span>
    {#if data.st.running} · <span class="running">{data.st.running} running</span>{/if}
    {#if data.st.queued} · <span class="queued">{data.st.queued} queued</span>{/if}
  </p>

  <h2>tokens</h2>
  <div class="list">
    <div class="item">
      <div class="l1">{tk(data.tok.s)} total</div>
      <div class="l2">{data.tok.n} tasks measured · avg {tk(data.tok.a)} · max {tk(data.tok.m)} per task</div>
    </div>
  </div>

  <h2>by model</h2>
  <div class="list">
    {#each data.models as m}
      <div class="item">
        <div class="l1">{m.model} <span class="meta">{m.n} tasks{#if m.ctx} · ctx {fmtTok(m.ctx)}{/if}</span></div>
        <div class="l2">{m.tok ? `${tk(m.tok)} tok · avg ${tk(m.avgtok)}` : 'no token data yet'}</div>
      </div>
    {:else}
      <div class="item"><div class="l2">no model data yet</div></div>
    {/each}
  </div>

  <h2>by agent</h2>
  <div class="list">
    {#each data.agents as a}
      <div class="item">
        <div class="l1">@{a.agent} <span class="meta">{a.n} tasks · {a.ok ?? 0} ok</span></div>
        <div class="l2">{a.tok ? `${tk(a.tok)} tok · avg ${tk(a.avgtok)}` : 'no token data yet'}</div>
      </div>
    {/each}
  </div>

  <h2>last 14 days</h2>
  <div class="list">
    {#each data.daily as d}
      <div class="item">
        <div class="l1">
          {d.d}
          <span class="meta">
            {d.n} tasks · {d.ok ?? 0} ok
            {#if d.bad} · <span class="err">{d.bad} failed</span>{/if}
            {#if d.tok} · {tk(d.tok)} tok{/if}
          </span>
        </div>
        <div class="bar"><i style="width:{Math.round((d.n / data.maxDay) * 100)}%"></i></div>
      </div>
    {:else}
      <div class="item"><div class="l2">nothing in the last 14 days</div></div>
    {/each}
  </div>
{/if}
