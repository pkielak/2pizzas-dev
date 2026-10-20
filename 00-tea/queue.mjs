import { CFG, MARKER, MENTIONS } from './config.mjs';
import { db } from './db.mjs';
import { isManaged } from './repos.mjs';
import { kick } from './kick.mjs';
import { liveBroadcast } from './live.mjs';

// ── enqueue ──────────────────────────────────────────────────────────────────

export function enqueue({ repo, issue, agent, kind, comment, sender, eventId }) {
  const body = comment?.body ?? '';
  if (!isManaged(repo)) return;                     // global webhook: only act on managed repos
  if (sender === CFG.botLogin || sender === CFG.chatLogin) return; // never react to our own agents (task bot + chat user)
  if (body.includes(MARKER)) return;                 // loop prevention
  if (!MENTIONS.some((m) => m.agent === agent && m.re.test(body))) return;

  const exists = db
    .prepare('SELECT 1 FROM tasks WHERE repo = ? AND kind = ? AND comment_id = ?')
    .get(repo, kind, comment.id);
  if (exists) return;

  db.prepare(
    `INSERT INTO tasks (event_id, comment_id, repo, issue, agent, kind, cpath, line, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId ?? null, comment.id, repo, issue, agent, kind, comment.path ?? null, comment.line ?? null, body);
  console.log(`[enqueue] task for ${repo}#${issue} @${agent} (${kind}, comment ${comment.id})`);
  kick(); // start it now, don't wait for the 2s pump tick
  liveBroadcast('tasks');
}

// Internal review-chain tasks: enqueued by 00-tea itself (never via the
// webhook — agent comments carry the via:agent marker and are ignored).
// comment_id is NULL, so the (repo, kind, comment_id) webhook dedupe never
// matches them; the parent_id+kind checks below are their loop guard.
export function enqueueReview(work, logText) {
  if (!CFG.reviewToken) {
    console.log(`[review] task ${work.id}: REVIEW_TOKEN not set — review chain skipped`);
    return;
  }
  const dup = db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND kind = 'agent-review'").get(work.id);
  if (dup) return;
  const pr = /\[00-tea\] pr: #(\d+)/.exec(logText)?.[1] ?? null;
  db.prepare(
    `INSERT INTO tasks (repo, issue, agent, kind, body, parent_id, round, pr)
     VALUES (?, ?, 'review', 'agent-review', ?, ?, ?, ?)`
  ).run(work.repo, work.issue, work.body ?? null, work.id, work.round ?? 1, pr ? +pr : null);
  console.log(`[review] task ${work.id} pushed → review enqueued (round ${work.round ?? 1}${pr ? `, PR #${pr}` : ''})`);
  kick();
  liveBroadcast('tasks');
}

export function enqueueRework(review, concerns) {
  const work = db.prepare('SELECT * FROM tasks WHERE id = ?').get(review.parent_id);
  const dup = db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND kind = 'rework'").get(review.id);
  if (dup) return;
  db.prepare(
    `INSERT INTO tasks (repo, issue, agent, kind, body, parent_id, round, pr)
     VALUES (?, ?, ?, 'rework', ?, ?, ?, ?)`
  ).run(review.repo, review.issue, work?.agent ?? 'pi', concerns, review.id, (review.round ?? 1) + 1, review.pr ?? null);
  console.log(`[review] task ${review.id} verdict=fail → rework enqueued (round ${(review.round ?? 1) + 1}, @${work?.agent ?? 'pi'})`);
  kick();
  liveBroadcast('tasks');
}
