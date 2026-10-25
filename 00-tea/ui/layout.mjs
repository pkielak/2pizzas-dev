import { giteaTheme } from '../theme.mjs';

// ── shared layout ────────────────────────────────────────────────────────────

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sidebar(active) {
  // gitea link resolved client-side: same host as the UI, port 3000
  // mobile: off-canvas drawer toggled by #navToggle (in the top bar),
  // closed by backdrop or nav click
  return `<div id="backdrop"></div>
<aside class="sidebar" id="sidebar"><span class="brand">00-tea</span>
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
  const th = giteaTheme();
  const live = auto ? LIVE_SCRIPT : '';
  const side = nav ? sidebar(nav) : '';
  // title bar: brand + current page, fixed top on mobile AND desktop
  const top = nav ? `<header id="topbar"><button id="navToggle" aria-label="menu">☰</button><a class="tbrand" href="/">00-tea</a><span class="pgtitle">${esc(title)}</span></header>` : '';
  // Colors come from Gitea's theme CSS (served same-origin, see giteaTheme());
  // every var() has a hardcoded dark fallback so the UI works if Gitea is down.
  return `<!doctype html><html data-theme="${th.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — 00-tea</title>
<link rel="stylesheet" href="/assets/gitea-theme.css">
<script>function glinkFix(){document.querySelectorAll('a.glink').forEach(function(a){a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo+'/actions/runs/'+a.dataset.run;});}</script>
<style>
*{box-sizing:border-box}
:root{--radius:10px;--radius-sm:7px}
body{font:14px/1.6 -apple-system,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;background:var(--color-body,#111);color:var(--color-text,#ddd);margin:0;-webkit-font-smoothing:antialiased}
a{color:var(--color-primary-light-2,#7ab)}
h1{font-size:20px;font-weight:700;letter-spacing:-.01em}
h2{font-size:13px;font-weight:600;margin:22px 0 8px;color:var(--color-text-light-2,#aab);text-transform:uppercase;letter-spacing:.04em}
/* mobile-first: off-canvas drawer; desktop (>=768px) pins it open */
.layout{min-height:100vh}
main{min-width:0;padding:16px;padding-top:64px;max-width:960px}
/* title bar: fixed top, full width on mobile, right of the sidebar on desktop */
#topbar{position:fixed;top:0;left:0;right:0;height:48px;z-index:20;display:flex;align-items:center;gap:10px;padding:0 14px;line-height:1;background:var(--color-nav-bg,#0c0c0c);border-bottom:1px solid var(--color-light-border,#2a2a2a)}
/* line-height:1 centers the em box, but glyphs (cap-height, no descenders
   used) sit ~1px above the em center — nudge them back down */
.tbrand{position:relative;top:1px;font-weight:700;font-size:15px;letter-spacing:-.02em;line-height:1;color:var(--color-text,#eee);text-decoration:none}
.pgtitle{position:relative;top:2px;margin:0;font-size:13.5px;font-weight:600;line-height:1;color:var(--color-text-light-2,#bbb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* full-height app layout (chat): header top, messages fill, input pinned bottom */
main.app{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.chatapp{flex:1;min-height:0;display:flex;flex-direction:column;max-width:960px;width:100%;margin:0 auto}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:200px;z-index:30;background:var(--color-nav-bg,#0c0c0c);border-right:1px solid var(--color-light-border,#2a2a2a);padding:18px 12px;display:flex;flex-direction:column;transform:translateX(-100%);transition:transform .18s ease-out}
.sidebar.open{transform:none}
.sidebar .brand{font-weight:700;font-size:15px;letter-spacing:-.02em;color:var(--color-text,#eee);padding:0 10px 18px}
#navToggle{background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:8px;color:var(--color-input-text,#7ab);font:14px -apple-system,system-ui,sans-serif;line-height:1;padding:6px 11px;cursor:pointer}
#backdrop{display:none;position:fixed;inset:0;background:var(--color-overlay-backdrop,rgba(0,0,0,.55));z-index:25}
#backdrop.show{display:block}
.navl{display:block;color:var(--color-nav-text,#8ab);text-decoration:none;padding:8px 12px;font-size:13.5px}
.navl:hover{color:var(--color-text,#cde);text-decoration:none}
.navl.on{color:var(--color-text,#fff);font-weight:600}
.sbfoot{margin-top:auto}
/* section surface for block content (forms, tables, diagrams) — the
   row-based counterpart is .list/.item below; both follow an <h2> */
.card{border:1px solid var(--color-light-border,#2a2a2a);border-radius:var(--radius);padding:14px 16px;margin-bottom:12px;background:var(--color-secondary-alpha-10,rgba(255,255,255,.02))}
/* generic small button (admin actions) — .grantbtn stays for repo grants */
.btn{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm);padding:3px 10px;cursor:pointer;font-size:12px}
.btn:hover:not(:disabled){border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}
.btn:disabled{opacity:.4;cursor:default}
.btn.danger:hover:not(:disabled){border-color:#d66;color:#f99}
.btn.primary{background:var(--color-button-primary-background,var(--color-primary,#3a7));border-color:transparent;color:var(--color-button-primary-text,#fff)}
/* generic info badges (the .queued/.running/… pills are task-state only) */
.badge{display:inline-block;border-radius:9px;padding:1px 8px;font-size:11px;background:var(--color-secondary-alpha-20,#333);color:var(--color-text-light-2,#ddd);white-space:nowrap}
.badge-success{background:rgba(90,200,90,.15);color:var(--color-success-text,#6d6)}
.badge-info{background:rgba(90,140,255,.15);color:var(--color-primary-light-1,#7cf)}
.badge-warn{background:rgba(255,180,60,.15);color:#fc6}
/* card surface (no tables): each .item is a whole-block clickable row */
.list{border:1px solid var(--color-light-border,#2a2a2a);border-radius:var(--radius);overflow:hidden;background:var(--color-secondary-alpha-10,rgba(255,255,255,.02))}
.item{display:block;text-decoration:none;color:inherit;padding:11px 15px;border-bottom:1px solid var(--color-light-border,#242424)}
.item:last-child{border-bottom:none}
.item:hover{background:var(--color-hover,rgba(255,255,255,.04))}
.l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13.5px}
.l2{color:var(--color-text-light-2,#8a8a8a);font-size:12.5px;margin-top:3px;line-height:1.5}
.err{color:var(--color-error-text,#f76);font-size:12.5px;margin-top:3px;word-break:break-word}
.model{color:var(--color-text-3,#777);font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ctx{color:var(--color-text-light-2,#888);font-size:11.5px}
.meta{color:var(--color-text-light-2,#888);font-size:12.5px}
.hook{font-weight:400;font-size:12.5px}.hook.ok{color:var(--color-success-text,#6d6)}.hook.bad{color:var(--color-error-text,#f66)}
.del{cursor:pointer;font-size:13px;margin-left:8px;color:var(--color-text-light-2,#888)}
.del:hover{color:var(--color-error-text,#f66)}
.grantbtn{margin-left:auto;background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm);padding:3px 10px;cursor:pointer;font-size:12px}
.grantbtn:hover{border-color:var(--color-primary,#7ab)}
/* status pill badges */
.queued,.running,.success,.failure{display:inline-block;font-size:11px;font-weight:600;padding:1px 9px;border-radius:11px;border:1px solid transparent;white-space:nowrap;line-height:1.6}
.queued{color:var(--color-text-light-2,#999);border-color:var(--color-text-light-2,#555)}
.running{color:var(--color-primary-light-1,#7cf);border-color:var(--color-primary,#36c);background:rgba(90,140,255,.12)}
.success{color:var(--color-success-text,#6d6);border-color:var(--color-success-text,#3a3);background:rgba(90,200,90,.12)}
.failure{color:var(--color-error-text,#f66);border-color:var(--color-error-text,#a33);background:rgba(255,90,90,.12)}
/* live indicator (pulsing dot) — shared by task + chat streaming views */
.live{display:inline-flex;align-items:center;gap:6px;color:var(--color-primary-light-1,#7cf);font-size:12px;font-weight:500;margin-left:4px}
.live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--color-primary,#7ab);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
/* page header: title row + meta */
.pagehead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.pagehead h1{margin:0}
.back{display:inline-block;text-decoration:none;font-size:12.5px;color:var(--color-text-light-2,#999);margin-bottom:10px}
/* compact one-line chat header: ← #id · status … close */
.chathead{display:flex;align-items:center;gap:8px;flex:none;margin:0 0 2px}
.chathead .back{margin:0}
.chid{font-weight:600;font-size:13px}
.chclose{margin-left:auto}
.back:hover{color:var(--color-text,#ddd);text-decoration:underline}
/* console: shared stream surface for task logs AND chat */
.console{background:var(--color-console-bg,#0a0a0a);color:var(--color-console-fg,#d7d7d7);border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:14px 16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin-top:12px;max-height:calc(100vh - 240px)}
pre{background:var(--color-console-bg,#0a0a0a);color:var(--color-console-fg,#d7d7d7);border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:14px 16px;overflow-x:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.bar{height:6px;background:var(--color-secondary-alpha-20,#1a1a1a);border-radius:3px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--color-primary,#7ab);border-radius:3px}
/* chat — same console/indicator language as the task views */
#msgs{flex:1;min-height:0;overflow-y:auto;border:1px solid var(--color-console-border,#2a2a2a);border-radius:var(--radius);padding:10px 14px;margin:12px 0;background:var(--color-console-bg,transparent)}
.muser{background:var(--color-secondary-alpha-20,rgba(90,140,255,.1));border:1px solid var(--color-light-border,#2a2a2a);border-radius:var(--radius-sm);padding:9px 13px;margin:9px 0;white-space:pre-wrap;font-size:13px}
.muser::before{content:"you";display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--color-primary-light-1,#7cf);margin-bottom:3px}
.mtext{border-left:3px solid var(--color-primary,#7ab);padding:4px 13px;margin:9px 0;white-space:pre-wrap;font-size:13px}
.mtool{color:var(--color-text-light-2,#888);font-size:12px;margin:6px 0;word-break:break-word;border-left:2px solid var(--color-light-border,#333);padding-left:10px}
.mtool code{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.merr{color:var(--color-error-text,#f76);font-size:12.5px;margin:8px 0;white-space:pre-wrap}
.msettle{color:var(--color-text-light-3,#666);font-size:11.5px;margin:12px 0;text-align:right}
.mcompacted{color:var(--color-text-light-3,#666);font-size:11.5px;margin:12px 0;text-align:center}
.mstatus{color:var(--color-primary-light-1,#7cf);font-size:12.5px;margin:8px 0;opacity:.85}
.mend{color:var(--color-warning-text,#fc6);font-size:12.5px;margin:12px 0;text-align:center;border-top:1px solid var(--color-light-border,#333);padding-top:10px}
.chatin{display:flex;gap:8px;align-items:stretch;flex:none;margin-top:4px}
.ctxline{flex:none;margin-top:6px;min-height:1em}
.chatin.endednote{align-items:center}
.chatbtns{display:flex;flex-direction:column;gap:8px;align-items:stretch}
.chatbtns .ic{display:inline-block;margin-right:7px;vertical-align:middle;transform:translateY(-1px)}
#send{border-color:var(--color-success-text,#3a3)}
#send .ic{color:var(--color-success-text,#3a3)}
#send:hover{border-color:var(--color-success-text,#6d6);background:rgba(90,200,90,.14)}
#stop{border-color:var(--color-error-text,#a33)}
#stop .ic{color:var(--color-error-text,#a33)}
#stop:hover{border-color:var(--color-error-text,#f66);background:rgba(255,90,90,.14)}
.chatin textarea{flex:1;background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);border-radius:var(--radius-sm);color:var(--color-input-text,#ddd);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;resize:vertical}
.chatin textarea:focus{outline:none;border-color:var(--color-primary,#7ab)}
.chatin button,#newchat button{background:var(--color-button-secondary-background,#222);border:1px solid var(--color-button-secondary-border,#444);color:var(--color-button-secondary-text,#ddd);border-radius:var(--radius-sm);padding:7px 15px;cursor:pointer;font-size:13px}
.chatin button:hover,#newchat button:hover{border-color:var(--color-primary,#7ab);color:var(--color-text,#fff)}
#newchat{display:flex;gap:8px;margin:12px 0}
#newchat select{background:var(--color-input-background,#0c0c0c);border:1px solid var(--color-input-border,#333);color:var(--color-input-text,#ddd);border-radius:var(--radius-sm);padding:7px}
@media (min-width:768px){
  .sidebar{transform:none}
  #navToggle,#backdrop{display:none}
  #topbar{left:200px}
  main{margin-left:200px;padding:68px 32px 28px}
  main.app{padding:68px 24px 12px}
}
</style></head><body>
<div class="layout${app ? ' app' : ''}">${top}${side}<main class="${app ? 'app' : ''}">${bodyHtml}</main></div>
${script}${live}</body></html>`;
}

export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
export function ctxLine(t) {
  if (t.tokens == null || !t.model_ctx) return '';
  const pct = Math.min(100, Math.round((t.tokens / t.model_ctx) * 100));
  return ` · <span class="ctx" title="context used / window">${fmtTok(t.tokens)}/${fmtTok(t.model_ctx)} tok (${pct}%)</span>`;
}
