// Funky stats — satirical roast-metrics computed SERVER-SIDE from real dev
// data: Gitea (issues, PRs, reviews, diff files) + the dispatcher task DB.
// Consumed by the SPA (src/pages/Funky.svelte via GET /api/funky).
//
// A stat that cannot be computed is `value: null` → the UI renders
// "no data (yet)" (honest satire — never a fake 0).

import { db, readLog } from '../db.mjs';
import { CFG } from '../config.mjs';
import { apiGet } from '../gitea.mjs';
import { managedRepos } from '../repos.mjs';

const ZOMBIE_DAYS = 14;

// state=all list with pagination (issues + PRs + diff files) — capped at
// 20 pages × 50 = 1000 items per list (silently undercounts bigger repos)
async function listAll(p) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await apiGet(`${p}&limit=50&page=${page}`, { token: CFG.adminToken });
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3.6e6;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// file-looking tokens ("src/foo.mjs", "server.mjs") — the set of files the
// original ask named. An approximation by design; it roasts, it does not
// audit.
const FILE_RE = /[\w./-]+\.[a-z0-9]{1,5}\b/gi;

// RULE 2 of feature creep — the PR confesses extra scope in its own words.
const CREEP_RE = /\b(while (i )?(was|am) at it|drive[- ]?by|bonus|throw (it|this) in|while we'?re here|in passing|sneak(?:ed|y)? (?:it|this) in|scope creep|feature creep|also (?:added|fixed|included|updated|created))\b/i;

// the marker a work agent adds to its reply comment when the user's request
// drifts into feature creep (prompts.mjs teaches the convention) — each
// occurrence is one agent-bumped instance.
const SCOPE_FLAG_RE = /<!--\s*scope-creep\s*-->/g;

// Gitea identities that are machines, not humans — a review by one of them
// is not the human coverage the "merges without reviews" stat measures.
const AGENT_LOGINS = new Set([
  ...Object.values(CFG.agents).map((a) => a.login),
  CFG.review.login, CFG.botLogin, CFG.chatLogin,
]);

// A PR whose base repo was deleted (or a transient API shape) arrives with
// `base: undefined` — `pr.base.repo` would throw "Cannot read properties of
// undefined (reading 'repo')" and crash the WHOLE page. Every access goes
// through this: a missing base degrades that one stat, never the endpoint.
const fqn = (p) => (p && p.base && p.base.repo ? p.base.repo.full_name : null);

// the issue a PR references via "#N" in its body (Gitea issue numbers are
// repo-local, so only issues of the SAME repo match)
function linkIssue(pr, issuesByRepo) {
  const repo = fqn(pr);
  if (!repo) return null;
  const issues = issuesByRepo.get(repo) || [];
  for (const m of String(pr.body || '').matchAll(/#(\d+)/g)) {
    const hit = issues.find((i) => i.number === +m[1]);
    if (hit) return hit;
  }
  return null;
}

export async function funkyData() {
  if (!CFG.adminToken) throw new Error('ADMIN_TOKEN not set — cannot read Gitea');
  const repos = managedRepos();
  const failures = [];

  // ── Gitea side ──
  const pulls = [];
  const issuesByRepo = new Map();
  for (const repo of repos) {
    try {
      pulls.push(...(await listAll(`/repos/${repo}/issues?state=all&type=pulls`)));
      issuesByRepo.set(repo, await listAll(`/repos/${repo}/issues?state=all&type=issues`));
    } catch (e) { failures.push(`${repo}: ${e.message}`); }
  }
  if (repos.length && failures.length === repos.length)
    throw new Error(`gitea unreachable (${failures[0]})`);

  // The /issues endpoint (which listAll uses) never sets the TOP-LEVEL
  // `merged_at` — it is always null there; the timestamp lives at
  // `pull_request.merged_at` (Gitea 1.27, verified live).
  const mergedAt = (pr) => pr.pull_request?.merged_at || pr.merged_at || null;
  const merged = [];
  const open = [];
  for (const pr of pulls)
    if (pr.pull_request?.merged && mergedAt(pr)) merged.push(pr);
    else if (pr.state === 'open') open.push(pr);

  const now = Date.now();
  let linesMerged = 0;
  const unreviewed = []; // merged PRs with zero HUMAN reviews
  const creepRule = [];  // merged PRs flagged by the deterministic rules
  const lags = [];       // issue-created → PR-merged, hours
  for (const pr of merged) {
    const repo = fqn(pr);
    if (!repo) { failures.push(`?#${pr.number} no base repo`); continue; }
    let lines = 0, reviewsN = 0, addedFiles = [];
    try {
      const files = await listAll(`/repos/${repo}/pulls/${pr.number}/files`);
      lines = files.reduce((s, f) => s + (f.additions || 0), 0);
      addedFiles = files.filter((f) => f.status === 'added').map((f) => f.filename);
    } catch (e) { failures.push(`${repo}#${pr.number} files: ${e.message}`); }
    try {
      // /pulls/{index}/reviews is the real route — /issues/{index}/reviews
      // 404s in Gitea 1.27 (ok404 would then count every PR as unreviewed)
      const reviews = await apiGet(`/repos/${repo}/pulls/${pr.number}/reviews`, { token: CFG.adminToken, ok404: true });
      // "reviewed" means a HUMAN used the review feature — agent identities
      // (work agents, the reviewer, dormant bot, chat) are the machine, not
      // the human coverage this stat measures.
      reviewsN = (reviews || []).filter((r) => !(r.user && AGENT_LOGINS.has(r.user.login))).length;
    } catch (e) { failures.push(`${repo}#${pr.number} reviews: ${e.message}`); }
    linesMerged += lines;
    if (reviewsN === 0) unreviewed.push(pr);
    const linked = linkIssue(pr, issuesByRepo);
    const mAt = mergedAt(pr);
    if (linked && linked.created_at && mAt)
      lags.push(hoursBetween(linked.created_at, mAt));
    // FEATURE-CREEP RULES (deterministic, per merged PR):
    //  1. the PR CREATES files the original ask never named — only when the
    //     ask named at least one file (an unscoped ask can't be exceeded).
    //  2. the PR title/body confesses extra scope in its own words.
    const askText = linked ? `${linked.title}\n${linked.body || ''}` : (pr.body || '');
    const asked = [...new Set(askText.match(FILE_RE) || [])];
    const outOfScope = asked.length
      ? addedFiles.filter((p) => !asked.some((a) => p === a || p.endsWith(`/${a}`) || p.startsWith(`${a}/`)))
      : [];
    if ((asked.length && outOfScope.length) || CREEP_RE.test(`${pr.title}\n${pr.body || ''}`))
      creepRule.push({ pr, outOfScope });
  }
  const zombies = open.filter((p) => now - Date.parse(p.created_at) > ZOMBIE_DAYS * 864e5)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  // "fixing the fix": a PR about a fix that references the fix itself
  const fixChains = pulls.filter((pr) => {
    const text = `${pr.title}\n${pr.body || ''}`;
    return /fix/i.test(text) && /\b(re-?fix|regress\w*|again|follow-?up|revert|still|second|broke|broken)\b/i.test(text);
  });

  // ── task DB side ──
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const totalTasks = tasks.length;
  const retriedN = tasks.filter((t) => t.retried_of != null).length;
  const tokensTotal = tasks.reduce((s, t) => s + (t.tokens || 0), 0);
  const batonsByPr = {};
  for (const t of tasks) {
    if (t.kind !== 'rework' || t.pr == null) continue;
    const k = `${t.repo}#${t.pr}`;
    batonsByPr[k] = (batonsByPr[k] || 0) + 1;
  }
  const batons = Object.values(batonsByPr).reduce((a, b) => a + b, 0);
  const reviewR1 = tasks.filter((t) => t.kind === 'agent-review' && (t.round ?? 1) === 1);
  const r1Passed = reviewR1.filter((t) => readLog(t.id).includes('<!-- review:pass -->')).length;

  // AGENT-REPORTED feature creep: a work agent that sees the user's request
  // drifting into feature creep adds `<!-- scope-creep -->` to its reply
  // comment (prompts.mjs teaches the convention). We only fetch comments on
  // the (repo, issue) targets the task DB says agents actually worked on —
  // a handful of calls, not every issue in every repo.
  const scopeFlags = [];
  for (const t of [...new Set(tasks.map((x) => `${x.repo}#${x.issue}`))]) {
    const [repo, n] = t.split('#');
    try {
      const cs = await apiGet(`/repos/${repo}/issues/${n}/comments?limit=100`, { token: CFG.adminToken, ok404: true });
      for (const c of cs || []) {
        if (!c.body || !c.user || !AGENT_LOGINS.has(c.user.login)) continue;
        for (const _ of c.body.matchAll(SCOPE_FLAG_RE)) scopeFlags.push({ t, user: c.user.login });
      }
    } catch (e) { failures.push(`${t} comments: ${e.message}`); }
  }

  // ── the ten roast-metrics ──
  const r1 = (x) => Math.round(x * 10) / 10;
  const scopeN = creepRule.length + scopeFlags.length;
  const scopeExamples = [
    ...creepRule.map((c) => `${fqn(c.pr) || '?'}#${c.pr.number}${c.outOfScope.length ? ` (new: ${c.outOfScope.slice(0, 2).join(', ')}${c.outOfScope.length > 2 ? '…' : ''})` : ''}`),
    ...scopeFlags.map((f) => `${f.t} (flagged by ${f.user})`),
  ].slice(0, 2);
  const worstBatons = Object.entries(batonsByPr).sort((a, b) => b[1] - a[1])[0] || null;
  const oldestZombie = zombies[0] || null;

  const noReview = merged.length
    ? { value: unreviewed.length, sub: `of ${merged.length} merged PR${merged.length > 1 ? 's' : ''} — human reviews only${unreviewed.length ? ` — e.g. ${fqn(unreviewed[0]) || '?'}#${unreviewed[0].number}` : ''}` }
    : { value: null, sub: 'no merged PRs yet' };
  const scope = merged.length || scopeFlags.length
    ? {
        value: scopeN,
        sub: [
          creepRule.length ? `${creepRule.length} by the rules` : null,
          scopeFlags.length ? `${scopeFlags.length} flagged by agents` : null,
        ].filter(Boolean).join(' · ')
          + (scopeExamples.length ? ` — ${scopeExamples.join(', ')}` : ''),
      }
    : { value: null, sub: 'no data (yet)' };
  const pingPong = totalTasks
    ? { value: batons, sub: batons ? (worstBatons ? `worst: ${worstBatons[0]} (×${worstBatons[1]})` : '') : 'the baton never moved' }
    : { value: null, sub: 'no tasks yet' };
  const burn = linesMerged
    ? { value: r1(tokensTotal / linesMerged), unit: ' tok', sub: `${linesMerged} merged lines · ${tokensTotal.toLocaleString()} tokens burned` }
    : { value: null, sub: 'no merged lines yet' };
  const zombie = {
    value: zombies.length,
    sub: oldestZombie
      ? `oldest: ${fqn(oldestZombie) || '?'}#${oldestZombie.number} — ${Math.floor((now - Date.parse(oldestZombie.created_at)) / 864e5)} days and counting`
      : `nothing open past ${ZOMBIE_DAYS} days`,
  };
  const stamp = reviewR1.length
    ? { value: Math.round((100 * r1Passed) / reviewR1.length), unit: '%', sub: `${r1Passed} of ${reviewR1.length} round-1 reviews passed` }
    : { value: null, sub: 'no round-1 reviews yet' };
  const retry = totalTasks
    ? { value: Math.round((100 * retriedN) / totalTasks), unit: '%', sub: `${retriedN} of ${totalTasks} tasks were a retry` }
    : { value: null, sub: 'no tasks yet' };
  const lag = lags.length
    ? { value: r1(median(lags)), unit: ' h', sub: `median over ${lags.length} issue→merge pair${lags.length > 1 ? 's' : ''}` }
    : { value: null, sub: 'no PR links an issue yet' };
  const fixes = {
    value: fixChains.length,
    sub: fixChains.length ? `e.g. ${fqn(fixChains[0]) || '?'}#${fixChains[0].number} “${fixChains[0].title}”` : 'no fix-of-a-fix detected (yet)',
  };

  // ── vibes score (0–100, higher = more chaotic) ──
  const parts = [
    merged.length ? 25 * (unreviewed.length / merged.length) : null,       // unreviewed merges
    scopeN ? Math.min(15, 5 * scopeN) : null,                              // feature creep
    totalTasks ? Math.min(15, 5 * batons) : null,                         // ping-pong
    linesMerged ? Math.min(15, tokensTotal / linesMerged / 5) : null,     // token burn
    Math.min(10, 5 * zombies.length),                                     // zombies
    reviewR1.length ? Math.min(10, r1Passed / reviewR1.length * 10) : null, // rubber stamps
    totalTasks ? Math.min(10, (retriedN / totalTasks) * 10) : null,       // retries
  ].filter((x) => x != null);
  const vibes = parts.length ? Math.min(100, Math.round(parts.reduce((a, b) => a + b, 0))) : null;

  return {
    repos: repos.length,
    generated: new Date().toISOString(),
    failures,
    stats: [
      { id: 'no-review', title: 'Merges without reviews', caption: 'Trusted the vibes. Zero humans signed off.', ...noReview },
      { id: 'scope-creep', title: 'Feature-creep instances', caption: 'You asked for a transition. You got a sidebar.', ...scope },
      { id: 'ping-pong', title: 'Review ping-pong', caption: 'The baton was passed N times.', ...pingPong },
      { id: 'burn', title: 'Tokens per merged line', caption: 'Your CO₂ is on fire.', ...burn },
      { id: 'zombie', title: 'Zombie PRs', caption: 'It lives in our hearts.', ...zombie },
      { id: 'stamp', title: 'Rubber-stamp rate', caption: 'Review depth: a single nod.', ...stamp },
      { id: 'retry', title: 'Agent retry rate', caption: 'First try never, second try always.', ...retry },
      { id: 'lag', title: 'Great-idea-to-merge lag', caption: 'From “I have a great idea” to production.', ...lag },
      { id: 'fix-chain', title: 'Commit chain of fixes', caption: 'Fixing the fix.', ...fixes },
    ],
    vibes: vibes == null ? null : { score: vibes, caption: 'Certified AI-chaos workflow.' },
  };
}
