#!/usr/bin/env bash
#
# sync-template.sh — propagate agents-actions template changes into one or
# more existing repos (Gitea templates do not propagate updates, so this is
# the "upgrade" path).
#
# Usage:
#   ./sync-template.sh owner/repo [owner/repo ...]
#
# Behavior (per repo, idempotent — no commit if nothing changed):
#   - overwrites the template-managed files with agents-actions/
#   - removes STALE files (superseded agent workflows — agent tasks moved
#     to 2pizzas webhooks and no longer live in repo workflows)
#   - leaves repo-specific workflows (ci.yml, ...) untouched
#
# NOTE: the agents-actions template is currently workflows-free (README only),
# so this script effectively only prunes stale agent workflow files.

set -euo pipefail
cd "$(dirname "$0")"

[[ $# -ge 1 ]] || { echo "usage: $0 owner/repo [owner/repo ...]"; exit 1; }
[[ -f .env ]] || { echo "error: no .env"; exit 1; }
set -a; source .env; set +a

GITEA_URL="${GITEA_URL:-http://localhost:3000}"
HOST="${GITEA_URL#http://}"; HOST="${HOST%/}"

TEMPLATE_FILES=()   # agents-actions currently ships no workflows
STALE_FILES=(comment-assist.yaml pr-review.yml post-comment.sh output_filter.jq issue-assist.yaml)

for repo in "$@"; do
  echo "== $repo"
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" EXIT

  url="http://${ADMIN_USER}:${ADMIN_TOKEN}@${HOST}/${repo}.git"
  git clone -q "$url" "$tmp/repo"
  cd "$tmp/repo"
  branch=$(git rev-parse --abbrev-ref HEAD)

  if [[ -d .gitea/workflows ]]; then
    for f in "${TEMPLATE_FILES[@]}"; do cp "agents-actions/.gitea/workflows/$f" ".gitea/workflows/$f" 2>/dev/null || true; done
    for f in "${STALE_FILES[@]}"; do
      [[ -f ".gitea/workflows/$f" ]] && git rm -q ".gitea/workflows/$f"
    done
    rmdir .gitea/workflows 2>/dev/null || true
  fi

  git add -A
  if git diff --cached --quiet; then
    echo "   up to date"
    cd /; rm -rf "$tmp"; continue
  fi

  git -c user.name="$ADMIN_USER" -c user.email="${ADMIN_USER}@localhost" \
      commit -qm "sync: prune agent workflows (moved to 2pizzas webhooks)"
  git push -q origin "HEAD:$branch"
  echo "   synced → $branch ($(git rev-parse --short HEAD))"
  cd /; rm -rf "$tmp"
done
echo "done"
