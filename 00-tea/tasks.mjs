import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CFG, MARKER } from './config.mjs';
import { db, readLog, logPath } from './db.mjs';
import { apiGet, apiPost } from './gitea.mjs';
import { pickModel } from './llama.mjs';
import { stripMention, commentPrompt, reviewPrompt, agentReviewPrompt, reworkPrompt, infraPrompt } from './prompts.mjs';
import { enqueueReview, enqueueRework, onTaskFailure } from './queue.mjs';
import { setKick, kick } from './kick.mjs';
import { liveBroadcast } from './live.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const running = new Map(); // task id -> { log }
let active = 0;
export const activeCount = () => active;

const parseRefs = (text) => [...text.matchAll(/\[00-tea\] ref: (\S+) ([0-9a-f]{40}) ([0-9a-f]{40})/g)]
  .map((m) => ({ ref: m[1], old: m[2], new: m[3] }));

async function runTask(t) {
  const logfile = logPath(t.id);
  const log = { text: '', file: logfile };
  running.set(t.id, log);
  const say = (s) => { log.text += s; fs.appendFileSync(logfile, s); };
  let tokens = null; // captured from the filter's end-of-stream marker
  let tail = '';

  try {
    // 1. resolve prompt inputs
    const issueInfo = await apiGet(`/repos/${t.repo}/issues/${t.issue}`);
    const isPull = issueInfo.pull_request != null;
    const parent = t.parent_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.parent_id) : null;
    const request =
      t.kind === 'rework'
        ? t.body ?? ''                                    // the reviewer's concerns
        : stripMention(t.body ?? '', parent?.agent ?? t.agent);
    const isInfra = t.agent === 'infra';
    if (isInfra && !CFG.infraHostRepo)
      throw new Error('INFRA_HOST_REPO not set — cannot run the infra agent');

    const prompt =
      t.agent === 'infra'
        ? infraPrompt({ issue: t.issue, request })
        : t.kind === 'review'
          ? reviewPrompt({ issue: t.issue, request, cpath: t.cpath, line: t.line })
          : t.kind === 'agent-review'
            ? agentReviewPrompt({
                issue: t.issue,
                pr: t.pr ?? null,
                refs: parseRefs(parent ? readLog(parent.id) : ''),
                request,
              })
            : t.kind === 'rework'
              ? reworkPrompt({ issue: t.issue, pr: t.pr ?? null, request })
              : commentPrompt({ issue: t.issue, title: issueInfo.title, body: issueInfo.body, isPull, request });

    // 2a. model selection — prefer a model the router already has loaded
    //     (lazy-loading another 27B+ model fails while one is resident).
    //     Both agents share the router; opencode's --model overrides its
    //     baked config (the model id must exist in that config's list).
    const modelSel = await pickModel();
    if (modelSel) {
      db.prepare('UPDATE tasks SET model=?, model_ctx=? WHERE id=?').run(modelSel.id, modelSel.ctx, t.id);
      say(`$ model: ${modelSel.id} (ctx ${modelSel.ctx}, ${modelSel.source})\n`);
    }

    // 2. self-contained bootstrap script, executed INSIDE the job container.
    //    No host-path bind mounts (00-tea talks to the host docker daemon, so
    //    container paths are not host paths). Clone as bot → authenticated
    //    remote, so agent commits/PRs attribute to the bot user.
    //
    //    NOTE: docker -e values have their newlines flattened to spaces, so
    //    everything multi-line (prompt, helper scripts) goes into the script
    //    text via quoted heredocs, and the script itself is passed base64.
    // Enforcement: a finished agent must have taken a visible action (pushed
    // commits, opened a PR, or posted a reply). If it did none of that, post
    // a fallback error comment and flag the task as a failure (checked in
    // runTask via the '[00-tea] no-action' marker).
    // agent-review: the reviewer writes /tmp/reply.md; it is echoed into the
    // log between markers (00-tea posts it — the container has no write
    // token) and a missing file fails the task.
    const enforce = t.kind === 'agent-review' ? `

echo '$ enforcing: reviewer must have written a review'
if [ -s /tmp/reply.md ]; then
  echo '[00-tea] review-body-begin'
  cat /tmp/reply.md
  echo ''
  echo '[00-tea] review-body-end'
else
  echo '[00-tea] no-action: reviewer wrote no review' >&2
  exit 1
fi
` : `

echo '$ enforcing: agent must have taken an action (commit/PR/reply)'
ACTION=""
git ls-remote --heads origin > /tmp/refs-after.txt 2>/dev/null || true
# only trust the diff when both snapshots succeeded (non-empty)
if [ -s /tmp/refs-before.txt ] && [ -s /tmp/refs-after.txt ] && ! cmp -s /tmp/refs-before.txt /tmp/refs-after.txt; then
  ACTION="pushed commits"
  # machine-readable ref changes (old new ref) — the review chain parses these;
  # an open bot PR on a changed branch is reported too (PR-based review prompt)
  for ref in $(awk '{print $2}' /tmp/refs-after.txt | sort -u); do
    old=$(awk -v r="$ref" '$2==r{print $1}' /tmp/refs-before.txt)
    new=$(awk -v r="$ref" '$2==r{print $1}' /tmp/refs-after.txt)
    [ -n "$new" ] || continue
    [ "\${old:-0000000000000000000000000000000000000000}" = "$new" ] && continue
    echo "[00-tea] ref: $ref \${old:-0000000000000000000000000000000000000000} $new"
    p=$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls?state=open&limit=50" 2>/dev/null \\
      | jq -r --arg bot "$BOT_NAME" --arg b "\${ref#refs/heads/}" '[.[] | select(.user.login == $bot and .head.ref == $b)] | first | .number' 2>/dev/null || true)
    [ -n "$p" ] && [ "$p" != "null" ] && echo "[00-tea] pr: #$p"
  done
fi
if [ -z "$ACTION" ]; then
  PRINFO="$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls?state=open&limit=10" 2>/dev/null | jq -r --arg bot "$BOT_NAME" '[.[] | select(.user.login == $bot)] | last | select(. != null) | (.created_at) + " #" + (.number | tostring)' || true)"
  # NOTE: the > operator must be QUOTED — unquoted, the shell parses it as
  # an output redirection ([ A > B ] = [ A ] with stdout redirected to file B,
  # which is always true for a non-empty A)
  if [ -n "$PRINFO" ] && [ "\${PRINFO%% #*}" \">" "$(cat /tmp/start-iso.txt)" ]; then
    ACTION="opened PR \${PRINFO#* }"
    echo "[00-tea] pr: #\${PRINFO##*#}"
  fi
fi
if [ -z "$ACTION" ]; then
  LASTC="$(curl -sf -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/issues/$TASK_ISSUE/comments?limit=20" 2>/dev/null | jq -r --arg bot "$BOT_NAME" '[.[] | select(.user.login == $bot)] | last | select(. != null) | .created_at' || true)"
  if [ -n "$LASTC" ] && [ "$LASTC" \">" "$(cat /tmp/start-iso.txt)" ]; then
    ACTION="posted a reply comment"
  fi
fi
if [ -s /tmp/reply.md ]; then
  bash .00-tea/post-comment.sh "$TASK_ISSUE" /tmp/reply.md
  echo '[00-tea] posted reply from /tmp/reply.md'
elif [ -n "$ACTION" ]; then
  echo "[00-tea] no reply file, but the agent already acted: $ACTION"
else
  echo '[00-tea] ERROR: agent took no action (no commit, no PR, no reply)' >&2
  printf '%s\n' '[00-tea] The agent finished but took no visible action (no commit, PR, or reply). Re-run the request or check the task log on the 00-tea dashboard.' > /tmp/reply.md
  bash .00-tea/post-comment.sh "$TASK_ISSUE" /tmp/reply.md
  echo '[00-tea] no-action: fallback comment posted' >&2
fi
`;

    const assetsDir = path.join(__dirname, 'assets');
    const delim = () => `EOF_${crypto.randomBytes(6).toString('hex')}`;
    const dPrompt = delim(), dPost = delim(), dJq = delim(), dOc = delim();
    // (dJq: the name is historical — it now carries the node filter)
    // infra: the live infra repo is bind-mounted read-only at /infra-src;
    // clone a container-local COPY from it (edits must not touch the host
    // repo's .git) and repoint origin at the bot-authenticated remote so
    // pushes attribute to the bot.
    const cloneSection = isInfra
      ? `echo '$ infra repo (live copy bind-mounted at /infra-src)'
# the host repo is owned by the host user, not the container's root
git config --global --add safe.directory /infra-src
git config --global --add safe.directory /infra-src/.git
git clone -q /infra-src repo
cd repo
git remote set-url origin "$CLONE_URL"
`
      : `echo '$ git clone ${t.repo}'
git clone -q "$CLONE_URL" repo
cd repo
`;
    const bootstrap = `
set -e
mkdir -p /work && cd /work
date -u +%Y-%m-%dT%H:%M:%S > /tmp/start-iso.txt
${cloneSection}git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"
# BEFORE-snapshot of remote refs must be taken INSIDE the repo (a failure
# here is fatal — an empty snapshot would make the later diff a false
# positive and mask a no-op agent)
git ls-remote --heads origin > /tmp/refs-before.txt
mkdir -p .00-tea
cat > .00-tea/post-comment.sh <<'${dPost}'
${fs.readFileSync(path.join(assetsDir, 'post-comment.sh'), 'utf8').replace(/\n+$/, '')}
${dPost}
cat > .00-tea/output_filter.mjs <<'${dJq}'
${fs.readFileSync(path.join(assetsDir, 'output_filter.mjs'), 'utf8').replace(/\n+$/, '')}
${dJq}
cat > .00-tea/opencode_filter.mjs <<'${dOc}'
${fs.readFileSync(path.join(assetsDir, 'opencode_filter.mjs'), 'utf8').replace(/\n+$/, '')}
${dOc}
chmod +x .00-tea/post-comment.sh
cat > /tmp/prompt.txt <<'${dPrompt}'
${prompt}
${dPrompt}
PROMPT="$(cat /tmp/prompt.txt)"
export PROMPT
echo ''
echo '$ ${t.agent} agent (${isInfra ? 'runc + host docker socket' : 'runsc sandbox'}${modelSel ? `, model ${modelSel.id}` : ''})'
` + ((t.agent === 'pi' || t.agent === 'infra') // infra is pi-based
      ? `bash -o pipefail -c \'pi -p --mode json --model "llama.cpp/${modelSel.id}" "$PROMPT" | tee /tmp/agent-out.jsonl | node .00-tea/output_filter.mjs\'\n` +
        // pi >= 0.82: the SESSION-end event is `agent_settled` — emitted in
        // prompt()'s finally, AFTER `agent_end` and all post-run processing
        // (retries, compaction). `agent_end` only closes the loop, so it is
        // NOT the last stream line. A clean run: last line is agent_settled,
        // the last agent_end carries no errorMessage, and no finalError
        // (exhausted auto-retry) appears anywhere in the stream.
        'tail -n1 /tmp/agent-out.jsonl > /tmp/last-event.json\n' +
        'if ! grep -q \'"type":"agent_settled"\' /tmp/last-event.json; then\n' +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\n' +
        'if grep \'"type":"agent_end"\' /tmp/agent-out.jsonl | tail -n1 | grep -q \'"errorMessage"\' || grep -q \'"finalError"\' /tmp/agent-out.jsonl; then\n' +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\necho "[00-tea] agent finished OK"'
      : `bash -o pipefail -c 'opencode run --format json --auto --model "llama.cpp/${modelSel.id}" "$PROMPT" | tee /tmp/agent-out.jsonl | OPENCODE_MODEL="llama.cpp/${modelSel.id}" node .00-tea/opencode_filter.mjs'\n` +
        'tail -n1 /tmp/agent-out.jsonl > /tmp/last-event.json\n' +
        `if grep -q '"type":"error"' /tmp/last-event.json || ! grep -q '"type":"step_finish"' /tmp/last-event.json; then\n` +
        '  echo "[00-tea] ERROR: agent did not finish cleanly (see stream above)" >&2\n' +
        '  exit 1\nfi\necho "[00-tea] agent finished OK"') + enforce;
    const b64 = Buffer.from(bootstrap).toString('base64');

    say(`$ docker run --rm ${isInfra ? '(runc + host docker socket) ' : '--runtime=runsc '}${CFG.images[t.agent]} (bootstrap + ${t.agent})\n\n`);

    // 3. run the agent in a fresh container. Every agent runs in the gVisor
    // sandbox EXCEPT infra: it repairs the stack, so it runs on runc with the
    // host docker socket + the live infra repo mounted read-only (the docker
    // socket is the trust boundary — same as 00-tea itself).
    await new Promise((resolve, reject) => {
    const dockerArgs = [
      'run', '--rm',
      ...(isInfra ? [] : ['--runtime=runsc']),
      ...(isInfra
        ? ['--name', `tea-infra-${t.id}`,
           '-v', `${CFG.infraHostRepo}:/infra-src:ro`,
           '-v', '/var/run/docker.sock:/var/run/docker.sock']
        : []),
      '--add-host=gitea:host-gateway',
      '--add-host=host.docker.internal:host-gateway',
        // agent-review runs on the READ-ONLY token for everything (clone +
        // API): the reviewer physically cannot push or post — 00-tea posts
        // its comment from the task log.
        '-e', `BOOTSTRAP_B64=${b64}`,
        '-e', `CLONE_URL=http://bot:${t.kind === 'agent-review' ? CFG.reviewToken : CFG.agentToken}@${CFG.giteaHost}/${t.repo}.git`,
        '-e', `BOT_NAME=${CFG.botLogin}`,
        '-e', `BOT_EMAIL=${CFG.botEmail}`,
        '-e', `AGENT_TOKEN=${t.kind === 'agent-review' ? CFG.reviewToken : CFG.agentToken}`,
        '-e', `TASK_ISSUE=${t.issue}`,
        '-e', `GITEA_API=http://${CFG.giteaHost}/api/v1`,
        '-e', `GITEA_REPO=${t.repo}`,
        CFG.images[t.agent], 'sh', '-c', 'sh -c "$(printf %s "$BOOTSTRAP_B64" | base64 -d)"',
    ];
    const child = spawn('docker', dockerArgs);
      const onOut = (d) => {
        const s = d.toString();
        say(s);
        const m = /\[00-tea\] usage: model=\S+ tokens=(\d+)/.exec(tail + s); // filter's end-of-stream marker
        if (m) tokens = +m[1];
        tail = s.length > 80 ? s.slice(-80) : s;
      };
      child.stdout.on('data', onOut);
      child.stderr.on('data', onOut);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`agent exited with code ${code}`))));
    });

    // enforcement result: the bootstrap posted a fallback comment when the
    // agent did nothing visible — surface that as a task failure
    if (log.text.includes('[00-tea] no-action: fallback comment posted'))
      throw new Error('agent took no action (no commit/PR/reply) — fallback comment posted');
  } catch (e) {
    say(`\n[00-tea] ERROR: ${e.message}\n`);
    throw e;
  } finally {
    if (tokens != null) db.prepare('UPDATE tasks SET tokens=? WHERE id=?').run(tokens, t.id);
    running.delete(t.id);
  }
}

// ── review chain (after a task finishes successfully) ───────────────────────

async function afterTask(t) {
  if (t.kind === 'agent-review') {
    // 00-tea posts the review itself (the container had no write token),
    // then acts on the verdict marker in the review body.
    const m = /\[00-tea\] review-body-begin\n([\s\S]*?)\n\[00-tea\] review-body-end/.exec(readLog(t.id));
    if (!m) { console.log(`[review] task ${t.id}: no review body in log — chain stops`); return; }
    const body = m[1].trim();
    await apiPost(`/repos/${t.repo}/issues/${t.issue}/comments`, { body: `${body}\n\n${MARKER}` });
    console.log(`[review] task ${t.id}: review posted on ${t.repo}#${t.issue}`);
    const v = /<!-- review:(pass|fail) -->/.exec(body);
    if (!v) { console.log(`[review] task ${t.id}: no verdict marker in review — chain stops`); return; }
    if (v[1] === 'pass') { console.log(`[review] task ${t.id}: verdict=pass`); return; }
    const round = t.round ?? 1;
    if (round >= CFG.reviewMaxRounds) {
      await apiPost(`/repos/${t.repo}/issues/${t.issue}/comments`, {
        body: `[00-tea] Review cycle exhausted: the reviewer still has concerns after ${round} round${round > 1 ? 's' : ''}. A human should take over.\n\n${MARKER}`,
      });
      console.log(`[review] task ${t.id}: verdict=fail at round cap (${CFG.reviewMaxRounds}) — cycle exhausted`);
      return;
    }
    enqueueRework(t, body);
    return;
  }
  // work tasks: a push starts the review chain (one review per work task —
  // the parent_id+kind dedupe in enqueueReview keeps this idempotent)
  if (['comment', 'review', 'rework'].includes(t.kind)) {
    const logText = readLog(t.id);
    if (parseRefs(logText).length) enqueueReview(t, logText);
  }
}

export async function pump() {
  if (active >= CFG.concurrency) return;
  const t = db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
  if (!t) return;
  db.prepare(`UPDATE tasks SET status='running', started_at=datetime('now') WHERE id=?`).run(t.id);
  liveBroadcast('tasks');
  active++;
  try {
    await runTask(t);
    db.prepare(`UPDATE tasks SET status='success', finished_at=datetime('now') WHERE id=?`).run(t.id);
    liveBroadcast('tasks');
    try { await afterTask(t); }
    catch (e) { console.error(`[after] task ${t.id}: ${e.message}`); }
  } catch (e) {
    db.prepare(`UPDATE tasks SET status='failure', finished_at=datetime('now'), error=? WHERE id=?`)
      .run(String(e.message).slice(0, 2000), t.id);
    liveBroadcast('tasks');
    onTaskFailure(t, e.message); // infra-class → retry once + wake the infra agent
  } finally {
    active--;
    kick(); // a slot just freed — start the next queued task now
  }
}
setKick(pump);
// 2s tick is a safety net (e.g. tasks queued while 00-tea was down); the
// usual path is the event kick from enqueue()/pump() above
setInterval(pump, 2000).unref?.();
