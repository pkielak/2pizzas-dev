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
# per-agent identities: each work agent is its OWN Gitea user (native
# @mention autocomplete + per-agent commit/PR attribution). The review user
# carries a read token (reviewer clone) and a write token (2pizzas posts the
# verdicts). The legacy single "bot" user is dormant on old instances —
# fresh instances never create it.
# Agent names are read from .env (set by setup.sh agent identities section).
AGENT_WORK1_NAME="${AGENT_WORK1_NAME:-pi}"
AGENT_WORK2_NAME="${AGENT_WORK2_NAME:-opencode}"
AGENT_INFRA_NAME="${AGENT_INFRA_NAME:-infra}"
AGENT_REVIEW_NAME="${AGENT_REVIEW_NAME:-review}"
AGENT_CHAT_NAME="${AGENT_CHAT_NAME:-chat}"
AGENT_USERS="$AGENT_WORK1_NAME $AGENT_WORK2_NAME $AGENT_INFRA_NAME $AGENT_REVIEW_NAME"
CHAT_USER="$AGENT_CHAT_NAME"   # separate login for the /chat agents — audit separation from task work
HOST="${GITEA_URL#http://}"; HOST="${HOST%/}"
ADMIN_REPO="2pizzas-dev"
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
  [[ -n ${1:-} ]] || return 1   # empty token: curl gets "token is required", NOT the invalid-token message
  body=$(curl -s -H "Authorization: token $1" "$GITEA_URL/api/v1/user" 2>/dev/null) || true
  # lowercase: Gitea's 401 body is "Invalid username, password or token"
  # (capital I) — a case-sensitive match would misread a dead token as usable
  body=${body,,}
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
  # Gitea 1.27 has NO admin tokens API (the route 404s) — delete the stale
  # row directly in the db (seed.sh already talks to the db for the webhook)
  docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "DELETE FROM access_token WHERE uid = (SELECT id FROM \"user\" WHERE lower_name='$user') AND name='$name'" >/dev/null
  val=$(docker exec -u git gitea gitea admin user generate-access-token \
    --username "$user" --token-name "$name" --scopes "$scopes" --raw)
  printf '%s' "$val"
}
runner_registered() {
  curl -sf -H "Authorization: token $ADMIN_TOKEN" \
    "$GITEA_URL/api/v1/admin/actions/runners?limit=50" 2>/dev/null \
    | jq -e --arg n "$1" '.runners[] | select(.name == $n)' >/dev/null 2>&1
}
# managed repos — comma-separated in .env (the same value the 2pizzas service reads)
IFS=',' read -r -a AGENTD_REPOS <<< "${AGENTD_REPOS:-$ADMIN_USER/$ADMIN_REPO}"
WEBHOOK_URL="http://2pizzas:3001/webhook"

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
for u in "$ADMIN_USER" $AGENT_USERS "$CHAT_USER"; do
  if user_exists "$u"; then echo "user $u: ok"; skip
  else
    # machine identity — operated only via its API token(s). The password is
    # random and intentionally NOT stored; reset it with:
    #   docker exec -u git gitea gitea admin user change-password --username $u --password …
    pw=$(gen_password)
    docker exec -u git gitea gitea admin user create \
      --username "$u" --email "${u}@localhost" --password "$pw" >/dev/null
    # fresh users carry must_change_password, which blocks their API tokens
    # until a manual password change (change-password via CLI does NOT clear it)
    docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "UPDATE \"user\" SET must_change_password=false WHERE lower_name='$u'" >/dev/null
    echo "user $u: created (random password, not stored)"
  fi
done

# ── 3. API tokens ──────────────────────────────────────────────────
log "API tokens"
# distinct token NAMES per key: gen_token deletes any existing token with the
# same name before creating one, so two keys sharing a name would delete each
# other's token (GITEA_TOKEN clobbered ADMIN_TOKEN when both were "seed")
declare -A tok_user=( [GITEA_TOKEN]="$ADMIN_USER" [ADMIN_TOKEN]="$ADMIN_USER" )
declare -A tok_name=( [GITEA_TOKEN]="gitea-seed" [ADMIN_TOKEN]="admin-seed" )
for k in GITEA_TOKEN ADMIN_TOKEN; do
  if token_usable "${!k:-}"; then echo "$k: ok"; skip
  else
    val=$(gen_token "${tok_user[$k]}" "${tok_name[$k]}" all)
    set_env "$k" "$val"; echo "$k: generated (${tok_name[$k]}, user ${tok_user[$k]}) → written to .env"
  fi
done
# Per-agent tokens — each work agent clones/pushes/posts AS ITS OWN Gitea
# user, so history attributes the work to pi/opencode/infra. Scopes:
# write:repository (clone/push/PR) + read/write:issue (the issue API is
# scope-gated separately — reading issues/comments and posting replies).
AGENT_SCOPES="write:repository,read:issue,write:issue"
declare -A agent_tok_user=( [AGENT_WORK1_TOKEN]="$AGENT_WORK1_NAME" [AGENT_WORK2_TOKEN]="$AGENT_WORK2_NAME" [AGENT_INFRA_TOKEN]="$AGENT_INFRA_NAME" )
for k in AGENT_WORK1_TOKEN AGENT_WORK2_TOKEN AGENT_INFRA_TOKEN; do
  if token_usable "${!k:-}"; then echo "$k: ok"; skip
  else
    val=$(gen_token "${agent_tok_user[$k]}" "2pizzas-${agent_tok_user[$k]}" "$AGENT_SCOPES")
    set_env "$k" "$val"; echo "$k: generated ($AGENT_SCOPES, user ${agent_tok_user[$k]}) → written to .env"
  fi
done
# Code REVIEWER (2pizzas review chain), user "$AGENT_REVIEW_NAME", TWO tokens:
#  - AGENT_REVIEW_TOKEN: read:repository — the review container clones with it
#  - AGENT_REVIEW_POST_TOKEN: write — held by 2pizzas ONLY
if token_usable "${AGENT_REVIEW_TOKEN:-}"; then echo "AGENT_REVIEW_TOKEN: ok"; skip
else
  val=$(gen_token "$AGENT_REVIEW_NAME" "2pizzas-$AGENT_REVIEW_NAME" "read:repository,read:issue")
  set_env AGENT_REVIEW_TOKEN "$val"; echo "AGENT_REVIEW_TOKEN: generated (read:repository) → written to .env"
fi
if token_usable "${AGENT_REVIEW_POST_TOKEN:-}"; then echo "AGENT_REVIEW_POST_TOKEN: ok"; skip
else
  val=$(gen_token "$AGENT_REVIEW_NAME" "2pizzas-$AGENT_REVIEW_NAME-post" "read:issue,write:issue")
  set_env AGENT_REVIEW_POST_TOKEN "$val"; echo "AGENT_REVIEW_POST_TOKEN: generated (read:issue,write:issue) → written to .env"
fi
# Write token for the /chat agents (user "$AGENT_CHAT_NAME"): chat containers
# receive it so the agent can clone/push/post AS THE chat user.
# Write access per repo is still gated by collaborator grants (/chat UI).
if token_usable "${AGENT_CHAT_TOKEN:-}"; then echo "AGENT_CHAT_TOKEN: ok"; skip
else
  val=$(gen_token "$CHAT_USER" "2pizzas-$CHAT_USER" write:repository)
  set_env AGENT_CHAT_TOKEN "$val"; echo "AGENT_CHAT_TOKEN: generated (write:repository) → written to .env"
fi

# ── 4. repos ───────────────────────────────────────────────────────
log "Repositories"
api() { curl -sf -H "Authorization: token $ADMIN_TOKEN" -H "Content-Type: application/json" "$@"; }

# --max-time: a wedged Gitea API must time out, not hang seed forever
# explicit if/else on the create: a bare `api -X POST` would die under
# set -e with no message on failure (the `echo ... created` never runs)
for repo in "$ADMIN_REPO" "$TEMPLATE_REPO"; do
  if curl -sf --max-time 15 -H "Authorization: token $ADMIN_TOKEN" \
      "$GITEA_URL/api/v1/repos/$ADMIN_USER/$repo" >/dev/null 2>&1; then
    echo "repo $repo: ok"; skip
  elif api -X POST --max-time 15 -d "{\"name\":\"$repo\",\"auto_init\":false}" \
      "$GITEA_URL/api/v1/user/repos" >/dev/null; then
    echo "repo $repo: created"
  else
    echo "repo $repo: CREATE FAILED — Gitea API did not create it (check: docker logs gitea)" >&2
    exit 1
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
# they go through 2pizzas webhooks (step 7).
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
log "Starting runners + 2pizzas"
docker compose up -d runner android-runner 2pizzas
docker compose ps runner android-runner 2pizzas || true

# ── 7. 2pizzas webhook (global) + bot access ───────────────────────
log "2pizzas global webhook"
if [[ -z ${WEBHOOK_SECRET:-} ]]; then
  set_env WEBHOOK_SECRET "$(gen_password)"
  echo "WEBHOOK_SECRET: generated → written to .env"
fi
# ONE system-wide webhook covers every repo — new repos need no webhook
# setup; 2pizzas gates on managed repos (env list ∪ self-enrolled) + @agent
# mentions — new repos self-enroll on mention, so this env list is optional.
# Gitea 1.27 has no
# API for system webhooks (admin-UI only), so seed.sh writes the row
# directly: is_system_webhook=true, same shape as the per-repo rows.
psql() { docker exec gitea-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }
# NOTE: 1.27 has NO pull_request_review_comment hook event — inline review
# comments are picked up by 2pizzas's poll fallback (<=60s delay).
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
  # the agent users must be collaborators: work agents write (clone/push/
  # comment as themselves), the reviewer reads (clone only)
  for u in $AGENT_USERS; do
    role=write; [[ $u == "$AGENT_REVIEW_NAME" ]] && role=read
    if api "$GITEA_URL/api/v1/repos/$repo/collaborators?limit=50" 2>/dev/null \
        | jq -e '.[] | select(.login == "'$u'")' >/dev/null; then
      echo "collaborator $repo: $u ok"
    else
      api -X PUT -d "{\"role\":\"$role\"}" \
        "$GITEA_URL/api/v1/repos/$repo/collaborators/$u" >/dev/null
      echo "collaborator $repo: $u ($role) added"
    fi
  done
done

log "Done"
echo "  web:      $GITEA_URL"
echo "  admin:    $ADMIN_USER (password in .env)"
echo "  2pizzas:   http://127.0.0.1:3001 (task dashboard)"
echo "  template: $GITEA_URL/$ADMIN_USER/$TEMPLATE_REPO"
