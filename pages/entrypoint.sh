#!/bin/sh
# Static pages server: keeps a shallow checkout of PAGES_REPO (branch
# PAGES_BRANCH, default gh-pages) up to date and serves it with nginx.
# The gh-pages branch is pushed by the repo's CI workflow.
set -u

REPO="${PAGES_REPO:?PAGES_REPO required, e.g. http://gitea:3000/admin/my-repo.git}"
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

# --- assemble the final nginx config -------------------------------------
# Base is HTTP-only (8080). The 8443 TLS block is wired in only when a REAL
# (CA-signed) cert pair is mounted (./pages/certs → /etc/nginx/certs). No
# certs → empty include → the site runs HTTP-only (the default, and no
# startup trap from a dangling ssl server block).
#
# Only real certs are supported — e.g. a Tailscale tailnet cert for the
# machine's magic-DNS name. A self-signed pair would never be trusted for
# that name (the browser warns), so there is no auto-self-sign path here.
CERT_DIR=/etc/nginx/certs
SSL_INCLUDE=/etc/nginx/ssl-server.conf

if [ -f "$CERT_DIR/cert.pem" ] && [ -f "$CERT_DIR/key.pem" ]; then
  # real certs mounted → use the baked 8443 block as-is
  cp /etc/nginx/nginx-ssl.conf "$SSL_INCLUDE"
else
  # no certs → HTTP-only: empty include = no TLS server block
  : > "$SSL_INCLUDE"
fi

nginx -g 'daemon off;' &
while :; do
  sleep "$INTERVAL"
  sync || echo "pages: sync failed (will retry)"
done
