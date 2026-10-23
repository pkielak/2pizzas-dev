import { CFG } from '../config.mjs';
import { apiGet } from '../gitea.mjs';
import { esc } from './layout.mjs';

// ── android builds (Gitea Actions runs on the `android` label) ─────────────
// The runs API does not expose the runner/label — that lives on the JOBS — so
// a run is an "android build" iff one of its jobs carries the `android` label
// (same opt-in the runner uses: runs-on: android).
export async function androidRuns(limit = 30) {
  const runs = (await apiGet(`/admin/actions/runs?limit=${limit}`, { token: CFG.adminToken })).workflow_runs;
  const withJobs = await Promise.all(runs.map(async (r) => {
    let jobs = [];
    try {
      const j = await apiGet(`/repos/${r.repository.owner.login}/${r.repository.name}/actions/runs/${r.id}/jobs`,
        { token: CFG.adminToken, ok404: true });
      jobs = (j && j.jobs) || [];
    } catch { /* jobs unavailable — treated as non-android */ }
    r.jobs = jobs;
    r.isAndroid = jobs.some((j) => (j.labels || []).includes('android'));
    return r;
  }));
  return withJobs.filter((r) => r.isAndroid);
}

function runPill(r) {
  if (['queued', 'waiting', 'pending', 'running'].includes(r.status)) return `<span class="running">${esc(r.status)}</span>`;
  if (r.conclusion === 'success') return '<span class="success">success</span>';
  if (r.conclusion === 'failure') return '<span class="failure">failure</span>';
  if (r.conclusion === 'cancelled') return '<span class="queued">cancelled</span>';
  return `<span class="queued">${esc(r.status || '—')}</span>`;
}

export function runRows(runs) {
  return runs.map((r) => `<a class="item glink" data-repo="${esc(r.repository.full_name)}" data-run="${r.id}" href="#">
    <div class="l1">${runPill(r)} <span>#${r.id}</span> ${esc(r.repository.full_name)} · ${esc(r.head_branch || '')}</div>
    <div class="l2">${esc((r.display_title || '').slice(0, 140))}${r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ''} · ${esc((r.started_at || '—').replace('T', ' ').slice(0, 19))}</div>
  </a>`).join('\n');
}

export async function androidPage() {
  let runs = [], err = null;
  if (!CFG.adminToken) err = 'ADMIN_TOKEN not set — cannot list actions runs (add it to 00-tea in docker-compose.yml)';
  else { try { runs = await androidRuns(30); } catch (e) { err = e.message; } }
  return {
    html: `${err ? `<p class="err">${esc(err)}</p>` : ''}
<div class="list">${runs.length ? runRows(runs) : '<div class="item"><div class="l2">no android builds yet — jobs opt in with <code>runs-on: android</code></div></div>'}</div>
<p class="meta">built on <code>android-runner</code> (label <code>android</code>, image <code>gitea-android:latest</code>: JDK 21 + Android SDK + warm ~/.gradle) — separate from <code>my-runner</code> (ordinary CI)</p>`,
    script: `<script>window.__pageInit = function(){ glinkFix(); };</script>`,
  };
}
