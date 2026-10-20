import { CFG } from '../config.mjs';
import { db } from '../db.mjs';
import { esc } from './layout.mjs';
import { androidRuns, runRows } from './android.mjs';
import { pagesStatus } from './pages.mjs';
import { taskRows } from './tasks.mjs';

// Pages return { html, script }: html is the <main> body (swapped in place
// on live updates), script is rendered OUTSIDE main once and re-runs
// window.__pageInit after every swap (see layout.mjs LIVE_SCRIPT).

// ── home — latest from every section ───────────────────────────────────────
export async function homePage() {
  const [runs, sites] = await Promise.all([
    CFG.adminToken ? androidRuns(8).catch(() => []) : Promise.resolve([]),
    pagesStatus(),
  ]);
  const siteRows = sites.map((s) => `<a class="item plink" data-port="${esc(s.port)}" href="#">
    <div class="l1">${esc(s.repo)} <span class="meta">:${esc(s.port)}</span></div>
    <div class="l2">${s.commit
      ? `${esc(s.commit.h)} · ${esc(s.commit.at)} · ${esc(s.commit.s)}`
      : `<span class="err">not synced (${esc(s.err ?? 'no checkout')})`}</div>
  </a>`).join('\n');
  const latestTask = db.prepare('SELECT status, created_at FROM tasks ORDER BY id DESC LIMIT 1').get();
  const runningN = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running')").get().n;
  const runN = runs.filter((r) => ['queued', 'waiting', 'pending', 'running'].includes(r.status)).length;
  return {
    html: `<h1>home</h1>
<p class="meta">${runningN ? `<span class="running">${runningN} task${runningN > 1 ? 's' : ''} in flight</span> · ` : ''}${latestTask ? `last task ${esc(latestTask.status)} at ${esc(latestTask.created_at)}` : 'no tasks yet'}${runN ? ` · <span class="running">${runN} android build${runN > 1 ? 's' : ''} in flight</span>` : ''}</p>
<h2>latest tasks</h2><div class="list">${taskRows(5) || '<div class="item"><div class="l2">no tasks yet</div></div>'}</div>
<p><a href="/tasks">all tasks →</a></p>
<h2>latest android builds</h2><div class="list">${runs.length ? runRows(runs) : '<div class="item"><div class="l2">no android builds yet</div></div>'}</div>
<p><a href="/android">all builds →</a></p>
<h2>pages</h2><div class="list">${siteRows || '<div class="item"><div class="l2">no sites configured</div></div>'}</div>
<p><a href="/pages">pages →</a></p>`,
    script: `<script>window.__pageInit = function(){
glinkFix();document.querySelectorAll('a.plink').forEach(a=>a.href=location.protocol+'//'+location.hostname+':'+a.dataset.port);
};</script>`,
  };
}
