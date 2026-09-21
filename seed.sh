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
# managed repos — comma-separated in .env (the same value the agentd service reads)
IFS=',' read -r -a AGENTD_REPOS <<< "${AGENTD_REPOS:-$ADMIN_USER/$ADMIN_REPO,$ADMIN_USER/platform-fall}"
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

# ── 7. agentd webhook (global) + bot access ───────────────────────
log "agentd global webhook"
if [[ -z ${WEBHOOK_SECRET:-} ]]; then
  set_env WEBHOOK_SECRET "$(gen_password)"
  echo "WEBHOOK_SECRET: generated → written to .env"
fi
# ONE system-wide webhook covers every repo — new repos need no webhook
# setup; agentd gates on AGENTD_REPOS + @agent mentions. Gitea 1.27 has no
# API for system webhooks (admin-UI only), so seed.sh writes the row
# directly: is_system_webhook=true, same shape as the per-repo rows.
psql() { docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }
# NOTE: 1.27 has NO pull_request_review_comment hook event — inline review
# comments are picked up by agentd's poll fallback (<=60s delay).
HOOK_EVENTS='{"push_only":false,"send_everything":false,"choose_events":true,"branch_filter":"","events":{"issue_comment":true,"pull_request_review":true,"create":false,"repository":false,"status":false,"issues":false,"issue_label":false,"pull_request_label":false,"pull_request_sync":false,"push":false,"fork":false,"wiki":false,"workflow_job":false,"issue_milestone":false,"pull_request_assign":false,"pull_request_milestone":false,"pull_request":false,"pull_request_review_request":false,"delete":false,"release":false,"package":false,"workflow_run":false,"issue_assign":false,"pull_request_comment":false}}'
hook_id=$(psql "SELECT id FROM webhook WHERE is_system_webhook AND url='$WEBHOOK_URL' LIMIT 1")
if [[ -z $hook_id ]]; then
  psql "INSERT INTO webhook (repo_id, owner_id, is_system_webhook, url, name, http_method, content_type, secret, events, is_active, type, meta, last_status, created_unix, updated_unix)
         VALUES (0, 0, true, '$WEBHOOK_URL', '', '', 1, '$WEBHOOK_SECRET', '$HOOK_EVENTS', true, 'gitea', '', 0, $(date +%s), $(date +%s))" >/dev/null
  hook_id=$(psql "SELECT id FROM webhook WHERE is_system_webhook AND url='$WEBHOOK_URL' LIMIT 1")
  echo "global webhook: created (id $hook_id)"
else
  psql "UPDATE webhook SET secret='$WEBHOOK_SECRET', updated_unix=$(date +%s) WHERE id=$hook_id" >/dev/null
  echo "global webhook: ok (id $hook_id, secret refreshed)"
fi
# migrate away from the old per-repo hooks (same URL, non-system rows)
removed=$(psql "DELETE FROM webhook WHERE is_system_webhook=false AND url='$WEBHOOK_URL' RETURNING id" | wc -l | tr -d ' ')
[[ ${removed:-0} -gt 0 ]] && echo "legacy per-repo hooks: removed $removed"

for repo in "${AGENTD_REPOS[@]}"; do
  # bot must be a write collaborator: it clones, commits and comments as bot
  if api "$GITEA_URL/api/v1/repos/$repo/collaborators?limit=50" 2>/dev/null \
      | jq -e '.[] | select(.login == "'$BOT_USER'")' >/dev/null; then
    echo "collaborator $repo: ok"
  else
    api -X PUT -d '{"role":"write"}' \
      "$GITEA_URL/api/v1/repos/$repo/collaborators/$BOT_USER" >/dev/null
    echo "collaborator $repo: $BOT_USER (write) added"
  fi
done

log "Done"
echo "  web:      $GITEA_URL"
echo "  admin:    $ADMIN_USER (password in .env)"
echo "  agentd:   http://127.0.0.1:3001 (task dashboard)"
echo "  template: $GITEA_URL/$ADMIN_USER/$TEMPLATE_REPO"
