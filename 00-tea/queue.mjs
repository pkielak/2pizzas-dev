import { CFG, MARKER, MENTIONS } from './config.mjs';
import { db, readLog } from './db.mjs';
import { apiPost } from './gitea.mjs';
import { isManaged } from './repos.mjs';
import { kick } from './kick.mjs';
import { liveBroadcast } from './live.mjs';

// ── enqueue ──────────────────────────────────────────────────────────────────

// never react to our own agents: per-agent users, the dormant legacy "bot",
// and the chat user (all of them also stamp the via:agent marker)
const AGENT_SENDERS = new Set([
  CFG.botLogin, CFG.chatLogin, CFG.review.login,
  ...Object.values(CFG.agents).map((a) => a.login),
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

// Internal review-chain tasks: enqueued by 00-tea itself (never via the
// webhook — agent comments carry the via:agent marker and are ignored).
// comment_id is NULL, so the (repo, kind, comment_id) webhook dedupe never
// matches them; the parent_id+kind checks below are their loop guard.
export function enqueueReview(work, logText) {
  if (!CFG.review.token) {
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

// ── failure handling: retry once + infra agent ───────────────────────────────

// Infra-class failures: the stack died UNDER the agent (dockerd restart →
// SIGTERM 143, OOM/host kill → 137, SIGINT 130, docker/host errors) — not the
// agent's fault. Agent-class failures (bad model run, no-action, review
// issues) are NOT retried and do NOT wake the infra agent.
// Infra-class: the stack died UNDER the agent (dockerd restart → SIGTERM 143,
// OOM/host kill → 137, SIGINT 130, docker/host errors) OR a host-unreachable
// git clone (exit 128 + a connection/resolve failure in the LOG). A bare
// "exited with code 128" is NOT infra-class on its own — that can be a legit
// auth/repo failure; the connection signature is what makes it a stack issue.
const INFRA_ERR = /(exited with code (130|137|143)\b|docker: |no such host|ECONNREFUSED|connection (refused|timed out)|couldn't connect to server|could not resolve host|failed to connect to)/i;

export function onTaskFailure(t, msg) {
  if (t.kind === 'agent-infra') return; // never auto-chase the infra agent
  // a host-unreachable git clone surfaces as "agent exited with code 128" in
  // e.message, but the connection detail ("Couldn't connect to server") is in
  // the LOG — scan the tail too, so the infra agent gets woken for it
  const logTail = readLog(t.id).slice(-4000);
  if (!INFRA_ERR.test(msg) && !INFRA_ERR.test(logTail)) return;
  // 1. retry the victim once (a killed review was 90% done — don't lose it).
  //    Same fields, so the review chain links off the retry as usual; the
  //    retried_of guard makes this idempotent.
  if (t.retried_of == null) {
    db.prepare(
      `INSERT INTO tasks (repo, issue, agent, kind, cpath, line, body, parent_id, round, pr, retried_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(t.repo, t.issue, t.agent, t.kind, t.cpath, t.line, t.body, t.parent_id, t.round, t.pr, t.id);
    console.log(`[failure] task ${t.id} infra-class (${msg}) → retry enqueued`);
  }
  // 2. wake the infra agent to fix the stack
  enqueueInfra(t, msg).catch((e) => console.error(`[infra] task ${t.id}: ${e.message}`));
}

// One infra task per cooldown window: a single dockerd stop can kill several
// tasks at once — later failures in the window append to the existing
// incident issue instead of storming one agent per task.
export async function enqueueInfra(failed, errMsg) {
  if (!CFG.infraHostRepo) {
    console.log('[infra] INFRA_HOST_REPO not set — infra agent skipped');
    return;
  }
  const ctx = `Task ${failed.id} (${failed.kind}, @${failed.agent}) on ${failed.repo}#${failed.issue} failed:\n${errMsg}\n\nLog tail:\n\`\`\`\n${readLog(failed.id).slice(-2000)}\n\`\`\``;
  const last = db.prepare(`SELECT id, issue, created_at FROM tasks WHERE kind = 'agent-infra' ORDER BY id DESC LIMIT 1`).get();
  const tok = { token: CFG.agents.infra.token }; // 00-tea posts as the infra user
  if (last && Date.now() - Date.parse(last.created_at.replace(' ', 'T') + 'Z') < CFG.infraCooldownMs) {
    await apiPost(`/repos/${CFG.infraRepo}/issues/${last.issue}/comments`, {
      body: `Another task failed in the same window:\n\n${ctx}\n\n${MARKER}`,
    }, tok);
    console.log(`[infra] task ${failed.id} → appended to incident issue #${last.issue}`);
    return;
  }
  const issue = await apiPost(`/repos/${CFG.infraRepo}/issues`, {
    title: `[00-tea] infra incident: task ${failed.id} failed — ${errMsg.slice(0, 80)}`,
    body: ctx,
  }, tok);
  // issue.number, NOT issue.id — the API returns the global db id in .id,
  // but task.issue is the per-repo number (comments/PRs address it)
  db.prepare(`INSERT INTO tasks (repo, issue, agent, kind, body, parent_id)
              VALUES (?, ?, 'infra', 'agent-infra', ?, ?)`)
    .run(CFG.infraRepo, issue.number, ctx, failed.id);
  console.log(`[infra] task ${failed.id} → infra agent enqueued (${CFG.infraRepo}#${issue.id})`);
  kick();
  liveBroadcast('tasks');
}
