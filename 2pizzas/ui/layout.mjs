// ── shared layout ────────────────────────────────────────────────────────────

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Pizza palette (neobrutalist). Semantic vars drive light/dark; the brand
// palette is constant in both. html[data-theme=dark] (set pre-paint from
// localStorage — see the THEME_SCRIPT in page()) flips the semantic set to
// the inverse-brutalist dark scheme: near-black bg, dark surfaces, LIGHT
// borders (the chunky outline stays visible), black shadows (border carries
// the style; shadow is depth only). Legacy --color-* aliases keep every old
// var(--color-*, fallback) reference in page-specific styles resolving to
// the active scheme without per-file edits.
export const THEME_CSS = `:root{
  --crust:#181818;--charcoal:#121212;--dark:#000000;--light:#f5f5f5;--sauce:#dd4a48;--cheese:#eeddb2;--olives:#4e8752;
  --sauce-dark:#b93a38;--olives-dark:#3d6b41;--ham:#d17a66;
  /* semantic — light mode */
  --bg:#f5f5f5;--surface:#fff;--ink:#121212;--muted:#555;--muted-2:#666;--faint:#999;
  --line:#000;--shadow:#000;--track:#e2e2e2;
  --cheese:#eeddb2;--cheese-ink:var(--charcoal);
  --nav-active-bg:var(--charcoal);--nav-active-ink:var(--light);
  /* legacy --color-* aliases (point at the semantic set → follow dark mode) */
  --color-body:var(--bg);
  --color-text:var(--ink);
  --color-text-2:#444;
  --color-text-3:var(--muted-2);
  --color-text-light-2:var(--muted);
  --color-text-light-3:var(--muted-2);
  --color-text-light-4:var(--faint);
  --color-primary:var(--sauce);
  --color-primary-light-1:#e8716f;
  --color-primary-light-2:#e8716f;
  --color-success-text:var(--olives);
  --color-warning-text:#9a6b2f;
  --color-error-text:var(--sauce);
  --color-light-border:var(--line);
  --color-nav-bg:var(--bg);
  --color-nav-text:var(--ink);
  --color-overlay-backdrop:rgba(0,0,0,.55);
  --color-secondary-alpha-10:var(--surface);
  --color-secondary-alpha-20:#eee;
  --color-hover:var(--cheese);
  --color-console-bg:#121212;
  --color-console-fg:#eaeaea;
  --color-console-border:var(--line);
  --color-input-background:var(--surface);
  --color-input-border:var(--line);
  --color-input-text:var(--ink);
  --color-button-secondary-background:var(--surface);
  --color-button-secondary-border:var(--line);
  --color-button-secondary-text:var(--ink);
  --color-button-primary-background:var(--sauce);
  --color-button-primary-text:#fff;
}
html[data-theme=dark]{
  --bg:var(--crust);--surface:#1c1c1c;--ink:#f5f5f5;--muted:#b0b0b0;--muted-2:#8a8a8a;--faint:#666;
  --line:#f5f5f5;--shadow:#666;--track:#2a2a2a;
  --cheese:#eeddb2;--cheese-ink:var(--charcoal);
  --nav-active-bg:var(--cheese);--nav-active-ink:var(--cheese-ink);
  --color-text-2:#ccc;
  --color-secondary-alpha-20:#222;
  --color-console-bg:#000;
}`;

// pre-paint theme apply — runs in <head> before the body parses, so the
// saved dark theme is on <html> before first paint (no light flash).
// Toggle lives on /settings (persisted in localStorage).
export const THEME_SCRIPT = `<script>try{if(localStorage.getItem('tea_theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}</script>`;

function sidebar(active) {
  // gitea link resolved client-side: same host as the UI, port 3000
  // mobile: off-canvas drawer toggled by #navToggle (in the top bar),
  // closed by backdrop or nav click
  return `<div id="backdrop"></div>
<aside class="sidebar" id="sidebar"><span class="brand">🍕 2pizzas</span>
<a class="navl${active === 'home' ? ' on' : ''}" href="/">home</a>
<a class="navl${active === 'infra' ? ' on' : ''}" href="/infra">infra</a>
<a class="navl${active === 'tasks' ? ' on' : ''}" href="/tasks">tasks</a>
<a class="navl${active === 'chat' ? ' on' : ''}" href="/chat">chat</a>
<a class="navl${active === 'android' ? ' on' : ''}" href="/android">android</a>
<a class="navl${active === 'pages' ? ' on' : ''}" href="/pages">pages</a>
<a class="navl${active === 'repos' ? ' on' : ''}" href="/repos">repos</a>
<a class="navl${active === 'stats' ? ' on' : ''}" href="/stats">stats</a>
<a class="navl${active === 'settings' ? ' on' : ''}" href="/settings">settings</a>
<a class="navl${active === 'backends' ? ' on' : ''}" href="/backends">backends</a>
<a class="navl sbfoot" id="giteaLink" href="#">gitea ↗</a></aside>
<script>var sb=document.getElementById('sidebar'),bd=document.getElementById('backdrop'),tg=document.getElementById('navToggle');
tg.onclick=function(){bd.classList.toggle('show',sb.classList.toggle('open'));};
bd.onclick=function(){sb.classList.remove('open');bd.classList.remove('show');};
document.querySelectorAll('.sidebar a').forEach(function(a){a.addEventListener('click',function(){sb.classList.remove('open');bd.classList.remove('show');});});
var g=document.getElementById('giteaLink');if(g)g.href=location.protocol+'//'+location.hostname+':3000';</script>`;
}

// Live update (replaces the old 3s location.reload() — no more tab-spinner
// pulsing): subscribe to /live/stream, and on any event re-fetch this page
// and swap ONLY <main>'s content in place. The page's own script (passed
// via the `script` option, rendered OUTSIDE main) defines window.__pageInit,
// which is re-run after every swap — innerHTML does not execute scripts, so
// event bindings / link fixups must be re-established this way.
const LIVE_SCRIPT = `<script>
(function(){
  var main = document.querySelector('main');
  var busy = false;
  function init(){ if (window.__pageInit) window.__pageInit(); }
  function refresh(){
    if (busy) return; busy = true;
    fetch(location.pathname + location.search, { headers: { 'x-live-refresh': '1' } })
      .then(function(r){ return r.text(); })
      .then(function(html){
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var m = doc.querySelector('main');
        if (m) main.innerHTML = m.innerHTML;
        init();
      })
      .catch(function(){})
      .then(function(){ busy = false; });
  }
  var es = new EventSource('/live/stream');
  es.onmessage = function(){ refresh(); };
  init();
})();
</script>`;

export function page(title, bodyHtml, { auto = true, nav = null, app = false, script = '' } = {}) {
  const live = auto ? LIVE_SCRIPT : '';
  const side = nav ? sidebar(nav) : '';
  // title bar: brand + current page, fixed top on mobile AND desktop
  const top = nav ? `<header id="topbar"><button id="navToggle" aria-label="menu">☰</button><span class="pgtitle">${esc(title)}</span></header>` : '';
  // neobrutalist pizza theme — flat palette, thick borders, hard offset
  // shadows, sharp corners (see THEME_CSS for the palette + aliases)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — 2pizzas</title>
${THEME_SCRIPT}
<script>function glinkFix(){document.querySelectorAll('a.glink').forEach(function(a){a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo+'/actions/runs/'+a.dataset.run;});}</script>
<script>function giteaFix(root){(root||document).querySelectorAll('a[href]').forEach(function(a){var m=/^https?:\\/\\/[^/]+(\\/[^#?]*?\\/(?:issues|pulls)\\/\\d+)/.exec(a.getAttribute('href')||'');if(m){var u=location.protocol+'//'+location.hostname+':3000'+m[1];a.setAttribute('href',u);if(a.textContent.trim()!==u)a.textContent=u;}});}</script>
<style>
${THEME_CSS}
*{box-sizing:border-box}
body{font:14px/1.55 -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;background:var(--bg);color:var(--ink);margin:0;-webkit-font-smoothing:antialiased}
a{color:var(--sauce);font-weight:600}
a:hover{text-decoration:underline}
h1{font-size:22px;font-weight:900;letter-spacing:-.02em;text-transform:uppercase}
h2{font-size:13px;font-weight:900;margin:26px 0 10px;color:var(--ink);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:8px}
h2::before{content:"";width:10px;height:10px;background:var(--sauce);border:2px solid var(--line);flex:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:var(--cheese);color:var(--cheese-ink);padding:0 4px;border:1px solid var(--line)}
/* mobile-first: off-canvas drawer; desktop (>=768px) pins it open */
.layout{min-height:100vh}
main{min-width:0;padding:16px;padding-top:64px;max-width:960px}
/* title bar: fixed top, full width on mobile, right of the sidebar on desktop */
#topbar{position:fixed;top:0;left:0;right:0;height:48px;z-index:20;display:flex;align-items:center;gap:10px;padding:0 14px;line-height:1;background:var(--bg);border-bottom:2px solid var(--line)}
.pgtitle{margin:0;font-size:11.5px;font-weight:800;line-height:1;color:var(--muted-2);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* full-height app layout (chat): header top, messages fill, input pinned bottom */
main.app{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.chatapp{flex:1;min-height:0;display:flex;flex-direction:column;max-width:960px;width:100%;margin:0 auto}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:200px;z-index:30;background:var(--bg);border-right:2px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;transform:translateX(-100%);transition:transform .18s ease-out}
.sidebar.open{transform:none}
.sidebar .brand{font-weight:900;font-size:17px;letter-spacing:-.02em;color:var(--ink);padding:0 10px 18px;text-transform:uppercase}
#navToggle{background:var(--surface);border:2px solid var(--line);color:var(--ink);font:14px -apple-system,system-ui,sans-serif;line-height:1;padding:5px 10px;cursor:pointer;box-shadow:2px 2px 0 var(--shadow)}
#navToggle:active{transform:translate(2px,2px);box-shadow:none}
#backdrop{display:none;position:fixed;inset:0;background:var(--color-overlay-backdrop,rgba(0,0,0,.55));z-index:25}
#backdrop.show{display:block}
.navl{display:block;color:var(--ink);text-decoration:none;padding:8px 12px;font-size:13.5px;font-weight:700;margin-top:4px}
.navl:hover{background:var(--cheese);color:var(--cheese-ink);text-decoration:none}
.navl.on{background:var(--nav-active-bg);color:var(--nav-active-ink);box-shadow:3px 3px 0 var(--sauce)}
.sbfoot{margin-top:auto}
/* section surface for block content (forms, tables, diagrams) — the
   row-based counterpart is .list/.item below; both follow an <h2> */
.card{border:2px solid var(--line);border-radius:0;background:var(--surface);box-shadow:4px 4px 0 var(--shadow);padding:14px 16px;margin-bottom:16px}
/* generic small button (admin actions) — .grantbtn stays for repo grants */
.btn{background:var(--surface);border:2px solid var(--line);color:var(--ink);border-radius:0;padding:4px 12px;cursor:pointer;font-size:11.5px;font-weight:800;text-transform:uppercase;box-shadow:3px 3px 0 var(--shadow)}
.btn:hover:not(:disabled),.btn.on{background:var(--cheese);color:var(--cheese-ink);transform:translate(1px,1px);box-shadow:2px 2px 0 var(--shadow)}
.btn.on{transform:none}
.btn:active:not(:disabled){transform:translate(3px,3px);box-shadow:none}
.btn:disabled{opacity:.4;cursor:default;box-shadow:none}
.btn.danger:hover:not(:disabled){background:#fbe3e3;color:var(--sauce)}
.btn.primary{background:var(--sauce);color:#fff}
.btn.primary:hover:not(:disabled){background:var(--sauce-dark);color:#fff}
/* generic info badges (the .queued/.running/… pills are task-state only) */
.badge{display:inline-block;border:2px solid var(--line);border-radius:0;padding:1px 7px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;background:var(--surface);color:var(--ink);white-space:nowrap}
.badge-success{background:#e4efe5;color:var(--olives-dark);border-color:var(--olives)}
.badge-info{background:var(--cheese);color:var(--cheese-ink)}
.badge-warn{background:#fbe3e3;color:var(--sauce-dark);border-color:var(--sauce)}
/* card surface (no tables): each .item is a whole-block clickable row */
.list{border:2px solid var(--line);border-radius:0;overflow:hidden;background:var(--surface);box-shadow:4px 4px 0 var(--shadow)}
.item{display:block;text-decoration:none;color:inherit;padding:11px 15px;background:var(--surface);border-bottom:2px solid var(--line)}
.item:last-child{border-bottom:none}
.item:hover{background:var(--cheese);color:var(--cheese-ink)}
/* inner muted lines don't inherit — darken them on hover too (gray-on-
   cheese is unreadable in dark mode) */
.item:hover .l2,.item:hover .meta{color:var(--cheese-ink)}
.l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:700;font-size:13.5px}
.l2{color:var(--muted);font-size:12.5px;margin-top:3px;line-height:1.5}
.err{color:var(--sauce-dark);font-size:12.5px;font-weight:700;margin-top:3px;word-break:break-word}
.model{color:var(--muted-2);font-size:11.5px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ctx{color:var(--muted-2);font-size:11.5px}
.meta{color:var(--muted-2);font-size:12.5px}
.hook{font-weight:400;font-size:12.5px}.hook.ok{color:var(--olives-dark);font-weight:700}.hook.bad{color:var(--sauce-dark);font-weight:700}
.del{cursor:pointer;font-size:13px;margin-left:8px;color:var(--faint);font-weight:900}
.del:hover{color:var(--sauce)}
.grantbtn{margin-left:auto;background:var(--surface);border:2px solid var(--line);color:var(--ink);border-radius:0;padding:4px 12px;cursor:pointer;font-size:11.5px;font-weight:800;text-transform:uppercase;box-shadow:3px 3px 0 var(--shadow)}
.grantbtn:hover{background:var(--cheese);color:var(--cheese-ink);transform:translate(1px,1px);box-shadow:2px 2px 0 var(--shadow)}
/* status pill badges */
.queued,.running,.success,.failure{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border:2px solid transparent;border-radius:0;white-space:nowrap;background:var(--surface)}
.queued{color:var(--muted-2);border-color:var(--faint)}
.running{color:var(--cheese-ink);border-color:var(--line);background:var(--cheese)}
.success{color:var(--olives-dark);border-color:var(--olives);background:#e4efe5}
.failure{color:var(--sauce-dark);border-color:var(--sauce);background:#fbe3e3}
/* live indicator (pulsing dot) — shared by task + chat streaming views */
.live{display:inline-flex;align-items:center;gap:6px;color:var(--sauce-dark);font-size:12px;font-weight:800;text-transform:uppercase;margin-left:4px}
.live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--sauce);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
/* page header: title row + meta */
.pagehead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.pagehead h1{margin:0}
.back{display:inline-block;text-decoration:none;font-size:12.5px;font-weight:800;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
/* compact one-line chat header: ← #id · status … close */
.chathead{display:flex;align-items:center;gap:8px;flex:none;margin:0 0 2px}
.chathead .back{margin:0}
.chid{font-weight:900;font-size:13px}
.chclose{margin-left:auto}
.back:hover{color:var(--sauce);text-decoration:underline}
/* console: shared stream surface for task logs AND chat */
.console{background:var(--color-console-bg,#121212);color:#eaeaea;border:2px solid var(--line);border-radius:0;padding:14px 16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin-top:12px;max-height:calc(100vh - 240px);box-shadow:4px 4px 0 var(--sauce)}
pre{background:var(--color-console-bg,#121212);color:#eaeaea;border:2px solid var(--line);border-radius:0;padding:14px 16px;overflow-x:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55}
.bar{height:8px;background:var(--track);border:2px solid var(--line);margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--sauce);border-radius:0}
/* chat — same console/indicator language as the task views */
#msgs{flex:1;min-height:0;overflow-y:auto;border:2px solid var(--line);border-radius:0;padding:10px 14px;margin:12px 0;background:var(--surface);box-shadow:4px 4px 0 var(--shadow)}
.muser{background:var(--cheese);color:var(--cheese-ink);border:2px solid var(--line);border-radius:0;box-shadow:3px 3px 0 var(--shadow);padding:9px 13px;margin:9px 0;white-space:pre-wrap;font-size:13px}
.muser::before{content:"you";display:block;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--sauce-dark);margin-bottom:3px}
.mtext{border-left:4px solid var(--ink);padding:4px 13px;margin:9px 0;font-size:13px;line-height:1.5}
.mtool{color:var(--muted);font-size:12px;margin:6px 0;word-break:break-word;border-left:3px solid var(--line);padding-left:10px}
.mtool code{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.cmdchip{display:inline-block;background:var(--cheese);color:var(--cheese-ink);border:2px solid var(--line);border-radius:0;box-shadow:2px 2px 0 var(--shadow);padding:2px 8px;margin:2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;font-weight:700;cursor:default}
.merr{color:var(--sauce-dark);font-size:12.5px;font-weight:700;margin:8px 0;white-space:pre-wrap}
.msettle{color:var(--faint);font-size:11px;font-weight:700;text-transform:uppercase;margin:12px 0;text-align:right}
.mref{font-size:12.5px;margin:8px 0;border-left:3px solid var(--olives);padding-left:10px;word-break:break-all}
.mtext a.glref,.mref a{color:var(--sauce-dark);text-decoration:underline}
.mcompacted{color:var(--faint);font-size:11px;font-weight:700;text-transform:uppercase;margin:12px 0;text-align:center}
.mstatus{color:var(--sauce-dark);font-size:12.5px;font-weight:700;margin:8px 0;opacity:.85}
.mend{color:var(--sauce-dark);font-size:12.5px;font-weight:700;margin:12px 0;text-align:center;border-top:2px solid var(--line);padding-top:10px}
.chatin{display:flex;gap:8px;align-items:stretch;flex:none;margin-top:4px}
.ctxline{flex:none;margin-top:6px;min-height:1em}
.chatin.endednote{align-items:center}
.chatbtns{display:flex;flex-direction:column;gap:8px;align-items:stretch}
.chatbtns .ic{display:inline-block;margin-right:7px;vertical-align:middle;transform:translateY(-1px)}
.chatin textarea{flex:1;background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;resize:vertical}
.chatin textarea::placeholder{color:var(--faint)}
.chatin textarea:focus{outline:none;box-shadow:3px 3px 0 var(--sauce)}
.chatin button,#newchat button{background:var(--surface);border:2px solid var(--line);color:var(--ink);border-radius:0;padding:7px 15px;cursor:pointer;font-size:12px;font-weight:800;text-transform:uppercase;box-shadow:3px 3px 0 var(--shadow)}
.chatin button:hover:not(:disabled),#newchat button:hover{background:var(--cheese);color:var(--cheese-ink);transform:translate(1px,1px);box-shadow:2px 2px 0 var(--shadow)}
#send{background:var(--olives);color:#fff}
#send .ic{color:#fff}
#send:hover:not(:disabled){background:var(--olives-dark);color:#fff}
#stop{color:var(--sauce-dark)}
#stop .ic{color:var(--sauce-dark)}
#stop:hover:not(:disabled){background:#fbe3e3;color:var(--sauce-dark)}
#newchat{display:flex;gap:8px;margin:12px 0}
#newchat select{background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);padding:7px;font-weight:700}
/* global form controls (backends, settings, chat) */
input,select{background:var(--surface);border:2px solid var(--line);border-radius:0;color:var(--ink);padding:7px 10px;font-size:13px;font-family:inherit}
input:focus,select:focus{outline:none;box-shadow:3px 3px 0 var(--sauce)}
input::placeholder{color:var(--faint)}
@media (min-width:768px){
  .sidebar{transform:none}
  #navToggle,#backdrop{display:none}
  #topbar{left:200px}
  main{margin-left:200px;padding:68px 32px 28px}
  main.app{padding:68px 24px 12px}
}
</style></head><body>
<div class="layout${app ? ' app' : ''}">${top}${side}<main class="${app ? ' app' : ''}">${bodyHtml}</main></div>
${script}${live}</body></html>`;
}

export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
export function ctxLine(t) {
  if (t.tokens == null || !t.model_ctx) return '';
  const pct = Math.min(100, Math.round((t.tokens / t.model_ctx) * 100));
  return ` · <span class="ctx" title="context used / window">${fmtTok(t.tokens)}/${fmtTok(t.model_ctx)} tok (${pct}%)</span>`;
}
