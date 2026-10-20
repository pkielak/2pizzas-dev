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
