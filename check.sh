#!/usr/bin/env bash
#
# check.sh — development gate: fast static checks over the whole repo.
# Run locally before committing/pushing and on every PR
# (.gitea/workflows/check.yaml). Catches the boring stuff that would
# otherwise surface at runtime — e.g. the setup.sh syntax error (a stray
# `)` on line 377) that survived until the wizard ran it in production.
#
# Checks (tool missing → skip with a note; present → must pass):
#   bash -n          every tracked .sh
#   shellcheck       every tracked .sh, parser-level errors only
#   node --check     every tracked .mjs
#   jq empty         every tracked .json / .json.example
#   docker compose   docker-compose.yml config validity (no daemon needed)
#
set -euo pipefail
cd "$(dirname "$0")"

FAIL=0
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*" >&2; FAIL=1; }
skip() { printf '  - %s: not installed, skipped\n' "$*"; }

# 1. shell syntax — the check that would have caught the setup.sh crash
n=0
while IFS= read -r f; do
  n=$((n + 1))
  if err=$(bash -n "$f" 2>&1); then :; else bad "bash -n $f — $err"; fi
done < <(git ls-files '*.sh')
if [[ $n > 0 && $FAIL == 0 ]]; then ok "bash -n: $n shell script(s)"; fi

# 2. shellcheck — parser-level errors only (style findings are advisory;
#    the repo predates a shellcheck baseline)
if command -v shellcheck >/dev/null 2>&1; then
  while IFS= read -r f; do
    if ! out=$(shellcheck -s bash -x --severity=error "$f" 2>&1); then
      bad "shellcheck $f"; printf '%s\n' "$out" | sed 's/^/    /'
    fi
  done < <(git ls-files '*.sh')
  if [[ $FAIL == 0 ]]; then ok "shellcheck (severity=error): clean"; fi
else
  skip "shellcheck (apt install shellcheck)"
fi

# 3. node syntax — 2pizzas modules, filters, TUI
n=0
while IFS= read -r f; do
  n=$((n + 1))
  if ! out=$(node --check "$f" 2>&1); then bad "node --check $f — $out"; fi
done < <(git ls-files '*.mjs')
if [[ $n > 0 && $FAIL == 0 ]]; then ok "node --check: $n module(s)"; fi

# 4. JSON validity — config + .example templates (a broken
#    models.json.example only surfaces at the next image build)
n=0
while IFS= read -r f; do
  n=$((n + 1))
  if ! out=$(jq empty "$f" 2>&1); then bad "jq $f — $out"; fi
done < <(git ls-files '*.json' '*.json.example')
if [[ $n > 0 && $FAIL == 0 ]]; then ok "jq: $n json file(s)"; fi

# 5. compose config validity — pure config expansion, no daemon contact
if command -v docker >/dev/null 2>&1; then
  if ! out=$(docker compose config -q 2>&1); then
    bad "docker compose config — $out"
  else
    ok "docker compose config"
  fi
else
  skip "docker (compose config check)"
fi

if [[ $FAIL != 0 ]]; then
  echo "" >&2
  echo "check.sh: FAILURES — fix the ✗ lines above" >&2
  exit 1
fi
echo ""
echo "check.sh: all checks passed"
