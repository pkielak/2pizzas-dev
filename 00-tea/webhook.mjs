import crypto from 'node:crypto';
import { CFG, MENTIONS } from './config.mjs';
import { isManaged, enroll } from './repos.mjs';
import { enqueue } from './queue.mjs';

// ── webhook ──────────────────────────────────────────────────────────────────

export function verifySignature(req, body) {
  if (!CFG.secret) return true; // dev mode: no secret configured
  const sig = req.headers['x-gitea-signature'];
  if (!sig) return false;
  const mac = crypto.createHmac('sha256', CFG.secret).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); }
  catch { return false; }
}

export async function handleWebhook(event, deliveryId, payload) {
  const repo = payload.repository?.full_name;
  if (!repo) return 0;

  let body = '';
  // comments on a PR arrive as pull_request_comment, not issue_comment
  if ((event === 'issue_comment' || event === 'pull_request_comment') && payload.action === 'created' && payload.issue?.number && payload.comment) {
    body = payload.comment?.body ?? '';
    // self-enroll: a mention on an unmanaged repo opts it in — persist it and
    // grant the bot write access, then the enqueue gate below passes
    if (!isManaged(repo) && MENTIONS.some((m) => m.re.test(body))) {
      try { await enroll(repo); }
      catch (e) { console.error(`[enroll] ${repo}: ${e.message} — mention ignored`); return 0; }
    }
    for (const m of MENTIONS)
      enqueue({ repo, issue: payload.issue.number, agent: m.agent, kind: 'comment', comment: payload.comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1; // enqueue() logs what it accepted
  }
  // full PR reviews (inline review comments have no hook event in 1.27 —
  // they arrive via the poll fallback)
  if (event === 'pull_request_review' && payload.action === 'created' && payload.review) {
    const prNo = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNo) return 0;
    body = payload.review?.body ?? '';
    if (!isManaged(repo) && MENTIONS.some((m) => m.re.test(body))) {
      try { await enroll(repo); }
      catch (e) { console.error(`[enroll] ${repo}: ${e.message} — mention ignored`); return 0; }
    }
    const comment = { id: payload.review.id, body, path: null, line: null };
    for (const m of MENTIONS)
      enqueue({ repo, issue: prNo, agent: m.agent, kind: 'review', comment, sender: payload.sender?.login, eventId: deliveryId });
    return 1;
  }
  return 0;
}
