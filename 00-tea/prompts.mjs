// ── agent prompts ────────────────────────────────────────────────────────────

export function stripMention(body, agent) {
  return body.replace(new RegExp(`@${agent}[ \\t]*`, 'g'), '').trim();
}

export function commentPrompt({ issue, title, body, isPull, request }) {
  const guide = isPull
    ? `The comment is on PULL REQUEST #${issue}.
Find its head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${issue} | jq -r .head.ref
Then: git fetch origin pull/${issue}/head && git checkout FETCH_HEAD
Make the requested changes, commit, and push to that head branch (use --force-with-lease only if you had to rebase).`
    : `The comment is on ISSUE #${issue} (not a PR).
If your work produces commits, push a new branch and open a PR from it:
POST $GITEA_API/repos/$GITEA_REPO/pulls with JSON {"title": ..., "head": "<branch>", "base": "main"} (Authorization: token $AGENT_TOKEN).`;
  return `Issue/PR: #${issue} — ${title}
Issue body:
${body}

User request: ${request}
${guide}

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if none of the following happens, so do not end without it:
1. Push your commits (and open a PR if the guide above says so).
2. Write a short reply (what you did, plus any PR/branch name) to /tmp/reply.md and post it:
   bash .00-tea/post-comment.sh ${issue} /tmp/reply.md
`;
}

export function reviewPrompt({ issue, request, cpath, line }) {
  return `A reviewer left an inline comment in PR #${issue}${cpath ? ` on ${cpath}` : ''}${line ? ` at line ${line}` : ''}:
${request}

Find the PR head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${issue} | jq -r .head.ref
Then: git fetch origin pull/${issue}/head && git checkout FETCH_HEAD
Address the review comment: make the changes, commit, and push to the head branch.

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if you finish without pushing commits AND without posting this reply:
write a short reply (what you changed) to /tmp/reply.md and post it:
bash .00-tea/post-comment.sh ${issue} /tmp/reply.md`;
}

// agent-review: the reviewer is READ-ONLY — its clone uses the read-only
// token and it never receives the write token, so it cannot push OR post.
// It writes the review to /tmp/reply.md; the bootstrap echoes the file into
// the task log between [00-tea] review-body-* markers and 00-tea posts the
// comment itself (afterTask) + parses the verdict marker from it.
export function agentReviewPrompt({ issue, pr, refs, request }) {
  const scope = pr
    ? `The work is in PR #${pr}:
BASE=$(curl -s -H "Authorization: token $AGENT_TOKEN" "$GITEA_API/repos/$GITEA_REPO/pulls/${pr}" | jq -r .base.ref)
git fetch origin "pull/${pr}/head" && git checkout FETCH_HEAD && git fetch origin "$BASE"
Review the diff: git diff "origin/\${BASE}"...HEAD`
    : refs.map((r) =>
        r.old.replace(/0/g, '') === ''
          ? `git fetch origin "\${r.ref#refs/heads/}" && git diff $(git merge-base origin/main ${r.new})..${r.new}`
          : `git fetch origin "\${r.ref#refs/heads/}" && git diff ${r.old}..${r.new}`
      ).join('\n');
  return `You are a CODE REVIEWER. Another agent implemented the change; you review it.

${scope}

Original request (what the change was supposed to do):
${request}

RULES — you are READ-ONLY:
- Do not edit files, do not commit, do not push (your clone is read-only; pushes will fail).
- Review for: correctness, security (no secrets committed), tests, error handling, scope creep.
- Use the code-review skill.

REQUIRED FINISH — the task is marked FAILED if you finish without writing the review:
write your review to /tmp/reply.md (00-tea posts it as a comment on #${issue}).
Every concern needs file:line + what is wrong + why it matters.
The LAST LINE of /tmp/reply.md must be exactly one of:
  <!-- review:pass -->
  <!-- review:fail -->
Use fail only for concrete, fixable concerns; pass if the work is acceptable.`;
}

// @infra (agent-infra): repairs the stack itself. Runs on runc with the host
// docker socket + a read-only bind mount of the live infra repo at
// /infra-src (the bootstrap clones a container-local copy from it). Ops
// actions may be executed directly; code changes go to a branch + PR, which
// the normal review chain then reviews.
export function infraPrompt({ issue, request }) {
  return `You are the INFRA AGENT for this stack. The repo you work in is the
infrastructure-as-code for the whole system (Gitea, 00-tea dispatcher, runners,
pages, agent sandboxes). START by reading AGENTS.md in the repo — it is the
manual: layout, golden rules, gotchas, verification commands.

Your tools:
- \`docker\` CLI against the HOST daemon (socket is mounted): \`docker ps\`,
  \`docker logs\`, \`docker inspect\`, \`docker compose ...\` — the compose file
  is at /work/repo/docker-compose.yml.
- The repo working tree at /work/repo (a clone of the live infra repo; push from here).
- 00-tea task logs at /logs (read-only) — the failing task's log is named <id>.log.

Rules:
- DIAGNOSE first: read the failing task's log, \`docker logs\` of the involved
  containers, \`docker inspect\`. State the root cause BEFORE touching anything.
- Ops actions (rebuild an image, \`docker compose up -d <svc>\`, recreate a
  container, restart a service) you may execute directly.
- Code changes (compose, 00-tea/*.mjs, seed.sh, Dockerfiles, prompts) go to a
  NEW BRANCH + PR — never push to main directly.
- Do NOT: restart the host, modify .env, delete runtime state dirs
  (gitea/, postgres/, data/, data-00-tea/, data-android/), or touch the
  golden rules in AGENTS.md.

Request / incident context:
${request}

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the
issue if none of the following happens, so do not end without it:
1. Execute the fix (ops directly, code via branch + PR).
2. Write a short reply (root cause, what you did, PR/branch name if any) to
   /tmp/reply.md and post it:
   bash .00-tea/post-comment.sh ${issue} /tmp/reply.md
`;
}

export function reworkPrompt({ issue, pr, request }) {
  const guide = pr
    ? `Find the PR head branch: curl -s -H 'Authorization: token $AGENT_TOKEN' $GITEA_API/repos/$GITEA_REPO/pulls/${pr} | jq -r .head.ref
Then: git fetch origin pull/${pr}/head && git checkout FETCH_HEAD
Address the concerns: make the changes, commit, and push to the head branch.`
    : 'Address the concerns: make the changes, commit, and push.';
  return `A code reviewer reviewed your work${pr ? ` on PR #${pr}` : ''} and raised concerns:
${request}

${guide}

REQUIRED FINISH — the task is marked FAILED and an error note is posted on the issue
if you finish without pushing commits AND without posting this reply:
write a short reply (what you changed) to /tmp/reply.md and post it:
bash .00-tea/post-comment.sh ${issue} /tmp/reply.md`;
}
