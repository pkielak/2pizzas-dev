#!/usr/bin/env bash
#
# seed.sh — bootstrap a fresh Gitea instance with this infra's users, tokens,
# repos, template and runners. Idempotent: every step skips itself when the
# thing already exists, so it is safe to re-run (and safe to run against an
# already-running instance).
#
# Usage:
#   cp .env.example .env && $EDITOR .env   # postgres creds at minimum
#   docker compose up -d db server
#   ./seed.sh
#
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "error: no .env (cp .env.example .env)"; exit 1; }
set -a; source .env; set +a

GITEA_URL="${GITEA_URL:-http://localhost:3000}"
ADMIN_USER="${ADMIN_USER:-owner}"
BOT_USER="bot"
HOST="${GITEA_URL#http://}"; HOST="${HOST%/}"
ADMIN_REPO="gitea-with-agents"
TEMPLATE_REPO="agents-actions"

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
skip() { printf '   (already exists, skipping)\n'; }

# set_env KEY VALUE — upsert a line in .env
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

user_exists() { curl -sf "$GITEA_URL/api/v1/users/$1" >/dev/null 2>&1; }
token_valid() { curl -sf -H "Authorization: token $1" "$GITEA_URL/api/v1/user" >/dev/null 2>&1; }
runner_registered() {
  curl -sf -H "Authorization: token $ADMIN_TOKEN" \
    "$GITEA_URL/api/v1/admin/actions/runners?limit=50" 2>/dev/null \
    | jq -e --arg n "$1" '.runners[] | select(.name == $n)' >/dev/null 2>&1
}
AGENTD_REPOS=("$ADMIN_USER/$ADMIN_REPO" "$ADMIN_USER/platform-fall")
WEBHOOK_URL="http://agentd:3001/webhook"

gen_password() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ── 1. wait for Gitea ──────────────────────────────────────────────
log "Waiting for Gitea at $GITEA_URL"
for _ in $(seq 1 60); do
  curl -sf "$GITEA_URL/api/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$GITEA_URL/api/healthz" >/dev/null || { echo "gitea never came up"; exit 1; }

# ── 2. users ───────────────────────────────────────────────────────
log "Users"
for u in "$ADMIN_USER" "$BOT_USER"; do
  if user_exists "$u"; then echo "user $u: ok"; skip
  else
    pw_var=ADMIN_PASSWORD; [[ $u == "$BOT_USER" ]] && pw_var=BOT_PASSWORD
    pw="${!pw_var}"
    [[ -n $pw ]] || { pw=$(gen_password); set_env "$pw_var" "$pw"; }
    docker exec -u git gitea gitea admin user create \
      --username "$u" --email "${u}@localhost" --password "$pw" >/dev/null
    echo "user $u: created (password stored in .env)"
  fi
done

# ── 3. API tokens ──────────────────────────────────────────────────
log "API tokens"
declare -A tok_names=( [GITEA_TOKEN]="$ADMIN_USER" [AGENT_TOKEN]="$BOT_USER" [ADMIN_TOKEN]="$ADMIN_USER" )
for k in GITEA_TOKEN AGENT_TOKEN ADMIN_TOKEN; do
  if token_valid "${!k}"; then echo "$k: ok"; skip
  else
    val=$(docker exec -u git gitea gitea admin user generate-access-token \
      --username "${tok_names[$k]}" --token-name seed --scopes all --raw)
    set_env "$k" "$val"; echo "$k: generated → written to .env"
  fi
done

# ── 4. repos ───────────────────────────────────────────────────────
log "Repositories"
api() { curl -sf -H "Authorization: token $ADMIN_TOKEN" -H "Content-Type: application/json" "$@"; }

for repo in "$ADMIN_REPO" "$TEMPLATE_REPO"; do
  if curl -sf -H "Authorization: token $ADMIN_TOKEN" \
      "$GITEA_URL/api/v1/repos/$ADMIN_USER/$repo" >/dev/null 2>&1; then
    echo "repo $repo: ok"; skip
  else
    api -X POST -d "{\"name\":\"$repo\",\"auto_init\":false}" \
      "$GITEA_URL/api/v1/user/repos" >/dev/null
    echo "repo $repo: created"
  fi
done

push_url() { printf 'http://%s:%s@%s/%s/%s.git' "$ADMIN_USER" "$ADMIN_TOKEN" "$HOST" "$ADMIN_USER" "$1"; }

log "Pushing $ADMIN_REPO"
git push -q -f "$(push_url "$ADMIN_REPO")" HEAD:main
echo "pushed $(git rev-parse --short HEAD)"

log "Pushing $TEMPLATE_REPO (source: agents-actions/)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r agents-actions/. "$tmp/"
git -C "$tmp" init -q
git -C "$tmp" add -A
git -C "$tmp" -c user.name="$ADMIN_USER" -c user.email="${ADMIN_USER}@localhost" \
  commit -qm "agents-actions template"
git -C "$tmp" push -q -f "$(push_url "$TEMPLATE_REPO")" HEAD:main
echo "pushed"

log "Template flag on $TEMPLATE_REPO"
api -X PATCH -d '{"template":true}' "$GITEA_URL/api/v1/repos/$ADMIN_USER/$TEMPLATE_REPO" >/dev/null
echo "template: true"

# ── 5. runner registration tokens ──────────────────────────────────
# Only my-runner (plain CI jobs, ubuntu-latest). Agent tasks no longer use
# runners — they go through agentd webhooks (step 7).
log "Runner registration tokens"
if runner_registered my-runner; then
  echo "my-runner registered, skipping"; skip
else
  val=$(api -X POST -d '{"name":"my-runner"}' \
    "$GITEA_URL/api/v1/admin/actions/runners/registration-token" | jq -r .token)
  set_env GITEA_RUNNER_REGISTRATION_TOKEN "$val"
  echo "GITEA_RUNNER_REGISTRATION_TOKEN: minted → written to .env"
fi

# ── 6. services ────────────────────────────────────────────────────
log "Starting runner + agentd"
docker compose up -d runner agentd
docker compose ps runner agentd || true

# ── 7. agentd webhooks ─────────────────────────────────────────────
log "agentd webhooks"
if [[ -z ${WEBHOOK_SECRET:-} ]]; then
  set_env WEBHOOK_SECRET "$(gen_password)"
  echo "WEBHOOK_SECRET: generated → written to .env"
fi
for repo in "${AGENTD_REPOS[@]}"; do
  if curl -sf -H "Authorization: token $ADMIN_TOKEN" \
      "$GITEA_URL/api/v1/repos/$repo/hooks" 2>/dev/null \
      | jq -e --arg u "$WEBHOOK_URL" '.[] | select(.url == $u)' >/dev/null; then
    echo "webhook $repo: ok"; skip
  else
    api -X POST -d "{\"type\":\"gitea\",\"active\":true,\"events\":[\"issue_comment\",\"pull_request_review_comment\"],\"url\":\"$WEBHOOK_URL\",\"password\":\"$WEBHOOK_SECRET\"}" \
      "$GITEA_URL/api/v1/repos/$repo/hooks" >/dev/null
    echo "webhook $repo: created"
  fi
done

log "Done"
echo "  web:      $GITEA_URL"
echo "  admin:    $ADMIN_USER (password in .env)"
echo "  agentd:   http://127.0.0.1:3001 (task dashboard)"
echo "  template: $GITEA_URL/$ADMIN_USER/$TEMPLATE_REPO"
