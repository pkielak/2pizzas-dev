// Stats data (JSON) — shared by the SPA (src/pages/Stats.svelte via
// GET /api/stats). The old server-rendered statsPage() is gone: /stats
// serves the Svelte SPA shell (see SPA_ROUTES in server.mjs).
import { db } from '../db.mjs';

export function statsData() {
  const total = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  if (!total) return { total: 0 };
  const st = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all()) st[r.status] = r.n;
  const tok = db.prepare('SELECT COUNT(*) n, SUM(tokens) s, AVG(tokens) a, MAX(tokens) m FROM tasks WHERE tokens IS NOT NULL').get();
  const agents = db
    .prepare(
      `SELECT agent, COUNT(*) n, SUM(status='success') ok, SUM(tokens) tok, AVG(tokens) avgtok
       FROM tasks GROUP BY agent ORDER BY n DESC`)
    .all();
  const models = db
    .prepare(
      `SELECT model, COUNT(*) n, SUM(tokens) tok, AVG(tokens) avgtok, MAX(model_ctx) ctx
       FROM tasks WHERE model IS NOT NULL GROUP BY model ORDER BY tok DESC`)
    .all();
  const daily = db
    .prepare(
      `SELECT date(created_at) d, COUNT(*) n, SUM(status='success') ok, SUM(status='failure') bad, SUM(tokens) tok
       FROM tasks WHERE created_at >= datetime('now', '-13 days') GROUP BY d ORDER BY d DESC`)
    .all();
  const maxDay = Math.max(1, ...daily.map((d) => d.n));
  return { total, st, tok, agents, models, daily, maxDay };
}
