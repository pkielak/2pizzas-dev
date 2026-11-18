<script>
  import { onMount } from 'svelte';
  import { getJson } from '../lib/api.mjs';
  import Loading from '../components/Loading.svelte';

  let data = $state(null);
  let err = $state('');

  onMount(() =>
    getJson('/api/funky')
      .then((d) => { data = d; err = ''; })
      .catch((e) => { err = e.message; }));

  const num = (s) => (s.value == null ? 'no data' : String(s.value) + (s.unit || ''));
</script>

{#if err}
  <p class="err">{err}</p>
{:else if !data}
  <Loading />
{:else}
  {#if data.err}
    <p class="err">{data.err}</p>
  {:else}
  <p class="meta">
    {data.repos ?? 0} repo{(data.repos ?? 0) === 1 ? '' : 's'} on the spit · roasted live from Gitea + the task DB
  </p>

  {#if data.vibes}
    <div class="vwrap">
      <div class="vbadge"><span class="vnum">{data.vibes.score}</span><span class="vlab">vibes score</span></div>
      <div class="vcap">{data.vibes.caption}</div>
    </div>
  {:else}
    <div class="vwrap">
      <div class="vbadge off"><span class="vnum">?</span><span class="vlab">vibes score</span></div>
      <div class="vcap">no data (yet) — nothing to certify</div>
    </div>
  {/if}

  <div class="fgrid">
    {#each (data.stats || []) as s (s.id)}
      <div class="fcard">
        <div class="fnum">{num(s)}</div>
        <div class="ftitle">{s.title}</div>
        {#if s.sub}<div class="fsub">{s.sub}</div>{/if}
        <div class="fcap">{s.caption}</div>
      </div>
    {/each}
  </div>

  {#if (data.failures || []).length}
    <p class="meta">degraded data: {(data.failures || []).join(' · ')}</p>
  {/if}
  {/if}
{/if}

<style>
  .vwrap{display:flex;align-items:center;gap:14px;margin:14px 0 20px}
  .vbadge{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-width:92px;padding:10px 14px;border:3px solid var(--line);background:var(--cheese);
    color:var(--cheese-ink);box-shadow:4px 4px 0 var(--sauce);
    animation:vpulse 1.6s ease-in-out infinite;
  }
  .vbadge.off{background:var(--surface);color:var(--muted);box-shadow:4px 4px 0 var(--shadow);animation:none}
  .vnum{font-size:30px;font-weight:900;line-height:1;letter-spacing:-.03em}
  .vlab{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
  .vcap{font-size:13px;font-weight:700;font-style:italic;color:var(--muted)}
  @keyframes vpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
  .fgrid{display:grid;grid-template-columns:1fr;gap:14px}
  @media (min-width:640px){
    .fgrid{grid-template-columns:1fr 1fr}
  }
  .fcard{border:2px solid var(--line);background:var(--surface);box-shadow:4px 4px 0 var(--shadow);padding:14px 16px}
  .fnum{font-size:34px;font-weight:900;letter-spacing:-.03em;line-height:1.05;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .ftitle{font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;margin-top:8px}
  .fsub{color:var(--muted);font-size:12.5px;margin-top:4px;line-height:1.5;word-break:break-word}
  .fcap{margin-top:10px;padding-top:8px;border-top:2px solid var(--track);color:var(--muted-2);font-size:12.5px;font-style:italic}
</style>
