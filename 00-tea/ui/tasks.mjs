import fs from 'node:fs';
import { CFG } from '../config.mjs';
import { db, logPath } from '../db.mjs';
import { esc, ctxLine, fmtTok } from './layout.mjs';

export function taskRows(limit = 100) {
  return db.prepare(
    `SELECT * FROM tasks ORDER BY id DESC LIMIT ?`
  ).all(limit).map((t) => {
    const mid = [t.model ? ` · <span class="model">${esc(t.model)}</span>` : '', ctxLine(t)].filter(Boolean).join('');
    const chain = [
      t.kind === 'agent-review' || t.kind === 'rework' ? esc(t.kind) : '',
      (t.round ?? 1) > 1 ? `round ${t.round}` : '',
      t.parent_id ? `from #${t.parent_id}` : '',
    ].filter(Boolean).join(' · ');
    return `<a class="item" href="/task/${t.id}">
    <div class="l1"><span class="${t.status}">${t.status}</span> <span>#${t.id}</span> ${esc(t.repo)}#${t.issue}</div>
    <div class="l2">@${esc(t.agent)}${chain ? ` · ${chain}` : ''}${mid} · ${esc(t.created_at)}</div>
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
  </a>`;
  }).join('\n');
}

export function tasksPage() {
  const rows = taskRows(100);
  return `<h1>00-tea tasks</h1><div class="list">${rows}</div>`;
}

export function taskPage(t) {
  const kids = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(t.id).map((k) => k.id);
  const chain = [
    (t.round ?? 1) > 1 ? `round ${t.round}` : '',
    t.parent_id ? `parent <a href="/task/${t.parent_id}">#${t.parent_id}</a>` : '',
    kids.length ? `spawned ${kids.map((k) => `<a href="/task/${k}">#${k}</a>`).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const head = `<a class="back" href="/tasks">← back to tasks</a>
<div class="pagehead"><h1>task ${t.id} <span class="${t.status}">${t.status}</span>${t.status === 'running' ? '<span class="live">live</span>' : ''}</h1></div>
<p class="meta">${esc(t.repo)}#${t.issue} · @${esc(t.agent)}${[t.model ? ` · <span class="model">${esc(t.model)}</span>` : '', ctxLine(t)].filter(Boolean).join('')} · ${esc(t.kind)} · created ${esc(t.created_at)}
 · started ${esc(t.started_at ?? '—')} · finished ${esc(t.finished_at ?? '—')}
${chain ? `<br>${chain}` : ''}
${t.error ? `<br><span class="err">${esc(t.error)}</span>` : ''}</p>`;
  if (t.status === 'running') {
    // live view: SSE streams the log line-by-line as the container prints it
    return `${head}<div class="console" id="log">(waiting for output…)</div>
<script>
const pre = document.getElementById('log');
let stick = true; // follow the bottom unless the user scrolls up
const nearBottom = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
pre.addEventListener('scroll', () => { stick = nearBottom(); });
const es = new EventSource('/task/${t.id}/stream');
// every (re)connect replays the whole log from the start — keep the DOM in
// lockstep by clearing on open, so a dropped+auto-reconnected stream can't
// duplicate lines
es.onopen = () => { pre.textContent = ''; };
es.onmessage = (e) => {
  pre.textContent += e.data + '\\n';
  if (stick) pre.scrollTop = pre.scrollHeight;
};
es.addEventListener('done', () => location.reload());
// poll status so the page settles when the task finishes
const iv = setInterval(async () => {
  const j = await (await fetch('/api/task/${t.id}')).json();
  if (!['queued', 'running'].includes(j.status)) { clearInterval(iv); location.reload(); }
}, 2000);
</script>`;
  }
  const log = fs.existsSync(logPath(t.id))
    ? fs.readFileSync(logPath(t.id), 'utf8').split('\n').slice(-400).join('\n')
    : '(no log yet)';
  return `${head}<div class="console">${esc(log)}</div>`;
}
