#!/usr/bin/env bash
#
# setup.sh — one-command setup for this infra. An interactive multi-step
# wizard that takes a bare checkout to a running, fully seeded stack:
#
#   1. preflight       — tooling, ports, runsc, llama.cpp router
#   2. agent configs   — pi/opencode model files (from .example + router)
#   3. .env            — generated/finished interactively
#   4. images          — 00-tea, pages, agent-sandbox:*, gitea-android
#   5. gitea + db      — compose up + health wait
#   6. seed            — users, tokens, repos, runners, webhook (seed.sh)
#   7. full stack      — compose up -d (everything)
#   8. verify + summary
#
# Every step is idempotent: re-running on an existing setup skips what
# already exists.
#
# Usage:
#   ./setup.sh             # interactive wizard
#   ./setup.sh --yes       # non-interactive: defaults + existing .env
#   ./setup.sh --rebuild   # force-rebuild all images
#   ./setup.sh --skip-build
#   ./setup.sh --no-android
#
set -euo pipefail
cd "$(dirname "$0")"

# ── options ─────────────────────────────────────────────────────────
NONINTERACTIVE=0 REBUILD=0 SKIP_BUILD=0 WANT_ANDROID=ask
while [[ $# -gt 0 ]]; do
  case $1 in
    --yes|-y)     NONINTERACTIVE=1 ;;
    --rebuild)    REBUILD=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-android) WANT_ANDROID=0 ;;
    -h|--help)    grep '^# ' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# ── helpers ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_OK=$'\033[32m' C_WARN=$'\033[33m'
  C_ERR=$'\033[31m' C_INFO=$'\033[36m' C_RST=$'\033[0m'
else
  C_BOLD= C_DIM= C_OK= C_WARN= C_ERR= C_INFO= C_RST=
fi
ok()   { printf '  %s✓%s %s\n' "$C_OK"   "$C_RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RST" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_ERR"  "$C_RST" "$*" >&2; }

STEP=0
step() {
  STEP=$((STEP + 1))
  printf '\n%s%s━━ step %s/%s — %s ━━%s\n' "$C_BOLD" "$C_INFO" "$STEP" 8 "$*" "$C_RST"
}

# ask PROMPT [DEFAULT] VAR — in --yes mode just prints the used default
ask() {
  local prompt=$1 def=${2:-} val
  if [[ $NONINTERACTIVE == 1 ]]; then
    printf '  %s%s%s: %s%s\n' "$C_DIM" "$prompt" "$C_RST" "${def:-<empty>}" "$C_RST"
    printf -v "$3" '%s' "$def"
  else
    read -r -p "  ${prompt}${def:+ [$def]}: " val </dev/tty || val=$def
    printf -v "$3" '%s' "${val:-$def}"
  fi
}

# yesno PROMPT [DEFAULT y|n] — returns 0/1
yesno() {
  local prompt=$1 def=${2:-y} val
  if [[ $NONINTERACTIVE == 1 ]]; then
    [[ $def == y ]]; return
  fi
  read -r -p "  ${prompt} [${def}]: " val </dev/tty || val=$def
  [[ ${val:-$def} =~ ^[Yy] ]]
}

# runq LABEL CMD... — run with a spinner; stream output to a temp file and
# show it (tail) on failure
runq() {
  local label=$1; shift
  local tmp; tmp=$(mktemp)
  "$@" >"$tmp" 2>&1 &
  local pid=$! rc=0
  if [[ -t 1 && $NONINTERACTIVE == 0 ]]; then
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    while kill -0 $pid 2>/dev/null; do
      printf '\r  %s%s%s %s' "${frames:i%10:1}" "$C_DIM" "$C_RST" "$label"
      sleep 0.1; i=$((i + 1))
    done
    printf '\r\033[2K'
  fi
  wait $pid || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "$C_ERR command failed (${label}) — output:$C_RST" >&2
    tail -n 20 "$tmp" >&2
  fi
  rm -f "$tmp"
  return $rc
}

gen_password() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

set_env() { # KEY VALUE — upsert a line in .env
  if [[ -f .env ]] && grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
env_get() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2-; }

# ── 1. preflight ───────────────────────────────────────────────────
step "Preflight checks"

# package manager detection — for offering to install missing tools
PKG_MGR=""
for pm in apt-get dnf yum apk pacman brew; do
  if command -v $pm >/dev/null 2>&1; then PKG_MGR=$pm; break; fi
done
if [[ ${EUID:-$(id -u)} == 0 ]]; then SUDO=""; else SUDO="sudo"; fi
pkg_install() { # PKG... — install via the detected package manager
  case $PKG_MGR in
    apt-get)  $SUDO apt-get install -y --no-install-recommends "$@" ;;
    dnf)      $SUDO dnf install -y "$@" ;;
    yum)      $SUDO yum install -y "$@" ;;
    apk)      apk add --no-cache "$@" ;;
    pacman)   $SUDO pacman -Sy --noconfirm "$@" ;;
    brew)     brew install "$@" ;;
  esac
}

MISSING=""
for t in git jq curl; do
  if command -v $t >/dev/null; then ok "$t"
  else MISSING="$MISSING $t"; fi
done
if [[ -n $MISSING ]]; then
  if [[ -n $PKG_MGR ]] && yesno "install missing tools($MISSING) via $PKG_MGR?" y; then
    pkg_install $MISSING && MISSING=""
  else
    warn "missing:$MISSING — install with: ${PKG_MGR:-your package manager} install$MISSING"
  fi
  for t in $MISSING; do err "$t still missing"; done
  [[ -n $MISSING ]] && { echo "$C_ERR aborting: install the missing tools above$C_RST" >&2; exit 1; }
fi

if command -v docker >/dev/null; then ok "docker"
else
  err "docker not found — install from https://docs.docker.com/engine/install/ and re-run"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then ok "docker compose plugin"
else
  err "docker compose plugin not found — install: $PKG_MGR install docker-compose-plugin (or https://docs.docker.com/compose/install/)"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "docker daemon not reachable (user not in the docker group? run: $SUDO usermod -aG docker \$USER, then re-login)"
  exit 1
fi
ok "docker daemon reachable"

# disk space — image builds + models need room
AVAIL_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -d 'BG ')
if [[ -n $AVAIL_GB ]] && [[ $AVAIL_GB -lt 10 ]]; then
  warn "only ${AVAIL_GB}GB free on / — image builds may need more"
else ok "disk space (${AVAIL_GB:-?}GB free)"; fi

for p in 3000 3001 3002 222; do
  if port_in_use $p; then
    # ours? a container of this stack may already be listening (re-run)
    holder=$(docker ps --filter publish=$p --format '{{.Names}}' | head -1)
    if [[ -n $holder ]]; then ok "port $p in use by $holder (existing stack)"
    else err "port $p is already in use by something else"; fi
  else ok "port $p free"; fi
done

if command -v runsc >/dev/null; then ok "runsc (gVisor) — agent sandboxes"
else
  warn "runsc (gVisor) not found — the stack runs, but AGENT TASKS will fail until it is installed:"
  warn "  latest release: https://github.com/google/gvisor/releases — download runsc + containerd-shim-runsc-v1-<arch>, install both to /usr/local/bin, then restart the docker daemon"
fi

# llama.cpp router — needed for the agents, not for the stack itself
LLAMA_PREFLIGHT=$(env_get LLAMA_CPP_URL)
if [[ -n $LLAMA_PREFLIGHT ]] && curl -sf --max-time 3 "$LLAMA_PREFLIGHT/v1/models" >/dev/null 2>&1; then
  ok "llama.cpp router reachable at $LLAMA_PREFLIGHT"
elif [[ -n $LLAMA_PREFLIGHT ]]; then
  warn "llama.cpp router NOT reachable at $LLAMA_PREFLIGHT — the stack works, but agent tasks will fail until it is up"
else
  warn "no LLAMA_CPP_URL set yet — you will be asked for it in the .env step"
fi

# ── 2. agent model config files (gitignored) ───────────────────────
step "Agent model configs (baked into the agent images)"
# pi: agent-sandbox/pi/pi-settings/models.json
# opencode: agent-sandbox/opencode/opencode-config/opencode.json
# Both are gitignored (they carry the router API key) and are COPY'd into
# the images at build time — missing files abort the build.
LLAMA_URL=$(env_get LLAMA_CPP_URL)
[[ -n $LLAMA_URL ]] || LLAMA_URL="http://localhost:8080"

# model list: prefer the live router, fall back to the .example set
LIVE_MODELS=$(curl -sf --max-time 3 "$LLAMA_URL/v1/models" 2>/dev/null | jq -c '[.data[].id]' 2>/dev/null || true)
if [[ -n $LIVE_MODELS ]]; then ok "model list read from router: $(echo "$LIVE_MODELS" | jq -r 'join(", ")')"
else warn "router unreachable — generated configs will use the .example model list"; fi

gen_pi_models() { # URL KEY OUT_FILE
  local url=$1 key=${2:-no-key} out=$3
  if [[ -n $LIVE_MODELS ]]; then
    jq -n --arg b "$url/v1" --arg k "$key" --argjson ids "$LIVE_MODELS" \
      '{providers:{"llama.cpp":{baseUrl:$b,api:"openai-completions",apiKey:$k,
        models:[($ids[]|{id:.,contextWindow:65536})]}}}' > "$out"
  else
    sed "s|<your-llama-cpp-api-key>|$key|; s|http://localhost:8080/v1|$url/v1|" \
      agent-sandbox/pi/pi-settings/models.json.example > "$out"
  fi
}
gen_opencode_config() { # URL KEY OUT_FILE
  local url=$1 key=${2:-no-key} out=$3
  if [[ -n $LIVE_MODELS ]]; then
    local first; first=$(echo "$LIVE_MODELS" | jq -r '.[0]')
    jq -n --arg b "$url/v1" --arg k "$key" --arg m "llama.cpp/$first" --argjson ids "$LIVE_MODELS" \
      '{model:$m,
        provider:{"llama.cpp":{npm:"@ai-sdk/openai-compatible",name:"llama.cpp",
          options:{baseURL:$b,apiKey:$k},
          models:($ids|map({(.):{name:.}}))|add)}}' > "$out"
  else
    sed "s|YOUR_API_KEY|$key|; s|http://<LLAMA_CPP_HOST:PORT>/v1|$url/v1|" \
      agent-sandbox/opencode/opencode-config/opencode.json.example > "$out"
  fi
}

PI_MODELS=agent-sandbox/pi/pi-settings/models.json
OC_CONFIG=agent-sandbox/opencode/opencode-config/opencode.json
LLAMA_KEY=""
if [[ ! -f $PI_MODELS || ! -f $OC_CONFIG ]]; then
  ask "llama.cpp router URL (as reachable from the host)" "$LLAMA_URL" LLAMA_URL
  ask "router API key (empty if the router requires none)" "" LLAMA_KEY
  [[ -f $PI_MODELS ]] || { gen_pi_models "$LLAMA_URL" "$LLAMA_KEY" "$PI_MODELS"; ok "generated $PI_MODELS"; }
  [[ -f $OC_CONFIG ]] || { gen_opencode_config "$LLAMA_URL" "$LLAMA_KEY" "$OC_CONFIG"; ok "generated $OC_CONFIG"; }
else
  ok "pi models.json present"
  ok "opencode config present"
fi

# ── 3. .env ─────────────────────────────────────────────────────────
step ".env"
if [[ ! -f .env ]]; then
  echo "  no .env — generating one"
  ask "Gitea web URL"        "http://localhost:3000" GITEA_URL
  ask "admin Gitea username" "admin"                 ADMIN_USER
  ask "postgres user"        "gitea"                 PG_USER
  ask "postgres password (empty = auto-generate)"    ""              PG_PASS
  ask "postgres db name"     "gitea"                 PG_DB
  ask "llama.cpp router URL" "$LLAMA_URL"            LLLAMA
  ask "this checkout's host path (infra agent mount; empty = disabled)" "$PWD" INFRA_HOST
  ask "managed repos (comma-separated, optional — repos self-enroll on @agent mention)" "" AGENTD
  cat > .env <<EOF
# generated by setup.sh — secrets live here, gitignored, never committed
GITEA_URL=$GITEA_URL
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=
BOT_PASSWORD=
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=$PG_DB
GITEA_RUNNER_REGISTRATION_TOKEN=
GITEA_RUNNER_ANDROID_REGISTRATION_TOKEN=
AGENTD_REPOS=$AGENTD
WEBHOOK_SECRET=
GITEA_TOKEN=
AGENT_TOKEN=
REVIEW_TOKEN=
ADMIN_TOKEN=
INFRA_REPO=$ADMIN_USER/gitea-with-agents
INFRA_HOST_REPO=$INFRA_HOST
INFRA_COOLDOWN_MINUTES=15
LLAMA_CPP_URL=$LLLAMA
CHAT_TOKEN=
CHAT_GITEA_TOKEN=
CHAT_MEMORY=4g
CHAT_CPUS=2
# cap for one-shot agent job containers (1 concurrent) — protects llama.cpp's cores
AGENT_CPUS=2
PAGES_SITES=
EOF
  ok ".env created"
fi

# finish any empty required keys
declare -A FILL_DEFAULTS=( [POSTGRES_USER]=gitea [POSTGRES_DB]=gitea \
  [GITEA_URL]="http://localhost:3000" [ADMIN_USER]=admin [LLAMA_CPP_URL]="$LLAMA_URL" )
for k in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB GITEA_URL ADMIN_USER LLAMA_CPP_URL; do
  v=$(env_get $k)
  if [[ -z $v ]]; then
    if [[ $k == POSTGRES_PASSWORD && $NONINTERACTIVE == 1 ]]; then
      v=$(gen_password); set_env "$k" "$v"
      ok "$k: auto-generated"
    else
      ask "$k" "${FILL_DEFAULTS[$k]:-}" v
      set_env "$k" "$v"; ok "$k: set"
    fi
  fi
done
ok ".env complete"

# CPU allocation — llama.cpp (host inference) vs the agent side.
# The task pump runs ONE agent job at a time (concurrency=1); chat
# containers are capped at CHAT_CPUS each; the rest is gitea/00-tea/runner.
# Inference dominates, so it gets the bulk of the cores.
cores=$(nproc 2>/dev/null || echo 8)
AGENT_RESERVE=4
llama_rec=$(( cores > AGENT_RESERVE + 2 ? cores - AGENT_RESERVE : 2 ))
ask "cores for llama.cpp (host has $cores; ~$AGENT_RESERVE kept for agent jobs + chat + system)" "$llama_rec" LLAMA_CPUS
[[ $LLAMA_CPUS =~ ^[0-9]+$ ]] || LLAMA_CPUS=$llama_rec
set_env LLAMA_CPUS "$LLAMA_CPUS"
left=$(( cores - LLAMA_CPUS ))
if (( left < AGENT_RESERVE )); then
  warn "only $left cores left for agents/chat/system — agent tasks will be slow while inference runs"
else
  ok "CPU plan: llama.cpp=$LLAMA_CPUS · agents+chat+system=$left"
fi
ok "run the router with -t $LLAMA_CPUS (threads) to match"

# ── 4. build images ─────────────────────────────────────────────────
step "Images"
if [[ $SKIP_BUILD == 1 ]]; then
  warn "skipping builds (--skip-build)"
else
  build_img() { # TAG CONTEXT [extra args...]
    local tag=$1 ctx=$2; shift 2
    if [[ $REBUILD == 0 ]] && docker image inspect "$tag" >/dev/null 2>&1; then
      ok "$tag present"
      return
    fi
    runq "building $tag" docker build -t "$tag" "$@" "$ctx" || exit 1
    ok "built $tag"
  }

  build_img 00-tea           ./00-tea
  build_img gitea-pages:latest ./pages
  build_img agent-sandbox:base  agent-sandbox
  build_img agent-sandbox:pi    agent-sandbox/pi  --build-arg "LLAMA_BASE_URL=$LLAMA_URL"
  build_img agent-sandbox:opencode agent-sandbox/opencode
  build_img agent-sandbox:review   agent-sandbox/review
  build_img agent-sandbox:infra    agent-sandbox/infra
  build_img agent-sandbox:ops      agent-sandbox/ops

  android=0
  [[ $WANT_ANDROID == 1 ]] && android=1
  if [[ $WANT_ANDROID == ask ]] && yesno "build the android-runner job image (gitea-android, large SDK download)?"; then
    android=1
  fi
  if [[ $android == 1 ]]; then
    build_img gitea-android:latest runner/android
  else
    warn "skipping gitea-android:latest (the android-runner service will not register; re-run with the prompt answered yes, or: docker build -t gitea-android:latest runner/android)"
  fi
fi

# ── 5. gitea + db ──────────────────────────────────────────────────
step "Starting Gitea + Postgres"
if docker ps --format '{{.Names}}' | grep -qx gitea; then ok "gitea already running"
else
  runq "compose up db server" docker compose up -d db server || exit 1
fi
ok "waiting for Gitea at $(env_get GITEA_URL)"
up=0
for _ in $(seq 1 60); do
  curl -sf "$(env_get GITEA_URL)/api/healthz" >/dev/null 2>&1 && { up=1; break; }
  sleep 2
done
[[ $up == 1 ]] || { err "Gitea did not come up (docker logs gitea)"; exit 1; }
ok "Gitea is healthy"

# ── 6. seed ─────────────────────────────────────────────────────────
step "Seeding (users, tokens, repos, runners, webhook)"
if [[ -n $(curl -sf -H "Authorization: token $(env_get ADMIN_TOKEN)" \
      "$(env_get GITEA_URL)/api/v1/user" 2>/dev/null) ]]; then
  ok "already seeded (admin token valid) — re-running seed.sh to keep in sync"
fi
./seed.sh || exit 1
ok "seed complete"

# ── 7. full stack ──────────────────────────────────────────────────
step "Starting the full stack"
runq "compose up -d" docker compose up -d || exit 1
sleep 3
docker compose ps || true

# ── 8. verify + summary ────────────────────────────────────────────
step "Verification"
ADMIN_TOKEN=$(env_get ADMIN_TOKEN)
GURL=$(env_get GITEA_URL)
curl -sf "$GURL/api/healthz" >/dev/null && ok "Gitea API" || warn "Gitea API not answering"
curl -sf http://127.0.0.1:3001/healthz >/dev/null && ok "00-tea dispatcher (:3001)" || warn "00-tea not answering on :3001 yet (give it a moment)"

runners=$(curl -sf -H "Authorization: token $ADMIN_TOKEN" \
  "$GURL/api/v1/admin/actions/runners?limit=50" 2>/dev/null | jq -r '.runners[].name' 2>/dev/null | tr '\n' ' ')
[[ -n $runners ]] && ok "runners registered: $runners" || warn "no runners registered yet (they self-register on container start — check: docker logs gitea-runner)"

hook=$(docker exec gitea-db-1 psql -U "$(env_get POSTGRES_USER)" -d "$(env_get POSTGRES_DB)" \
  -tAc "SELECT id FROM webhook WHERE is_system_webhook LIMIT 1" 2>/dev/null || true)
[[ -n $hook ]] && ok "global 00-tea webhook (db id $hook)" || warn "no global webhook row found"

models=$(curl -sf --max-time 3 "$(env_get LLAMA_CPP_URL)/v1/models" 2>/dev/null | jq -r '[.data[].id] | join(", ")' 2>/dev/null || true)
[[ -n $models ]] && ok "llama.cpp models available: $models" || warn "llama.cpp router not reachable — agent tasks will fail until it is up"

printf '\n%s%sSetup complete%s%s\n' "$C_BOLD" "$C_OK" "$C_RST" "$C_BOLD"
cat <<EOF

  $C_INFO What's running:$C_RST
    Gitea        $GURL          (admin: $(env_get ADMIN_USER) — password in .env)
    00-tea UI    http://127.0.0.1:3001  (task dashboard, /chat, /android, /pages)
    SSH          port 222

  $C_INFO Try it:$C_RST
    1. open $GURL/$(env_get ADMIN_USER)/gitea-with-agents
    2. create an issue and comment:  @pi add a README.md with a project overview
    3. watch the task appear at http://127.0.0.1:3001 — the bot pushes,
       a reviewer task runs, and the bot replies with a summary

  $C_INFO CPU plan:$C_RST
    llama.cpp: ${LLAMA_CPUS:-?} of $(nproc) cores (run the router with -t ${LLAMA_CPUS:-?})
    remaining: $(( $(nproc) - ${LLAMA_CPUS:-0} )) for agent jobs (1 concurrent), chat, system

  $C_INFO Notes:$C_RST
    - re-run ./setup.sh anytime — every step is idempotent
    - agent model changes: edit agent-sandbox/{pi,opencode} config files,
      then ./setup.sh --rebuild (bakes the model list into the images)
    - the /pages services track repos from PAGES_SITES in .env (empty by
      default) — add entries there and: docker compose up -d 00-tea
EOF
