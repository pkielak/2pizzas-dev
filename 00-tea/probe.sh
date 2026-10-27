#!/usr/bin/env bash
# probe.sh — test an inference backend FROM 00-tea's container vantage, i.e.
# the exact network position of the code that actually calls the backend.
#
# This is the diagnostic for the #1 inference misconfiguration: a backend
# bound to the host's 127.0.0.1/localhost is INVISIBLE to every container
# (127.0.0.1 inside a container is that container's own loopback). A backend
# must be bound to a ROUTABLE host IP (tailscale/LAN) to be reachable.
# Running this on the host would always "work" for a loopback url — the whole
# point is to probe from the container, which is why it goes through the
# 00-tea API rather than curling the url directly.
#
#   ./00-tea/probe.sh [URL] [API_KEY]
#   ./00-tea/probe.sh http://127.0.0.1:8080
#   ./00-tea/probe.sh https://openrouter.ai/api sk-...
set -euo pipefail

URL=${1:-http://127.0.0.1:8080}
KEY=${2:-}
BASE=${UI_BASE:-http://127.0.0.1:3001}
# the /api is UI-token-gated; pick up the token from an env var or .env
TOKEN=${UI_TOKEN:-}
if [[ -z $TOKEN && -f .env ]]; then TOKEN=$(grep -E '^UI_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- || true); fi

resp=$(curl -sf --max-time 15 -X POST "$BASE/api/backends/test" \
  ${TOKEN:+-H "x-ui-token: $TOKEN"} \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg u "$URL" --arg k "$KEY" '{url:$u, apiKey:$k}')")

jq -r '
  if .ok
  then "OK  \(.ms)ms · \(.count) model(s): \(.models | join(", "))"
  else "NOT reachable from 00-tea: \(.error)\n\(.hint // "")"
  end' <<<"$resp"
