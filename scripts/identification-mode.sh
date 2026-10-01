#!/usr/bin/env bash
# @purpose Read or set the identification driver's mode on the LIVE planner (off | shadow | armed) without the
# dashboard: POST /api/identification with the planner's bearer token, which this script reads from the Railway
# service variables and never prints. The planner records the change in controller_flags and pages ntfy ("high"
# when arming). Wave plan 2026-10-01 node C1.
#   scripts/identification-mode.sh            # show the current mode + driver status
#   scripts/identification-mode.sh armed      # arm (first cold band draws probes)
#   scripts/identification-mode.sh shadow     # back to shadow (decide + log, write nothing)
# Env: PLANNER_URL (default production), RAILWAY_SERVICE (default a2w-planner).
set -euo pipefail
PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
SERVICE="${RAILWAY_SERVICE:-a2w-planner}"
MODE="${1:-}"
case "$MODE" in ""|off|shadow|armed) ;; *) echo "usage: $0 [off|shadow|armed]" >&2; exit 2 ;; esac
TOKEN="$(railway variables --service "$SERVICE" --kv 2>/dev/null | grep '^PLANNER_API_TOKEN=' | cut -d= -f2- || true)"
[ -n "$TOKEN" ] || { echo "could not read PLANNER_API_TOKEN from Railway (is the CLI linked to the a2w project?)" >&2; exit 1; }
if [ -z "$MODE" ]; then
  curl -sf -m 20 -H "Authorization: Bearer $TOKEN" "$PLANNER/api/identification"
  echo
  exit 0
fi
echo "before: $(curl -sf -m 20 -H "Authorization: Bearer $TOKEN" "$PLANNER/api/identification" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("mode"))')"
curl -sf -m 20 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"mode\":\"$MODE\"}" "$PLANNER/api/identification"
echo
echo "after:  $(curl -sf -m 20 "$PLANNER/health" | python3 -c 'import sys,json; d=json.load(sys.stdin); i=d.get("identification") or {}; print(i.get("mode"), "|", i.get("lastResult"))')"
