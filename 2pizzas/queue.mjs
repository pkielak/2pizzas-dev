import { CFG, MARKER, MENTIONS } from './config.mjs';
import { db } from './db.mjs';
import { apiPost } from './gitea.mjs';
import { isManaged } from './repos.mjs';
import { kick } from './kick.mjs';
import { liveBroadcast } from './live.mjs';

// ── enqueue ──────────────────────────────────────────────────────────────────

// never react to our own agents: per-agent users, the dormant legacy "bot",
// and the review user (all of them also stamp the via:agent marker).
// NOTE: the chat user is NOT here — chat acts as a supervisor that delegates
// work by commenting @agent on issues/PRs, which MUST trigger tasks.
// Loop prevention is handled by the <!-- via:agent --> marker on all agent
// replies (post-comment.sh stamps it), and MENTIONS only match work agents.
const AGENT_SENDERS = new Set([
  CFG.botLogin, CFG.review.login,
  ...Object.values(CFG.agents).map((a) => a.login),
  ...CFG.dormantLogins,
]);

export function enqueue({ repo, issue, agent, kind, comment, sender, eventId }) {
  const body = comment?.body ?? '';
  if (!isManaged(repo)) return;                     // global webhook: only act on managed repos
  if (AGENT_SENDERS.has(sender)) return;
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

// Internal review-chain tasks: enqueued by 2pizzas itself (never via the
// webhook — agent comments carry the via:agent marker and are ignored).
// comment_id is NULL, so the (repo, kind, comment_id) webhook dedupe never
// matches them; the parent_id+kind checks below are their loop guard.
export function enqueueReview(work, logText) {
  if (!CFG.review.token) {
    console.log(`[review] task ${work.id}: AGENT_REVIEW_TOKEN not set — review chain skipped`);
    return;
  }
  const dup = db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND kind = 'agent-review'").get(work.id);
  if (dup) return;
  const pr = /\[2pizzas\] pr: #(\d+)/.exec(logText)?.[1] ?? null;
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

// ── failure handling ─────────────────────────────────────────────────────────

// No-action (the agent finished cleanly but pushed nothing and replied to
// nothing): model behavior, NOT a stack problem — retry up to 2 times, then
// post a give-up comment and stop.
// Any other failure gets ONE retry (a killed review was 90% done — don't
// lose it); if the retry also fails, a line is logged for a human to
// investigate the root cause (bad prompt, model misconfig, missing tool,
// stack problem).
// The retried_of column links every retry to its victim.
const NO_ACTION = /took no action|no-action/i;

export function onTaskFailure(t, msg) {
  if (NO_ACTION.test(msg)) {
    // consecutive no-action failures up the retry chain, including t itself
    let n = 1, cur = t;
    for (;;) {
      const orig = cur.retried_of != null
        ? db.prepare('SELECT * FROM tasks WHERE id=?').get(cur.retried_of) : null;
      if (!orig) break;
      if (NO_ACTION.test(orig.error ?? '')) n++;
      cur = orig;
    }
    if (n <= 2) { // n attempts so far → n-1 retries used; allow 2
      db.prepare(
        `INSERT INTO tasks (repo, issue, agent, kind, cpath, line, body, parent_id, round, pr, retried_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(t.repo, t.issue, t.agent, t.kind, t.cpath, t.line, t.body, t.parent_id, t.round, t.pr, t.id);
      console.log(`[failure] task ${t.id} no-action (attempt ${n}) → retry enqueued`);
      kick();
      liveBroadcast('tasks');
      return;
    }
    const id = t.agent === 'review' ? CFG.review : CFG.agents[t.agent]; // post as the task's agent user
    apiPost(`/repos/${t.repo}/issues/${t.issue}/comments`, {
      body: `[2pizzas] Giving up: the agent took no visible action ${n} times in a row (no commit, no PR, no reply). A human should take over.\n\n${MARKER}`,
    }, { token: id.token }).catch((e) => console.error(`[failure] task ${t.id}: give-up comment: ${e.message}`));
    console.log(`[failure] task ${t.id} no-action ${n}× → gave up, comment posted`);
    return;
  }
  // First failure: retry once. Same fields, so the review chain links off
  // the retry as usual; the retried_of guard makes this idempotent.
  if (t.retried_of == null) {
    db.prepare(
      `INSERT INTO tasks (repo, issue, agent, kind, cpath, line, body, parent_id, round, pr, retried_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(t.repo, t.issue, t.agent, t.kind, t.cpath, t.line, t.body, t.parent_id, t.round, t.pr, t.id);
    console.log(`[failure] task ${t.id} (${msg}) → retry enqueued`);
    kick();
    liveBroadcast('tasks');
    return;
  }
  // Retry also failed — log it for a human to investigate.
  console.log(`[failure] task ${t.id} failed twice (${msg}) — human should look`);
}
