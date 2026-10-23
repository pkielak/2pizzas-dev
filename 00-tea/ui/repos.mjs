import { CFG } from '../config.mjs';
import { db } from '../db.mjs';
import { managedRepos } from '../repos.mjs';
import { execFileP } from '../util.mjs';
import { esc } from './layout.mjs';

export async function reposPage() {
  // webhook is GLOBAL (is_system_webhook row, covers every repo) — no API for
  // it in Gitea 1.27, so check the same way seed.sh writes it: via psql
  let hookLine;
  try {
    const out = await execFileP('docker', ['exec', CFG.giteaDbContainer, 'psql', '-U', CFG.giteaDbUser, '-d', CFG.giteaDbName, '-tAc', "SELECT id FROM webhook WHERE is_system_webhook AND url LIKE '%:3001/webhook' LIMIT 1"], { timeout: 5000 });
    const id = out.trim(); // execFileP resolves the stdout string
    hookLine = id
      ? `<p>global webhook: <span class="hook ok">✓ id ${id} — fires for every repo, new ones included</span></p>`
      : `<p>global webhook: <span class="hook bad">✗ missing — run ./seed.sh</span></p>`;
  } catch { hookLine = `<p>global webhook: <span class="hook bad">✗ check failed (gitea-db unreachable?)</span></p>`; }
  const rows = (await Promise.all(managedRepos().map(async (r) => {
    const tot = db.prepare('SELECT COUNT(*) n FROM tasks WHERE repo=?').get(r).n;
    const ok = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='success'").get(r).n;
    const bad = db.prepare("SELECT COUNT(*) n FROM tasks WHERE repo=? AND status='failure'").get(r).n;
    const last = db.prepare('SELECT MAX(created_at) t FROM tasks WHERE repo=?').get(r).t;
    const added = db.prepare('SELECT added_at FROM managed_repos WHERE owner=? AND name=?').get(...r.split('/'))?.added_at;
    const auto = !CFG.repos.includes(r);
    return `<a class="item gl" data-repo="${esc(r)}" href="#">
    <div class="l1">${esc(r)} <span class="meta">${auto ? `auto · ${esc(added ?? '')}` : 'env'}</span>${auto ? ` <span class="del" data-repo="${esc(r)}" title="remove from managed repos">✕</span>` : ''}</div>
    <div class="l2">${tot} tasks (${ok} ok / ${bad} failed) · last activity: ${esc(last ?? '—')}</div>
  </a>`;
  }))).join('');
  return {
    html: `${hookLine}
<div class="list">${rows}</div>
<p class="meta">repos self-enroll: mention <code>@pi</code> or <code>@opencode</code> on an issue in ANY repo — 00-tea persists it and grants the bot write access automatically. <code>AGENTD_REPOS</code> in .env pins repos (no ✕); the ✕ removes a self-enrolled repo (its bot collaborator grant stays in Gitea — remove it there too if you want it gone)</p>`,
    script: `<script>window.__pageInit = function(){
document.querySelectorAll('a.gl').forEach(a=>a.href=location.protocol+'//'+location.hostname+':3000/'+a.dataset.repo);
document.querySelectorAll('span.del').forEach(s=>s.onclick=(e)=>{e.preventDefault();e.stopPropagation();
  if (!confirm('remove '+s.dataset.repo+' from managed repos?')) return;
  fetch('/api/repos/'+encodeURIComponent(s.dataset.repo),{method:'DELETE'}).then(()=>location.reload());
});
};</script>`,
  };
}
