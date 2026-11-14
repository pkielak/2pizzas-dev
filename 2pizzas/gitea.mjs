import { CFG } from './config.mjs';

// ── Gitea API ────────────────────────────────────────────────────────────────
// Every call passes the acting identity's token explicitly — there is no
// single default token anymore (per-agent users; see config.mjs).

export async function apiGet(p, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    headers: { Authorization: `token ${opts.token}` },
  });
  if (res.status === 404 && opts.ok404) return null;
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

// android builds: the runs API doesn't expose the runner/label — that
// lives on the JOBS — so a run is an "android build" iff one of its jobs
// carries the `android` label (same opt-in the runner uses: runs-on: android)
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

export async function apiPost(p, body, opts = {}) {
  const res = await fetch(`${CFG.giteaApi}${p}`, {
    method: 'POST',
    headers: { Authorization: `token ${opts.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}`);
  return res.json();
}
