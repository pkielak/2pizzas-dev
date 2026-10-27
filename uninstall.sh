#!/usr/bin/env bash
#
# uninstall.sh — tear down the stack that setup.sh built. The inverse of
# setup.sh, in the same style. Every action is idempotent and guarded;
# nothing is deleted until you confirm.
#
# What it removes:
#   1. compose project `gitea` — containers gitea, db, gitea-pages,
#      browser-llm-bench-pages, gitea-runner, gitea-android-runner,
#      gitea-00-tea, plus the `gitea_gitea` network
#   2. leftover 00-tea chat containers (`tea-chat-*`)
#   3. the built images (agent-sandbox:*, gitea-android, gitea-pages,
#      the 00-tea image) — skipped with --keep-images
#   4. the host runtime data dirs (data/, data-agent/, data-00-tea/,
#      data-android/, gitea/, postgres/) — ONLY with --purge
#
# It does NOT touch the git checkout itself, and it does NOT remove the
# host firewall rule setup.sh may have asked you to add (see the summary).
#
# Usage:
#   ./uninstall.sh               # interactive: confirm + ask what to remove
#   ./uninstall.sh --yes         # non-interactive: down + remove images, KEEP data
#   ./uninstall.sh --purge       # also delete the runtime data dirs (FULLY destructive)
#   ./uninstall.sh --keep-images # don't remove the built images
#   ./uninstall.sh --help
#
set -euo pipefail
cd "$(dirname "$0")"

# ── options ─────────────────────────────────────────────────────────
NONINTERACTIVE=0 PURGE=0 KEEP_IMAGES=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --yes|-y)         NONINTERACTIVE=1 ;;
    --purge)          PURGE=1 ;;
    --keep-images)    KEEP_IMAGES=1 ;;
    -h|--help)        grep '^# ' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# ── helpers (same conventions as setup.sh) ──────────────────────────
if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_OK=$'\033[32m' C_WARN=$'\033[33m'
  C_ERR=$'\033[31m' C_INFO=$'\033[36m' C_RST=$'\033[0m'
else
  C_BOLD= C_DIM= C_OK= C_WARN= C_ERR= C_INFO= C_RST=
fi
ok()   { printf '  %s✓%s %s\n' "$C_OK"   "$C_RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RST" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_ERR"  "$C_RST" "$*"; }
note() { printf '  %s·%s %s\n' "$C_DIM"  "$C_RST" "$*"; }

step() {
  printf '\n%s%s━━ %s ━━%s\n' "$C_BOLD" "$C_INFO" "$*" "$C_RST"
}

# ask PROMPT [DEFAULT] VAR — print the prompt to stdout (visible in captured
# output) and read from /dev/tty so it works even when stdout is a pipe
ask() {
  local prompt=$1 def=${2:-} val
  if [[ $NONINTERACTIVE == 1 ]]; then
    printf '  %s%s%s%s: ' "$C_DIM" "$prompt" "${def:+ [$def]}" "$C_RST"
    printf '%s\n' "${def:-<empty>}"
    printf -v "$3" '%s' "$def"
  else
    printf '  %s%s%s%s: ' "$C_DIM" "$prompt" "${def:+ [$def]}" "$C_RST"
    read -r val </dev/tty || val=$def
    printf -v "$3" '%s' "${val:-$def}"
  fi
}

# yesno PROMPT [DEFAULT y|n] — returns 0/1
yesno() {
  local prompt=$1 def=${2:-y} val
  if [[ $NONINTERACTIVE == 1 ]]; then
    [[ $def == y ]]; return
  fi
  printf '  %s%s%s%s: ' "$C_DIM" "$prompt" " [$def]" "$C_RST"
  read -r val </dev/tty || val=$def
  [[ ${val:-$def} =~ ^[Yy] ]]
}

# ── 0. preflight ───────────────────────────────────────────────────
step "Preflight"
command -v docker >/dev/null || { err "docker not found — nothing to tear down"; exit 1; }
ok "docker present"

# what will actually be removed
RUNNING=$(docker ps --filter "publish=3000" --filter "publish=3001" --filter "publish=3002" --format '{{.Names}}' 2>/dev/null | paste -sd', ' -) || true
COMPOSE_N=$(docker compose ps --format json 2>/dev/null | grep -c . 2>/dev/null) || COMPOSE_N=0
CHAT_N=$(docker ps -a --filter "name=tea-chat-" --format '{{.ID}}' 2>/dev/null | grep -c . 2>/dev/null) || CHAT_N=0
IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E '^(agent-sandbox|gitea-android|gitea-pages)(:|/)' \
  | grep -vE '^<none>' | sort -u | paste -sd', ' -) || true
DATA_DIRS=""
for d in data data-agent data-00-tea data-android gitea postgres; do
  [[ -e "$d" ]] && DATA_DIRS="$DATA_DIRS $d/"
done

note "compose containers now up : ${RUNNING:-none}"
note "leftover chat containers  : ${CHAT_N:-0}"
note "built images              : ${IMAGES:-none}"
note "host data dirs            : ${DATA_DIRS:-none}"

if [[ -z $RUNNING && -z $IMAGES && -z $DATA_DIRS && "${CHAT_N:-0}" == 0 ]]; then
  ok "nothing to remove — the stack does not appear to be installed here"
  exit 0
fi

# ── 1. confirm ─────────────────────────────────────────────────────
step "Confirm"
printf '%s\n' \
  "  This will:" \
  "    • stop + remove the compose project 'gitea' (Gitea, Postgres, 00-tea," \
  "      runners, pages) and the gitea_gitea network" \
  "    • remove leftover tea-chat-* containers"
if [[ $KEEP_IMAGES == 1 ]]; then
  printf '    • KEEP the built images\n'
else
  printf '    • remove the built images (agent-sandbox:*, gitea-android, gitea-pages, 00-tea)\n'
fi
if [[ $PURGE == 1 ]]; then
  printf '    • %sDELETE the host data dirs:%s%s (all Gitea data, task logs, sqlite)%s\n' \
    "$C_ERR" "$DATA_DIRS" "$C_RST" ""
else
  printf '    • KEEP the host data dirs (%s)\n' "${DATA_DIRS:-none}"
fi
printf '\n'
if [[ $NONINTERACTIVE == 1 ]]; then
  note "--yes: proceeding non-interactively"
elif ! yesno "proceed?" n; then
  warn "aborted — nothing removed"
  exit 0
fi

# ── 2. compose down ────────────────────────────────────────────────
step "Stopping + removing compose project 'gitea'"
if [[ -f docker-compose.yml ]]; then
  docker compose down --remove-orphans >/dev/null 2>&1 \
    && ok "compose project down (containers + gitea_gitea network removed)" \
    || warn "compose down reported an error (may already be down)"
else
  warn "no docker-compose.yml in this dir — skipping compose down"
fi

# ── 3. leftover chat containers ────────────────────────────────────
CHAT_LEFT=$(docker ps -a --filter "name=tea-chat-" --format '{{.ID}}' 2>/dev/null) || true
if [[ -n $CHAT_LEFT ]]; then
  # shellcheck disable=SC2086  # ids are docker-safe; -f forces removal of running ones
  docker rm -f $CHAT_LEFT >/dev/null 2>&1 \
    && ok "removed leftover chat containers" \
    || warn "some chat containers could not be removed"
else
  ok "no leftover chat containers"
fi

# ── 4. built images ────────────────────────────────────────────────
if [[ $KEEP_IMAGES == 1 ]]; then
  note "keeping built images (--keep-images)"
else
  step "Removing built images"
  # only the images THIS repo builds — never the pulled gitea/postgres/runner base images
  to_remove=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E '^(agent-sandbox|gitea-android|gitea-pages)(:|/)' \
    | grep -vE '^<none>' | sort -u) || true
  if [[ -n $to_remove ]]; then
    # shellcheck disable=SC2086
    docker rmi $to_remove >/dev/null 2>&1 \
      && ok "removed: $(echo "$to_remove" | paste -sd', ' -)" \
      || warn "some images could not be removed (in use?)"
  else
    ok "no built images present"
  fi
fi

# ── 5. host data dirs (only --purge) ───────────────────────────────
if [[ $PURGE == 1 ]]; then
  step "Deleting host data dirs (--purge)"
  for d in data data-agent data-00-tea data-android gitea postgres; do
    if [[ -e "$d" ]]; then
      rm -rf -- "$d" && ok "removed $d/" || err "failed to remove $d/"
    fi
  done
else
  note "keeping host data dirs (re-run with --purge to delete them): ${DATA_DIRS:-none}"
fi

# ── 6. summary ─────────────────────────────────────────────────────
step "Done"
ok "teardown complete"
note "the git checkout itself was left untouched"
note "if setup.sh's preflight asked you to add a firewall rule, it is still in place:"
note "  sudo ufw route allow in on any to 172.18.0.0/16   (remove with: sudo ufw route delete ... )"
