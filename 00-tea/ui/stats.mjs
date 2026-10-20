import { db } from '../db.mjs';
import { esc, fmtTok } from './layout.mjs';

export function statsPage() {
  const total = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  if (!total) return `<h1>stats</h1><p class="meta">no tasks yet</p>`;
  const st = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) st[r.status] = r.n;
  const tok = db.prepare('SELECT COUNT(*) n, SUM(tokens) s, AVG(tokens) a, MAX(tokens) m FROM tasks WHERE tokens IS NOT NULL').get();
  const agents = db.prepare(
    `SELECT agent, COUNT(*) n, SUM(status='success') ok, SUM(tokens) tok, AVG(tokens) avgtok
     FROM tasks GROUP BY agent ORDER BY n DESC`).all();
  const models = db.prepare(
    `SELECT model, COUNT(*) n, SUM(tokens) tok, AVG(tokens) avgtok, MAX(model_ctx) ctx
     FROM tasks WHERE model IS NOT NULL GROUP BY model ORDER BY tok DESC`).all();
  const daily = db.prepare(
    `SELECT date(created_at) d, COUNT(*) n, SUM(status='success') ok, SUM(status='failure') bad, SUM(tokens) tok
     FROM tasks WHERE created_at >= datetime('now', '-13 days') GROUP BY d ORDER BY d DESC`).all();
  const maxDay = Math.max(1, ...daily.map((d) => d.n));
  const tk = (v) => (v == null ? '—' : fmtTok(Math.round(v)));

  return `<h1>stats</h1>
<p class="meta">${total} tasks · <span class="success">${st.success ?? 0} success</span> · <span class="failure">${st.failure ?? 0} failed</span>${st.running ? ` · <span class="running">${st.running} running</span>` : ''}${st.queued ? ` · <span class="queued">${st.queued} queued</span>` : ''}</p>
<h2>tokens</h2><div class="list"><div class="item">
  <div class="l1">${tk(tok.s)} total</div>
  <div class="l2">${tok.n} tasks measured · avg ${tk(tok.a)} · max ${tk(tok.m)} per task</div>
</div></div>
<h2>by model</h2><div class="list">${models.map((m) => `<div class="item">
  <div class="l1">${esc(m.model)} <span class="meta">${m.n} tasks${m.ctx ? ` · ctx ${fmtTok(m.ctx)}` : ''}</span></div>
  <div class="l2">${m.tok ? `${tk(m.tok)} tok · avg ${tk(m.avgtok)}` : 'no token data yet'}</div>
</div>`).join('') || '<div class="item"><div class="l2">no model data yet</div></div>'}</div>
<h2>by agent</h2><div class="list">${agents.map((a) => `<div class="item">
  <div class="l1">@${esc(a.agent)} <span class="meta">${a.n} tasks · ${a.ok ?? 0} ok</span></div>
  <div class="l2">${a.tok ? `${tk(a.tok)} tok · avg ${tk(a.avgtok)}` : 'no token data yet'}</div>
</div>`).join('')}</div>
<h2>last 14 days</h2><div class="list">${daily.map((d) => `<div class="item">
  <div class="l1">${esc(d.d)} <span class="meta">${d.n} tasks · ${d.ok ?? 0} ok${d.bad ? ` · <span class="err">${d.bad} failed</span>` : ''}${d.tok ? ` · ${tk(d.tok)} tok` : ''}</span></div>
  <div class="bar"><i style="width:${Math.round((d.n / maxDay) * 100)}%"></i></div>
</div>`).join('') || '<div class="item"><div class="l2">nothing in the last 14 days</div></div>'}</div>`;
}
