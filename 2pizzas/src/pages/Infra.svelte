<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson } from '../lib/api.mjs';
  import { navigate } from '../lib/router.mjs';
  import Loading from '../components/Loading.svelte';

  let d = $state(null);
  let err = $state('');

  const load = () =>
    getJson('/api/infra')
      .then((x) => { d = x; err = ''; })
      .catch((e) => { err = e.message; });

  onMount(load);
  $effect(() => { if ($live) load(); });

  const busy = (a) => d?.busy?.includes(a) ?? false;
  const chatN = d?.docker?.chatN ?? null;
  const giteaUrl = () => location.protocol + '//' + location.hostname + ':3000';

  const blocks = $derived(d ? [
    // AGENTS (top row)
    { x: 70, y: 40, w: 160, h: 100, title: '@' + d.agents.pi, lines: ['agent-sandbox:pi', busy('pi') ? 'task in flight' : 'idle'], ok: busy('pi') ? true : null },
    { x: 303, y: 40, w: 160, h: 100, title: '@' + d.agents.opencode, lines: ['agent-sandbox:opencode', busy('opencode') ? 'task in flight' : 'idle'], ok: busy('opencode') ? true : null },
    { x: 537, y: 40, w: 160, h: 100, title: '@' + d.agents.review, lines: ['agent-sandbox:review', busy('review') ? 'task in flight' : 'read-only · idle', 'gitleaks + semgrep'], ok: busy('review') ? true : null },
    { x: 770, y: 40, w: 160, h: 100, title: 'chat containers', lines: ['long-lived runsc', chatN === null ? 'chat user' : `chat user · ${chatN} active`], ok: chatN === null ? null : chatN > 0 },
    // FOUNDATIONS (middle row)
    { x: 30, y: 250, w: 240, h: 110, title: 'Gitea', lines: ['server :3000 · postgres db', `${d.managedN} managed repo${d.managedN === 1 ? '' : 's'} · agent + chat users`], ok: d.docker ? d.docker.gitea : null, href: giteaUrl() },
    { x: 380, y: 250, w: 240, h: 110, title: '2pizzas', lines: ['dispatcher :3001 · sqlite queue', 'webhook · task runner · chat'], ok: d.docker?.dispatcher ?? null, href: '/tasks' },
    {
      x: 730, y: 250, w: 240, h: 110,
      title: d.backend.id + (d.backend.n > 1 ? ` +${d.backend.n - 1}` : ''),
      lines: [
        d.backend.url + (d.backend.n > 1 ? ` · ${d.backend.n} backends` : ''),
        d.backend.reachable ? (d.backend.loaded.length ? `loaded: ${d.backend.loaded.join(', ')}` : 'reachable') : 'unreachable',
      ],
      ok: d.backend.reachable,
    },
    // RUNNERS / SERVERS (bottom row)
    { x: 150, y: 460, w: 200, h: 100, title: 'my-runner', lines: ['label: ubuntu-latest', 'runc · CI+security gate'], ok: d.docker?.runner ?? null },
    { x: 400, y: 460, w: 200, h: 100, title: 'android-runner', lines: ['label: android', 'gitea-android:latest image'], ok: d.docker?.androidRunner ?? null },
    {
      x: 650, y: 460, w: 200, h: 100, title: 'pages',
      lines: [
        d.pagesSites.length ? d.pagesSites.map((s) => `${s.repo} :${s.port}`).join(' · ') : 'no sites (PAGES_SITES)',
        'serves gh-pages branches',
      ],
      ok: d.docker?.pages ?? null,
    },
  ] : []);

  // ── zoom / pan ────────────────────────────────────────────────────────
  let svg = $state(null);
  let view = [0, 0, 1000, 570];
  const FULL = [0, 0, 1000, 570];
  const apply = () => svg?.setAttribute('viewBox', view.join(' '));
  const clampZoom = (nv) => (nv[2] < FULL[2] / 10 || nv[2] > FULL[2] * 4 ? null : nv);
  const svgPoint = (e) => {
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  const zoomAt = (f, px, py) => {
    const nv = [px - (px - view[0]) * f, py - (py - view[1]) * f, view[2] * f, view[3] * f];
    if (clampZoom(nv)) { view = nv; apply(); }
  };
  const zoomIn = () => zoomAt(1 / 1.25, view[0] + view[2] / 2, view[1] + view[3] / 2);
  const zoomOut = () => zoomAt(1.25, view[0] + view[2] / 2, view[1] + view[3] / 2);
  const zoomReset = () => { view = FULL.slice(); apply(); };

  onMount(() => {
    if (!svg) return;
    const wheel = (e) => { e.preventDefault(); const p = svgPoint(e); zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y); };
    const dblclick = (e) => { const p = svgPoint(e); zoomAt(1 / 1.5, p.x, p.y); };
    // touch: one finger pans, two fingers pinch-zoom (mobile has no wheel/dblclick)
    let touch = null;
    const pair = (e) => {
      const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
      return { d: Math.hypot(dx, dy), mx: (e.touches[0].clientX + e.touches[1].clientX) / 2, my: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    };
    const touchstart = (e) => {
      if (e.target.closest('a')) return;
      if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: view.slice() };
      else if (e.touches.length === 2) touch = pair(e);
    };
    const touchmove = (e) => {
      if (!touch) return;
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      if (e.touches.length === 2) {
        const p = pair(e);
        if (touch.d) { // pinch: zoom around midpoint + pan with it
          const sp = svgPoint({ clientX: p.mx, clientY: p.my });
          zoomAt(p.d / touch.d, sp.x, sp.y);
          view[0] -= (p.mx - touch.mx) / ctm.a;
          view[1] -= (p.my - touch.my) / ctm.d;
          apply();
        }
        touch = p;
      } else {
        view[0] = touch.v[0] - (e.touches[0].clientX - touch.x) / ctm.a;
        view[1] = touch.v[1] - (e.touches[0].clientY - touch.y) / ctm.d;
        apply();
      }
    };
    const touchend = (e) => {
      if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: view.slice() };
      else if (e.touches.length === 0) touch = null;
    };
    let drag = null;
    const mousedown = (e) => {
      if (e.button !== 0 || e.target.closest('a')) return;
      drag = { x: e.clientX, y: e.clientY, v: view.slice() };
      svg.style.cursor = 'grabbing';
    };
    const mousemove = (e) => {
      if (!drag) return;
      const ctm = svg.getScreenCTM();
      view[0] = drag.v[0] - (e.clientX - drag.x) / ctm.a;
      view[1] = drag.v[1] - (e.clientY - drag.y) / ctm.d;
      apply();
    };
    const mouseup = () => { drag = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('wheel', wheel, { passive: false });
    svg.addEventListener('dblclick', dblclick);
    svg.addEventListener('touchstart', touchstart, { passive: true });
    svg.addEventListener('touchmove', touchmove, { passive: false });
    svg.addEventListener('touchend', touchend);
    svg.addEventListener('mousedown', mousedown);
    window.addEventListener('mousemove', mousemove);
    window.addEventListener('mouseup', mouseup);
    return () => {
      svg.removeEventListener('wheel', wheel);
      svg.removeEventListener('dblclick', dblclick);
      svg.removeEventListener('touchstart', touchstart);
      svg.removeEventListener('touchmove', touchmove);
      svg.removeEventListener('touchend', touchend);
      svg.removeEventListener('mousedown', mousedown);
      window.removeEventListener('mousemove', mousemove);
      window.removeEventListener('mouseup', mouseup);
    };
  });

  // truncate block text that overflows its box (SVG has no text-overflow)
  $effect(() => {
    if (!d || !svg) return;
    svg.querySelectorAll('.blk').forEach((g) => {
      const r = g.querySelector('rect');
      if (!r) return;
      const rw = +r.getAttribute('width');
      g.querySelectorAll('text').forEach((t) => {
        const maxW = rw - 24;
        let s = t.textContent;
        if (t.getComputedTextLength() <= maxW) return;
        while (s.length > 1 && (t.textContent = s + '\u2026', t.getComputedTextLength()) > maxW) s = s.slice(0, -1);
        t.textContent = s + '\u2026';
      });
    });
  });
</script>

<style>
  @keyframes teadot{50%{transform:scale(1.45)}}
  .blk rect{transition:stroke .4s}
  .blk.ok rect{stroke:var(--olives);stroke-opacity:.8}
  .blk.bad rect{stroke:var(--sauce);stroke-opacity:.8}
  .st{fill:var(--faint);transition:fill .4s}
  .st.ok{fill:var(--olives);transform-box:fill-box;transform-origin:center;animation:teadot 1.6s ease-in-out infinite}
  .st.bad{fill:var(--sauce)}
  :global(#legend){display:flex;flex-wrap:wrap;gap:8px 18px;list-style:none;margin:12px 0 0;padding:0}
  :global(#legend li){display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted)}
  :global(#legend i){width:10px;height:10px;border-radius:50%;flex:none}
  :global(#legend .ok){background:var(--olives);animation:teadot 1.6s ease-in-out infinite}
  :global(#legend .bad){background:var(--sauce)}
  :global(#legend .na){background:var(--faint)}
  :global(#notes){margin:10px 0 0;padding-left:18px;font-size:12.5px;color:var(--muted)}
  :global(#notes li){margin:3px 0}
  /* mobile: the viewing area gets ALL remaining space — the page becomes a
     100dvh column: button row · diagram (flex:1, centered) · legend+notes
     at the bottom. overflow-y:auto (not hidden): on short screens the
     column can be taller than 100dvh — hidden clipped the legend/notes off
     with no way to reach them */
  @media (max-width:767px){
    :global(main){height:100dvh;overflow-y:auto;padding:64px 16px 0;display:flex;flex-direction:column}
    :global(#zrow){flex:none}
    :global(#diagWrap){flex:1;min-height:0}
    :global(#diagWrap svg){width:100%;height:100%}
    :global(#diagfoot){flex:none;background:var(--bg);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
    :global(#diagfoot #legend){margin-top:0}
    :global(#diagfoot #notes){margin-top:6px}
  }
</style>

{#if err}
  <p class="err">{err}</p>
{:else if !d}
  <Loading />
{:else}
  <div id="zrow" style="display:flex;justify-content:flex-end;gap:6px;margin:0 0 8px">
    <button id="zIn" title="zoom in" style="width:34px;height:30px;font-size:16px;line-height:1;font-weight:900;cursor:pointer;background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);box-shadow:2px 2px 0 var(--shadow)">+</button>
    <button id="zOut" title="zoom out" style="width:34px;height:30px;font-size:16px;line-height:1;font-weight:900;cursor:pointer;background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);box-shadow:2px 2px 0 var(--shadow)">−</button>
    <button id="zReset" title="reset view" style="height:30px;font-size:11px;font-weight:800;text-transform:uppercase;padding:0 12px;cursor:pointer;background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);box-shadow:2px 2px 0 var(--shadow)">reset</button>
  </div>
  <div id="diagWrap" style="position:relative">
    <svg id="diag" bind:this={svg} viewBox={view.join(' ')}
      font-family="system-ui,-apple-system,'Segoe UI',sans-serif"
      style="width:100%;display:block;cursor:grab;touch-action:none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sauce)"/></marker>
        <marker id="arr-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--olives)"/></marker>
        <marker id="arr-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--sauce)"/></marker>
        <marker id="arr-p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ham)"/></marker>
        <marker id="arr-k" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink)"/></marker>
      </defs>

      {#each blocks as b}
        {#if b.href}
          <a href={b.href} style="text-decoration:none"
            onclick={(e) => { if (b.href.startsWith('/') && navigate(b.href)) e.preventDefault(); }}>
            <g class="blk{b.ok === true ? ' ok' : b.ok === false ? ' bad' : ''}">
              <rect x={b.x + 4} y={b.y + 4} width={b.w} height={b.h} rx="0" fill="var(--shadow)"/>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="0" fill="var(--surface)" stroke="var(--line)" stroke-width="2"/>
              <circle class="st{b.ok === true ? ' ok' : b.ok === false ? ' bad' : ''}" cx={b.x + 14} cy={b.y + 14} r="5"/>
              <text x={b.x + b.w / 2} y={b.y + Math.round(b.h / 2) - 4} font-size="14" font-weight="900" fill="var(--ink)" text-anchor="middle">{b.title}</text>
              {#each b.lines as l, i}
                <text x={b.x + b.w / 2} y={b.y + Math.round(b.h / 2) + 14 + i * 16} font-size="12" fill="var(--muted-2)" text-anchor="middle">{l}</text>
              {/each}
            </g>
          </a>
        {:else}
          <g class="blk{b.ok === true ? ' ok' : b.ok === false ? ' bad' : ''}">
            <rect x={b.x + 4} y={b.y + 4} width={b.w} height={b.h} rx="0" fill="var(--shadow)"/>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="0" fill="var(--surface)" stroke="var(--line)" stroke-width="2"/>
            <circle class="st{b.ok === true ? ' ok' : b.ok === false ? ' bad' : ''}" cx={b.x + 14} cy={b.y + 14} r="5"/>
            <text x={b.x + b.w / 2} y={b.y + Math.round(b.h / 2) - 4} font-size="14" font-weight="900" fill="var(--ink)" text-anchor="middle">{b.title}</text>
            {#each b.lines as l, i}
              <text x={b.x + b.w / 2} y={b.y + Math.round(b.h / 2) + 14 + i * 16} font-size="12" fill="var(--muted-2)" text-anchor="middle">{l}</text>
            {/each}
          </g>
        {/if}
      {/each}

      <!-- the runsc bus: ONE horizontal line spanning exactly between the
           extreme agent arrows (150→850, no overhang). Every agent drops a
           short arrow into it from below its block; the three middle-row
           flows rise into it from above. -->
      <path d="M 150 190 L 850 190" stroke="var(--line)" stroke-width="3" fill="none"/>

      <!-- agents sit on the bus: one arrow per agent block, bottom (y=140)
           down into the bus (y=190) -->
      <path d="M 150 140 L 150 190" stroke="var(--ink)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-k)"/>
      <path d="M 383 140 L 383 190" stroke="var(--ink)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-k)"/>
      <path d="M 617 140 L 617 190" stroke="var(--ink)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-k)"/>
      <path d="M 850 140 L 850 190" stroke="var(--ink)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-k)"/>
      <text x="500" y="182" font-size="11.5" fill="var(--muted-2)" text-anchor="middle">runsc one-shot / long-lived (chat)</text>

      <!-- the three middle-row flows rise into the bus (y=250 → y=190) -->
      <path d="M 150 250 L 150 190" stroke="var(--olives)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-g)"/>
      <text x="138" y="226" font-size="11.5" fill="var(--muted-2)" text-anchor="end">agent work</text>
      <path d="M 500 250 L 500 190" stroke="var(--sauce)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr)"/>
      <text x="512" y="226" font-size="11.5" fill="var(--muted-2)" text-anchor="start">tasks</text>
      <path d="M 850 250 L 850 190" stroke="var(--ham)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-p)"/>
      <text x="862" y="226" font-size="11.5" fill="var(--muted-2)" text-anchor="start">llm /v1</text>

      <!-- gitea → runners + pages (CI) — a single bus: one rise, one horizontal
           spanning exactly the row extremes (150→850, no overhang), three
           clean vertical drops. Nothing crosses anything. -->
      <path d="M 150 360 L 150 410 L 750 410" stroke="var(--olives)" stroke-width="1.5" fill="none" opacity=".75"/>
      <path d="M 250 410 L 250 460" stroke="var(--olives)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-g)"/>
      <path d="M 500 410 L 500 460" stroke="var(--olives)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-g)"/>
      <path d="M 750 410 L 750 460" stroke="var(--olives)" stroke-width="1.5" fill="none" opacity=".75" marker-end="url(#arr-g)"/>
      <text x="450" y="404" font-size="11.5" fill="var(--muted-2)" text-anchor="middle">Gitea Actions (CI)</text>
      <text x="650" y="404" font-size="11.5" fill="var(--muted-2)" text-anchor="middle">syncs gh-pages branch (60s)</text>
    </svg>
  </div>
  <div id="diagfoot">
    <ul id="legend">
      <li><i class="ok"></i>running <span style="opacity:.6">(docker ps)</span></li>
      <li><i class="bad"></i>down</li>
      <li><i class="na"></i>n/a · parked · unknown</li>
    </ul>
    <ul id="notes">
      <li>every agent job runs one-shot in a gVisor (runsc) sandbox; 2pizzas, the runners and Gitea itself run on the host</li>
      <li>agent images bake gitleaks + semgrep (rule packs in <code>/etc/semgrep</code> — scan offline); the reviewer runs them before the verdict</li>
      <li>every PR is gated by the <code>security-scan</code> CI workflow on my-runner (secrets block, code rules advisory)</li>
      <li>scroll to zoom, drag to pan — on touch: one finger pans, pinch zooms</li>
    </ul>
  </div>
{/if}
