import { CFG, MENTIONS } from './config.mjs';
import { db } from './db.mjs';
import { managedRepos } from './repos.mjs';
import { apiGet } from './gitea.mjs';
import { enqueue } from './queue.mjs';

// ── poll fallback (rescues lost webhooks) ───────────────────────────────────

async function pollRepo(repo) {
  const st = db.prepare('SELECT since FROM poll_state WHERE repo=?').get(repo);
  const since = st?.since ? new Date(st.since) : new Date(Date.now() - 3600_000);

  // the read-only review token — the poller only reads
  const tok = { token: CFG.review.token };
  const issues = await apiGet(`/repos/${repo}/issues?state=open&limit=50`, tok);
  for (const iss of issues) {
    const cs = await apiGet(`/repos/${repo}/issues/${iss.number}/comments?limit=50`, tok);
    for (const c of cs) {
      if (new Date(c.created_at) < since) continue;
      for (const m of MENTIONS)
        enqueue({ repo, issue: iss.number, agent: m.agent, kind: 'comment', comment: c, sender: c.user?.login });
    }
  }

  const prs = await apiGet(`/repos/${repo}/pulls?state=open&limit=25`, tok);
  for (const pr of prs) {
    const cs = (await apiGet(`/repos/${repo}/pulls/${pr.number}/comments?limit=50`, { ...tok, ok404: true })) ?? []; // 404 = no review comments
    for (const c of cs) {
      if (new Date(c.created_at) < since) continue;
      for (const m of MENTIONS)
        enqueue({ repo, issue: pr.number, agent: m.agent, kind: 'review', comment: c, sender: c.user?.login });
    }
  }

  db.prepare(
    `INSERT INTO poll_state (repo, since) VALUES (?, ?)
     ON CONFLICT(repo) DO UPDATE SET since=excluded.since`
  ).run(repo, new Date().toISOString());
}

async function poll() {
  for (const repo of managedRepos()) {
    try { await pollRepo(repo); }
    catch (e) { console.error(`[poll] ${repo}: ${e.message}`); }
  }
}
setInterval(poll, CFG.pollIntervalMs).unref?.();
