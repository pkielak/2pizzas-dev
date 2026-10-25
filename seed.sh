#!/usr/bin/env bash
#
# seed.sh — bootstrap a fresh Gitea instance with this infra's users, tokens,
# repos, template and runners. Idempotent: every step skips itself when the
# thing already exists, so it is safe to re-run (and safe to run against an
# already-running instance).
#
# Usage:
#   ./setup.sh          # preferred — interactive wizard that does all of this
#   cp .env.example .env && $EDITOR .env   # postgres creds at minimum
#   docker compose up -d db server
#   ./seed.sh
#
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "error: no .env (cp .env.example .env)"; exit 1; }
set -a; source .env; set +a

GITEA_URL="${GITEA_URL:-http://localhost:3000}"
ADMIN_USER="${ADMIN_USER:-admin}"
BOT_USER="bot"
CHAT_USER="chat"   # separate login for the /chat agents — audit separation from task work
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
# token_usable — the token is RECOGNIZED by Gitea. Scoped tokens
# (read:repository, write:repository) cannot call /api/v1/user (needs
# read:user), so check the auth-failure message, not the status code —
# a 403 "Forbidden" means the token works, just without that scope.
token_usable() {
  local body
  body=$(curl -s -H "Authorization: token $1" "$GITEA_URL/api/v1/user" 2>/dev/null) || true
  [[ -n $body && $body != *"invalid username, password or token"* ]]
}
# gen_token USER NAME SCOPES — mints a token; if the name is already in use
# (stale .env, manual token) the old one is deleted first via the admin API,
# so seed stays idempotent instead of dying with "name has been used already"
gen_token() {
  local user=$1 name=$2 scopes=$3 val id admin
  if val=$(docker exec -u git gitea gitea admin user generate-access-token \
      --username "$user" --token-name "$name" --scopes "$scopes" --raw 2>/dev/null); then
    printf '%s' "$val"; return
  fi
  # a valid admin-scope token for the cleanup API (GITEA_TOKEN is minted
  # first, so it is available even while ADMIN_TOKEN itself is being fixed)
  if token_usable "${GITEA_TOKEN:-}"; then admin=$GITEA_TOKEN; else admin=$ADMIN_TOKEN; fi
  id=$(curl -sf -H "Authorization: token $admin" \
    "$GITEA_URL/api/v1/admin/users/$user/tokens" 2>/dev/null \
    | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' || true)
  [[ -n $id ]] && curl -sf -X DELETE -H "Authorization: token $admin" \
    "$GITEA_URL/api/v1/admin/users/$user/tokens/$id" >/dev/null
  val=$(docker exec -u git gitea gitea admin user generate-access-token \
    --username "$user" --token-name "$name" --scopes "$scopes" --raw)
  printf '%s' "$val"
}
runner_registered() {
  curl -sf -H "Authorization: token $ADMIN_TOKEN" \
    "$GITEA_URL/api/v1/admin/actions/runners?limit=50" 2>/dev/null \
    | jq -e --arg n "$1" '.runners[] | select(.name == $n)' >/dev/null 2>&1
}
# managed repos — comma-separated in .env (the same value the 00-tea service reads)
IFS=',' read -r -a AGENTD_REPOS <<< "${AGENTD_REPOS:-$ADMIN_USER/$ADMIN_REPO}"
WEBHOOK_URL="http://00-tea:3001/webhook"

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
for u in "$ADMIN_USER" "$BOT_USER" "$CHAT_USER"; do
  if user_exists "$u"; then echo "user $u: ok"; skip
  else
    if [[ $u == "$CHAT_USER" ]]; then
      # machine identity — operated only via CHAT_GITEA_TOKEN. The password is
      # random and intentionally NOT stored; reset it with:
      #   docker exec -u git gitea gitea admin user change-password --username chat --password …
      pw=$(gen_password)
    else
      pw_var=ADMIN_PASSWORD; [[ $u == "$BOT_USER" ]] && pw_var=BOT_PASSWORD
      pw="${!pw_var}"
      [[ -n $pw ]] || { pw=$(gen_password); set_env "$pw_var" "$pw"; }
    fi
    docker exec -u git gitea gitea admin user create \
      --username "$u" --email "${u}@localhost" --password "$pw" >/dev/null
    # fresh users carry must_change_password, which blocks their API tokens
    # until a manual password change (change-password via CLI does NOT clear it)
    docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "UPDATE \"user\" SET must_change_password=false WHERE lower_name='$u'" >/dev/null
    echo "user $u: created (password stored in .env)"
  fi
done

# ── 3. API tokens ──────────────────────────────────────────────────
log "API tokens"
declare -A tok_names=( [GITEA_TOKEN]="$ADMIN_USER" [AGENT_TOKEN]="$BOT_USER" [ADMIN_TOKEN]="$ADMIN_USER" )
for k in GITEA_TOKEN AGENT_TOKEN ADMIN_TOKEN; do
  if token_usable "${!k}"; then echo "$k: ok"; skip
  else
    val=$(gen_token "${tok_names[$k]}" seed all)
    set_env "$k" "$val"; echo "$k: generated → written to .env"
  fi
done
# Read-only bot token for the code REVIEWER (00-tea review chain): the review
# container clones with it and gets nothing else, so a reviewer physically
# cannot push — it can only review.
if token_usable "${REVIEW_TOKEN:-}"; then echo "REVIEW_TOKEN: ok"; skip
else
  val=$(gen_token "$BOT_USER" review read:repository)
  set_env REVIEW_TOKEN "$val"; echo "REVIEW_TOKEN: generated (read:repository) → written to .env"
fi
# Write token for the /chat agents (user "chat"): chat containers receive it
# so the agent can clone/push/post AS THE chat user — Gitea history then
# shows chat-driven work under a separate login, not under bot or the admin.
# Write access per repo is still gated by collaborator grants (/chat UI).
if token_usable "${CHAT_GITEA_TOKEN:-}"; then echo "CHAT_GITEA_TOKEN: ok"; skip
else
  val=$(gen_token "$CHAT_USER" 00-tea-chat write:repository)
  set_env CHAT_GITEA_TOKEN "$val"; echo "CHAT_GITEA_TOKEN: generated (write:repository) → written to .env"
fi

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
# my-runner (plain CI jobs, ubuntu-latest) + android-runner (label
# `android`, gitea-android job image). Agent tasks no longer use runners —
# they go through 00-tea webhooks (step 7).
log "Runner registration tokens"
if runner_registered my-runner; then
  echo "my-runner registered, skipping"; skip
else
  val=$(api -X POST -d '{"name":"my-runner"}' \
    "$GITEA_URL/api/v1/admin/actions/runners/registration-token" | jq -r .token)
  set_env GITEA_RUNNER_REGISTRATION_TOKEN "$val"
  echo "GITEA_RUNNER_REGISTRATION_TOKEN: minted → written to .env"
fi
if runner_registered android-runner; then
  echo "android-runner registered, skipping"; skip
else
  val=$(api -X POST -d '{"name":"android-runner"}' \
    "$GITEA_URL/api/v1/admin/actions/runners/registration-token" | jq -r .token)
  set_env GITEA_RUNNER_ANDROID_REGISTRATION_TOKEN "$val"
  echo "GITEA_RUNNER_ANDROID_REGISTRATION_TOKEN: minted → written to .env"
fi

# ── 6. services ────────────────────────────────────────────────────
log "Starting runners + 00-tea"
docker compose up -d runner android-runner 00-tea
docker compose ps runner android-runner 00-tea || true

# ── 7. 00-tea webhook (global) + bot access ───────────────────────
log "00-tea global webhook"
if [[ -z ${WEBHOOK_SECRET:-} ]]; then
  set_env WEBHOOK_SECRET "$(gen_password)"
  echo "WEBHOOK_SECRET: generated → written to .env"
fi
# ONE system-wide webhook covers every repo — new repos need no webhook
# setup; 00-tea gates on managed repos (env list ∪ self-enrolled) + @agent
# mentions — new repos self-enroll on mention, so this env list is optional.
# Gitea 1.27 has no
# API for system webhooks (admin-UI only), so seed.sh writes the row
# directly: is_system_webhook=true, same shape as the per-repo rows.
psql() { docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }
# NOTE: 1.27 has NO pull_request_review_comment hook event — inline review
# comments are picked up by 00-tea's poll fallback (<=60s delay).
# pull_request_comment: comments on a PR fire THIS event, not issue_comment —
# without it, @agent mentions on PRs are never delivered
HOOK_EVENTS='{"push_only":false,"send_everything":false,"choose_events":true,"branch_filter":"","events":{"issue_comment":true,"pull_request_review":true,"create":false,"repository":false,"status":false,"issues":false,"issue_label":false,"pull_request_label":false,"pull_request_sync":false,"push":false,"fork":false,"wiki":false,"workflow_job":false,"issue_milestone":false,"pull_request_assign":false,"pull_request_milestone":false,"pull_request":false,"pull_request_review_request":false,"delete":false,"release":false,"package":false,"workflow_run":false,"issue_assign":false,"pull_request_comment":true}}'
# match by pattern, not exact URL: survives dispatcher host renames (the
# UPDATE below normalizes the stored URL back to $WEBHOOK_URL)
hook_id=$(psql "SELECT id FROM webhook WHERE is_system_webhook AND url LIKE '%:3001/webhook' LIMIT 1")
if [[ -z $hook_id ]]; then
  psql "INSERT INTO webhook (repo_id, owner_id, is_system_webhook, url, name, http_method, content_type, secret, events, is_active, type, meta, last_status, created_unix, updated_unix)
         VALUES (0, 0, true, '$WEBHOOK_URL', '', '', 1, '$WEBHOOK_SECRET', '$HOOK_EVENTS', true, 'gitea', '', 0, $(date +%s), $(date +%s))" >/dev/null
  hook_id=$(psql "SELECT id FROM webhook WHERE is_system_webhook AND url LIKE '%:3001/webhook' LIMIT 1")
  echo "global webhook: created (id $hook_id)"
else
  psql "UPDATE webhook SET url='$WEBHOOK_URL', secret='$WEBHOOK_SECRET', events='$HOOK_EVENTS', updated_unix=$(date +%s) WHERE id=$hook_id" >/dev/null
  echo "global webhook: ok (id $hook_id, url+secret refreshed)"
fi
# migrate away from the old per-repo hooks (same URL, non-system rows)
# (grep -c . — psql -tAc emits a stray empty line, so wc -l overcounts by 1)
removed=$(psql "DELETE FROM webhook WHERE is_system_webhook=false AND url='$WEBHOOK_URL' RETURNING id" | grep -c . || true)
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
echo "  00-tea:   http://127.0.0.1:3001 (task dashboard)"
echo "  template: $GITEA_URL/$ADMIN_USER/$TEMPLATE_REPO"
