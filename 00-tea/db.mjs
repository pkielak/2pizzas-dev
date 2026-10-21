import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CFG } from './config.mjs';

// ── state ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(CFG.dataDir, 'logs'), { recursive: true });

export const db = new DatabaseSync(path.join(CFG.dataDir, '00-tea.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT,
  comment_id  INTEGER,
  repo        TEXT NOT NULL,
  issue       INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'comment' | 'review'
  cpath       TEXT,
  line        INTEGER,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|success|failure
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(repo, kind, comment_id);
CREATE TABLE IF NOT EXISTS poll_state (
  repo TEXT PRIMARY KEY,
  since TEXT
);
CREATE TABLE IF NOT EXISTS chat_grants (
  repo       TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS managed_repos (
  owner    TEXT NOT NULL,
  name     TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, name)
);
`);
for (const col of ['body TEXT', 'model TEXT', 'model_ctx INTEGER', 'tokens INTEGER',
  'parent_id INTEGER',  // review chain: the task this one was spawned by
  'round INTEGER',      // work round (1 = original, N+1 = rework after review N)
  'pr INTEGER',         // PR the work landed in (known at review-enqueue time)
  'retried_of INTEGER']) { // set when this task is the auto-retry of a failed one
  try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already present */ }
}
db.exec('UPDATE tasks SET round = 1 WHERE round IS NULL'); // backfill pre-chain rows

export const logPath = (id) => path.join(CFG.dataDir, 'logs', `${id}.log`);
export const readLog = (id) => {
  try { return fs.readFileSync(logPath(id), 'utf8'); }
  catch { return ''; }
};
