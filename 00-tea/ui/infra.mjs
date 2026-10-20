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

    const dot = (ok, cx, cy) => `<circle cx="${cx}" cy="${cy}" r="5" fill="${ok === true ? 'var(--color-success-text,#6d6)' : ok === false ? 'var(--color-error-text,#f66)' : 'var(--color-text-light-2,#555)'}"/>`;
    const block = (x, y, w, h, title, lines, ok, href) => {
      const body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="var(--color-secondary-alpha-10,rgba(255,255,255,.03))" stroke="var(--color-light-border,#2a2a2a)"/>
${dot(ok, x + 18, y + 22)}
<text x="${x + 32}" y="${y + 26}" font-size="14" font-weight="700" fill="var(--color-text,#ddd)">${esc(title)}</text>
${lines.map((l, i) => `<text x="${x + 32}" y="${y + 46 + i * 17}" font-size="12" fill="var(--color-text-light-2,#999)">${l}</text>`).join('')}`;
      return href ? `<a href="${href}" style="text-decoration:none">${body}</a>` : body;
    };
    const label = (x, y, t, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="11.5" fill="var(--color-text-light-2,#888)" text-anchor="${anchor}">${t}</text>`;
    const rlabel = (x, y, t) => `<text transform="rotate(-90 ${x} ${y})" x="${x}" y="${y}" font-size="11.5" fill="var(--color-text-light-2,#888)" text-anchor="middle">${t}</text>`;
    const flow = 'stroke:var(--color-text-light-2,#666);stroke-width:1.5;fill:none';

    const loaded = models ? models.filter((m) => m.loaded).map((m) => m.id) : [];

    const svg = `<svg viewBox="0 0 980 600" style="width:100%;min-width:700px;display:block" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-text-light-2,#666)"/></marker></defs>
${block(30, 30, 250, 100, 'Gitea', ['server :3000 · postgres db', `${managedN} managed repo${managedN === 1 ? '' : 's'} · bot + chat users`], up('gitea') === null ? null : (up('gitea') && up('gitea-db-1')), '#gitea')}
${block(365, 30, 250, 100, '00-tea', ['dispatcher :3001 · sqlite queue', 'webhook receiver · task runner · chat'], up('gitea-00-tea'), '/tasks')}
${block(700, 30, 250, 100, 'llama.cpp router', [esc(CFG.llamaUrl), models ? (loaded.length ? `loaded: ${esc(loaded.join(', '))}` : 'reachable · no model loaded') : 'unreachable'], models ? true : false)}
${block(30, 280, 205, 90, '@pi', ['agent-sandbox:pi', agentBusy('pi') ? 'task in flight' : 'idle'], agentBusy('pi') ? true : null)}
${block(255, 280, 205, 90, '@opencode', ['agent-sandbox:opencode', agentBusy('opencode') ? 'task in flight' : 'idle'], agentBusy('opencode') ? true : null)}
${block(480, 280, 205, 90, '@review', ['agent-sandbox:review', 'read-only token · max ' + CFG.reviewMaxRounds + ' rounds', agentBusy('review') ? 'task in flight' : 'idle'], agentBusy('review') ? true : null)}
${block(705, 280, 205, 90, '@ops', ['agent-sandbox:ops', 'parked'], false)}
${block(30, 470, 225, 90, 'my-runner', ['label: ubuntu-latest', 'runc · ordinary CI'], up('gitea-runner'))}
${block(275, 470, 225, 90, 'android-runner', ['label: android', 'gitea-android:latest job image'], up('gitea-android-runner'))}
${block(520, 470, 190, 90, 'pages', [CFG.pagesSites.length ? CFG.pagesSites.map((s) => `${esc(s.split(':')[0])} :${esc(s.split(':')[1])}`).join(' · ') : 'no sites (PAGES_SITES)', 'serves gh-pages branches'], pagesUp)}
${block(730, 470, 220, 90, 'chat containers', ['long-lived runsc · chat user', chatN === null ? 'unknown' : chatN + ' active'], chatN === null ? null : chatN > 0)}
<path d="M 280 80 L 363 80" style="${flow}" marker-end="url(#arr)"/>
${label(322, 70, 'webhook · @agent comments (issue + PR)')}
<path d="M 470 130 L 132 278" style="${flow}" marker-end="url(#arr)"/>
<path d="M 470 130 L 357 278" style="${flow}" marker-end="url(#arr)"/>
<path d="M 510 130 L 582 278" style="${flow}" marker-end="url(#arr)"/>
<path d="M 530 130 L 807 278" style="${flow}" marker-end="url(#arr)"/>
${label(490, 158, 'docker run --runtime=runsc · one-shot per task')}
<path d="M 110 280 L 150 132" style="${flow}" marker-end="url(#arr)"/>
<path d="M 330 280 L 240 132" style="${flow}" marker-end="url(#arr)"/>
${label(200, 215, 'push · PR · comments (bot token)')}
<path d="M 807 280 L 825 132" style="${flow}" marker-end="url(#arr)"/>
${label(880, 215, 'llm /v1 · llama.cpp/<model>')}
<path d="M 30 100 L 18 100 L 18 505 L 28 505" style="${flow}" marker-end="url(#arr)"/>
${rlabel(12, 330, 'Gitea Actions (CI)')}
<path d="M 615 100 L 695 100 L 695 400 L 720 400 L 720 515 L 728 515" style="${flow}" marker-end="url(#arr)"/>
${rlabel(689, 280, 'long-lived runsc containers (chat user)')}
<path d="M 200 130 L 200 140 L 470 140 L 470 420 L 510 420 L 510 515 L 518 515" style="${flow}" marker-end="url(#arr)"/>
${rlabel(464, 280, 'syncs gh-pages branch (60s)')}
${dot(true, 40, 585)} ${label(52, 589, 'running', 'start')}
${dot(false, 130, 585)} ${label(142, 589, 'down', 'start')}
${dot(null, 205, 585)} ${label(217, 589, 'n/a · unknown', 'start')}
</svg>`;

    return `<h1>infra</h1>
<div style="overflow-x:auto">${svg}</div>
<p class="meta">live status: green dot = running (docker ps), red = down. every agent job runs one-shot in a gVisor (runsc) sandbox; 00-tea, the runners and Gitea itself run on the host. gVisor egress policy: <code>gitea-policy.yaml</code>.</p>
<script>document.querySelectorAll('a[href="#gitea"]').forEach(a=>a.href=location.protocol+'//'+location.hostname+':3000');</script>`;
  })();
}
