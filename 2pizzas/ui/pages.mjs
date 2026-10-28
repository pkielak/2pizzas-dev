import { CFG } from '../config.mjs';
import { execFileP } from '../util.mjs';
import { esc } from './layout.mjs';

// ── gh-pages sites (pages/ service instances) ─────────────────────────────
// PAGES_SITES entries: repo:port:container (e.g. owner/my-repo:3002:gitea-pages)
export async function pagesStatus() {
  return Promise.all(CFG.pagesSites.map(async (s) => {
    const [repo, port, container] = s.split(':');
    let commit = null, err = null;
    try {
      const out = (await execFileP('docker', ['exec', container, 'git', '-C', '/srv/pages', 'log', '-1', '--format=%h|%cI|%s'])).trim();
      const [h, at, ...rest] = out.split('|');
      commit = { h, at, s: rest.join('|') };
    } catch (e) { err = e.message; }
    return { repo, port, container, commit, err };
  }));
}

export async function pagesPage() {
  const sites = await pagesStatus();
  const rows = sites.map((s) => `<a class="item plink" data-port="${esc(s.port)}" href="#">
    <div class="l1">${esc(s.repo)} <span class="meta">:${esc(s.port)}</span></div>
    <div class="l2">${s.commit
      ? `${esc(s.commit.h)} · ${esc(s.commit.at)} · ${esc(s.commit.s)}`
      : `<span class="err">not synced (${esc(s.err ?? 'no checkout')})`}</div>
  </a>`).join('\n');
  return {
    html: `<div class="list">${rows || '<div class="item"><div class="l2">no sites — set PAGES_SITES in .env (repo:port:container per pages service)</div></div>'}</div>
<p class="meta">each site is a <code>pages/</code> compose service serving a repo's <code>gh-pages</code> branch (CI pushes the branch, the server syncs every 60s). add one: new compose service (see <code>browser-llm-bench-pages</code>) → append <code>repo:port:container</code> to PAGES_SITES → <code>docker compose up -d 2pizzas</code></p>`,
    script: `<script>window.__pageInit = function(){
document.querySelectorAll('a.plink').forEach(a=>a.href=location.protocol+'//'+location.hostname+':'+a.dataset.port);
};</script>`,
  };
}
