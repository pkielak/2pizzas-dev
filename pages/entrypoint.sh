#!/bin/sh
# Static pages server: keeps a shallow checkout of PAGES_REPO (branch
# PAGES_BRANCH, default gh-pages) up to date and serves it with nginx.
# The gh-pages branch is pushed by the repo's CI workflow.
set -u

REPO="${PAGES_REPO:?PAGES_REPO required, e.g. http://gitea:3000/owner/Pancratius.git}"
BRANCH="${PAGES_BRANCH:-gh-pages}"
TOKEN="${PAGES_TOKEN:-}"
DEST=/srv/pages
INTERVAL="${PAGES_SYNC_INTERVAL:-60}"

# inject the token into the clone URL
if [ -n "$TOKEN" ]; then
  REPO="http://x-access-token:${TOKEN}@${REPO#http://}"
fi

sync() {
  if [ ! -d "$DEST/.git" ]; then
    rm -rf "$DEST"
    git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DEST" || return 1
  fi
  # + = force: the deploy workflow rewrites gh-pages history (orphan branch)
  git -C "$DEST" fetch -q --depth 1 origin "+$BRANCH:refs/remotes/origin/$BRANCH" \
    && git -C "$DEST" checkout -q -B "$BRANCH" "origin/$BRANCH"
}

sync || echo "pages: initial clone failed (will retry)"

nginx -g 'daemon off;' &
while :; do
  sleep "$INTERVAL"
  sync || echo "pages: sync failed (will retry)"
done
