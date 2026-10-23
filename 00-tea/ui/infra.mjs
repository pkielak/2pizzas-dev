import { CFG } from '../config.mjs';
import { db } from '../db.mjs';
import { managedRepos } from '../repos.mjs';
import { llamaModels } from '../llama.mjs';
import { execFileP } from '../util.mjs';
import { esc } from './layout.mjs';

// ── infra — live block diagram of the whole stack ─────────────────────────
export async function dockerNames() {
  try {
    const out = await execFileP('docker', ['ps', '--format', '{{.Names}}'], { timeout: 8000 });
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch { return null; }
}

// Grid: 3 rows (y 40..150 / 250..350 / 450..550, 100px gutters), 4 columns
// Three rows: AGENTS on top (5 boxes w 160 at x 30/225/420/615/810,
// y 40..140), FOUNDATIONS in the middle (3 boxes w 240: gitea 30..270,
// 00-tea 380..620, llama 730..970, y 250..360), RUNNERS/SERVERS at the
// bottom (3 boxes w 200 at x 30/280/530, y 460..560). Every connector is
// a straight H/V polyline — no diagonals, no crossings, no hop arcs:
// 00-tea dispatches UP to all five agent containers (bus y=180, drops
// at the agent centers 110/305/500/695/890); agents→gitea returns down
// the left (x=80 → y=215 → x=150 → gitea top, left of the dispatch bus
// start 110… the bus starts at 110, the lane at 80, so no crossing);
// llama→agents exits llama's right side (x=970), runs up the right
// margin (x=985) above everything, crosses the top (y=20) and drops
// onto every agent container from above; gitea→runners fans out below
// (bus y=410, drops at 130/380/630).
// Line labels sit 8px above their line, centered on the segment.
const F = 'stroke:var(--color-primary,#7ab);stroke-width:1.5;fill:none;opacity:.75';
const conn = (d, arrow = true) => `<path d="${d}" style="${F}"${arrow ? ' marker-end="url(#arr)"' : ''}/>`;
const label = (x, y, t, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="11.5" fill="var(--color-text-light-2,#888)" text-anchor="${anchor}">${t}</text>`;
const rlabel = (x, y, t) => `<text transform="rotate(-90 ${x} ${y})" x="${x}" y="${y}" font-size="11.5" fill="var(--color-text-light-2,#888)" text-anchor="middle">${t}</text>`;


export function infraPage() {
  return (async () => {
    const [running, models, managedN, inFlight] = await Promise.all([
      dockerNames(),
      llamaModels().catch(() => null),
      Promise.resolve(managedRepos().length),
      Promise.resolve(db.prepare("SELECT agent, COUNT(*) n FROM tasks WHERE status IN ('queued','running') GROUP BY agent").all()),
    ]);
    const up = (name) => running === null ? null : running.has(name);
    const agentBusy = (a) => inFlight.find((r) => r.agent === a)?.n > 0;
    const chatN = running ? [...running].filter((n) => n.startsWith('tea-chat-')).length : null;
    const pagesUp = CFG.pagesSites.length
      ? CFG.pagesSites.map((s) => s.split(':')[2]).map(up).every((u) => u === true)
      : null;

    // status: true = running (pulse + glow) · false = down (red glow) · null = n/a, parked, unknown
    const dot = (ok, cx, cy) => `<circle class="st${ok === true ? ' ok' : ok === false ? ' bad' : ''}" cx="${cx}" cy="${cy}" r="5"/>`;
    const block = (x, y, w, h, title, lines, ok, href) => {
      const body = `<g class="blk${ok === true ? ' ok' : ok === false ? ' bad' : ''}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="var(--color-secondary-alpha-10,rgba(255,255,255,.03))" stroke="var(--color-light-border,#2a2a2a)"/>
${dot(ok, x + 16, y + 20)}
<text x="${x + 30}" y="${y + 25}" font-size="14" font-weight="700" fill="var(--color-text,#ddd)">${esc(title)}</text>
${lines.map((l, i) => `<text x="${x + 30}" y="${y + 45 + i * 16}" font-size="12" fill="var(--color-text-light-2,#999)">${l}</text>`).join('')}</g>`;
      return href ? `<a href="${href}" style="text-decoration:none">${body}</a>` : body;
    };

    const loaded = models ? models.filter((m) => m.loaded).map((m) => m.id) : [];

    const svg = `<svg id="diag" viewBox="0 0 1000 570" style="width:100%;display:block;cursor:grab;touch-action:none" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-primary,#7ab)"/></marker></defs>

${block(30, 40, 160, 100, '@pi', ['agent-sandbox:pi', agentBusy('pi') ? 'task in flight' : 'idle'], agentBusy('pi') ? true : null)}
${block(225, 40, 160, 100, '@opencode', ['agent-sandbox:opencode', agentBusy('opencode') ? 'task in flight' : 'idle'], agentBusy('opencode') ? true : null)}
${block(420, 40, 160, 100, '@review', ['agent-sandbox:review', agentBusy('review') ? 'task in flight' : 'read-only · idle'], agentBusy('review') ? true : null)}
${block(615, 40, 160, 100, '@ops', ['agent-sandbox:ops', 'parked'], null)}
${block(810, 40, 160, 100, 'chat containers', ['long-lived runsc', chatN === null ? 'chat user' : `chat user · ${chatN} active`], chatN === null ? null : chatN > 0)}

${block(30, 250, 240, 110, 'Gitea', ['server :3000 · postgres db', `${managedN} managed repo${managedN === 1 ? '' : 's'} · bot + chat users`], up('gitea') === null ? null : (up('gitea') && up('gitea-db-1')), '#gitea')}
${block(380, 250, 240, 110, '00-tea', ['dispatcher :3001 · sqlite queue', 'webhook · task runner · chat'], up('gitea-00-tea'), '/tasks')}
${block(730, 250, 240, 110, 'llama.cpp router', [esc(CFG.llamaUrl), models ? (loaded.length ? `loaded: ${esc(loaded.join(', '))}` : 'reachable · no model loaded') : 'unreachable'], models ? true : false)}

${block(30, 460, 200, 100, 'my-runner', ['label: ubuntu-latest', 'runc · ordinary CI'], up('gitea-runner'))}
${block(280, 460, 200, 100, 'android-runner', ['label: android', 'gitea-android:latest image'], up('gitea-android-runner'))}
${block(530, 460, 200, 100, 'pages', [CFG.pagesSites.length ? CFG.pagesSites.map((s) => `${esc(s.split(':')[0])} :${esc(s.split(':')[1])}`).join(' · ') : 'no sites (PAGES_SITES)', 'serves gh-pages branches'], pagesUp)}

<!-- gitea → 00-tea · 00-tea → llama -->
${conn('M 270 305 L 380 305')}
${label(325, 297, 'webhook')}
${conn('M 620 305 L 730 305')}
${label(675, 297, 'model pick')}

<!-- ONE bidirectional bus (y=180) between 00-tea / gitea and the agent
     row: 00-tea drops onto it (x=500), it drops into every agent
     container (tasks, one-shot runsc), and its left end drops into
     gitea (x=110) — that IS the bot-work return path (push · PR ·
     comments). No second bus, so nothing crosses anything. -->
${conn('M 500 250 L 500 180', false)}
${conn('M 110 180 L 890 180', false)}
${conn('M 110 180 L 110 140')}
${conn('M 305 180 L 305 140')}
${conn('M 500 180 L 500 140')}
${conn('M 695 180 L 695 140')}
${conn('M 890 180 L 890 140')}
${conn('M 110 180 L 110 250')}
${label(490, 192, 'tasks ↓ · runsc one-shot / long-lived (chat) · bot work ↑', 'end')}

<!-- llama → all agent containers: out of llama's right side, up around
     the chat containers, across the top, drops onto every agent -->
${conn('M 970 305 L 985 305 L 985 20 L 110 20', false)}
${conn('M 110 20 L 110 40')}
${conn('M 305 20 L 305 40')}
${conn('M 500 20 L 500 40')}
${conn('M 695 20 L 695 40')}
${conn('M 890 20 L 890 40')}
${label(500, 12, 'llm /v1 · all agents')}

<!-- gitea → runners + pages (CI bus, y=410) -->
${conn('M 150 360 L 150 410', false)}
${conn('M 130 410 L 630 410', false)}
${conn('M 130 410 L 130 460')}
${conn('M 380 410 L 380 460')}
${conn('M 630 410 L 630 460')}
${label(250, 402, 'Gitea Actions (CI)')}
${label(500, 402, 'syncs gh-pages branch (60s)')}

</svg>`;

    return {
      html: `<style>
@keyframes teadot{50%{transform:scale(1.45)}}
.blk rect{transition:stroke .4s}
.blk.ok rect{stroke:var(--color-success-text,#3a3);stroke-opacity:.55}
.blk.bad rect{stroke:var(--color-error-text,#a33);stroke-opacity:.6}
.st{fill:var(--color-text-light-2,#555);transition:fill .4s}
.st.ok{fill:var(--color-success-text,#6d6);transform-box:fill-box;transform-origin:center;animation:teadot 1.6s ease-in-out infinite;filter:drop-shadow(0 0 3px var(--color-success-text,#6d6))}
.st.bad{fill:var(--color-error-text,#f66);filter:drop-shadow(0 0 3px var(--color-error-text,#f66))}
#legend{display:flex;flex-wrap:wrap;gap:8px 18px;list-style:none;margin:12px 0 0;padding:0}
#legend li{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--color-text-light-2,#999)}
#legend i{width:10px;height:10px;border-radius:50%;flex:none}
#legend .ok{background:var(--color-success-text,#6d6);animation:teadot 1.6s ease-in-out infinite}
#legend .bad{background:var(--color-error-text,#f66)}
#legend .na{background:var(--color-text-light-2,#555)}
#notes{margin:10px 0 0;padding-left:18px;font-size:12.5px;color:var(--color-text-light-2,#999)}
#notes li{margin:3px 0}
/* mobile: the viewing area gets ALL remaining space — the page becomes a
   100dvh column: button row · diagram (flex:1, centered) · legend+notes at the bottom */
@media (max-width:767px){
  main{height:100dvh;overflow:hidden;padding:64px 16px 0;display:flex;flex-direction:column}
  #zrow{flex:none}
  #diagWrap{flex:1;min-height:0}
  #diagWrap svg{width:100%;height:100%}
  #diagfoot{flex:none;background:var(--color-body,#111);border-top:1px solid var(--color-light-border,#2a2a2a);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
  #diagfoot #legend{margin-top:0}
  #diagfoot #notes{margin-top:6px}
}
</style>
<div id="zrow" style="display:flex;justify-content:flex-end;gap:6px;margin:0 0 8px">
<button id="zIn" title="zoom in" style="width:30px;height:30px;font-size:16px;line-height:1;cursor:pointer;background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);border-radius:7px;color:var(--color-button-secondary-text,#ddd)">+</button>
<button id="zOut" title="zoom out" style="width:30px;height:30px;font-size:16px;line-height:1;cursor:pointer;background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);border-radius:7px;color:var(--color-button-secondary-text,#ddd)">−</button>
<button id="zReset" title="reset view" style="height:30px;font-size:12px;padding:0 10px;cursor:pointer;background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);border-radius:7px;color:var(--color-button-secondary-text,#ddd)">reset</button>
</div>
<div id="diagWrap" style="position:relative">
${svg}
</div>
<div id="diagfoot">
<ul id="legend">
<li><i class="ok"></i>running <span style="opacity:.6">(docker ps)</span></li>
<li><i class="bad"></i>down</li>
<li><i class="na"></i>n/a · parked · unknown</li>
</ul>
<ul id="notes">
<li>every agent job runs one-shot in a gVisor (runsc) sandbox; 00-tea, the runners and Gitea itself run on the host</li>
<li>gVisor egress policy: <code>gitea-policy.yaml</code></li>
<li>scroll to zoom, drag to pan — on touch: one finger pans, pinch zooms</li>
</ul>
</div>`,
      script: `<script>window.__pageInit = function(){
document.querySelectorAll('a[href="#gitea"]').forEach(a=>a.href=location.protocol+'//'+location.hostname+':3000');
(function(){
  var svg = document.getElementById('diag');
  if (!svg || svg.__wired) return;
  svg.__wired = true;
  var FULL = [0, 0, 1000, 570];
  var v = window.__diagView ? window.__diagView.slice() : FULL.slice(); // survives live-refresh swaps
  function apply(){ svg.setAttribute('viewBox', v.join(' ')); window.__diagView = v.slice(); }
  function clampZoom(nv){
    if (nv[2] < FULL[2] / 10) return null;
    if (nv[2] > FULL[2] * 4) return null;
    return nv;
  }
  function svgPoint(e){
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }
  function zoomAt(f, px, py){
    var nv = [px - (px - v[0]) * f, py - (py - v[1]) * f, v[2] * f, v[3] * f];
    if (clampZoom(nv)) { v = nv; apply(); }
  }
  var zin = document.getElementById('zIn'), zout = document.getElementById('zOut'), zreset = document.getElementById('zReset');
  if (zin) zin.onclick = function(){ zoomAt(1 / 1.25, v[0] + v[2] / 2, v[1] + v[3] / 2); };
  if (zout) zout.onclick = function(){ zoomAt(1.25, v[0] + v[2] / 2, v[1] + v[3] / 2); };
  if (zreset) zreset.onclick = function(){ v = FULL.slice(); apply(); };
  svg.addEventListener('wheel', function(e){
    e.preventDefault();
    var p = svgPoint(e);
    zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }, { passive: false });
  svg.addEventListener('dblclick', function(e){
    var p = svgPoint(e);
    zoomAt(1 / 1.5, p.x, p.y);
  });
  // touch: one finger pans, two fingers pinch-zoom (mobile has no wheel/dblclick)
  var touch = null;
  function pair(e){
    var dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
    return { d: Math.hypot(dx, dy), mx: (e.touches[0].clientX + e.touches[1].clientX) / 2, my: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
  }
  svg.addEventListener('touchstart', function(e){
    if (e.target.closest('a')) return;
    if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: v.slice() };
    else if (e.touches.length === 2) touch = pair(e);
  }, { passive: true });
  svg.addEventListener('touchmove', function(e){
    if (!touch) return;
    e.preventDefault();
    var ctm = svg.getScreenCTM();
    if (e.touches.length === 2) {
      var p = pair(e);
      if (touch.d) { // pinch: zoom around midpoint + pan with it
        var sp = svgPoint({ clientX: p.mx, clientY: p.my });
        zoomAt(p.d / touch.d, sp.x, sp.y);
        v[0] -= (p.mx - touch.mx) / ctm.a;
        v[1] -= (p.my - touch.my) / ctm.d;
        apply();
      }
      touch = p;
    } else {
      v[0] = touch.v[0] - (e.touches[0].clientX - touch.x) / ctm.a;
      v[1] = touch.v[1] - (e.touches[0].clientY - touch.y) / ctm.d;
      apply();
    }
  }, { passive: false });
  svg.addEventListener('touchend', function(e){
    if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: v.slice() };
    else if (e.touches.length === 0) touch = null;
  });
  var drag = null;
  svg.addEventListener('mousedown', function(e){
    if (e.button !== 0 || e.target.closest('a')) return;
    drag = { x: e.clientX, y: e.clientY, v: v.slice() };
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(e){
    if (!drag) return;
    var ctm = svg.getScreenCTM();
    v[0] = drag.v[0] - (e.clientX - drag.x) / ctm.a;
    v[1] = drag.v[1] - (e.clientY - drag.y) / ctm.d;
    apply();
  });
  window.addEventListener('mouseup', function(){
    drag = null; svg.style.cursor = 'grab';
  });
  // truncate block text that overflows its box (SVG has no text-overflow)
  document.querySelectorAll('.blk').forEach(function(g){
    var r = g.querySelector('rect');
    if (!r) return;
    var rx = +r.getAttribute('x'), rw = +r.getAttribute('width');
    g.querySelectorAll('text').forEach(function(t){
      var maxW = rw - (+t.getAttribute('x') - rx) - 12;
      var s = t.textContent;
      if (t.getComputedTextLength() <= maxW) return;
      while (s.length > 1 && (t.textContent = s + '\u2026', t.getComputedTextLength()) > maxW) s = s.slice(0, -1);
      t.textContent = s + '\u2026';
    });
  });
  apply();
})();
};</script>`,
    };
  })();
}
