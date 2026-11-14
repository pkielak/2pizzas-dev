// Server-rendered task rows — used by home.mjs (not SPA-migrated yet).
// The /tasks list and /task/<id> detail pages are SPA (src/pages/
// Tasks.svelte, TaskDetail.svelte) and gone from here.
import { db } from '../db.mjs';
import { esc, ctxLine } from './layout.mjs';

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
