#!/usr/bin/env bash
# Post a reply comment on an issue or PR, stamped with a bot marker.
# The marker (<!-- via:agent -->) is checked by the workflows' if: conditions
# so agents never reply to their own comments.
#
# Usage: post-comment.sh <issue-or-pr-number> <file-with-comment-body>
# Requires: AGENT_TOKEN, GITEA_API, GITEA_REPO (all provided by the workflow/runner).
set -euo pipefail

: "${AGENT_TOKEN:?AGENT_TOKEN is not set}"
: "${GITEA_API:?GITEA_API is not set}"
: "${GITEA_REPO:?GITEA_REPO is not set}"

num="${1:?usage: post-comment.sh <issue-or-pr-number> <body-file>}"
file="${2:?usage: post-comment.sh <issue-or-pr-number> <body-file>}"

body="$(cat "$file")"
body="${body}"$'\n\n'"<!-- via:agent -->"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
jq -n --arg body "$body" '{body: $body}' > "$tmp"

curl -sf -X POST \
  -H "Authorization: token ${AGENT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @"$tmp" \
  "${GITEA_API}/repos/${GITEA_REPO}/issues/${num}/comments"
echo
echo "posted comment on ${GITEA_REPO}#${num}"
# consume the input: 2pizzas treats a surviving /tmp/reply.md as "not yet posted"
rm -f "$file"
