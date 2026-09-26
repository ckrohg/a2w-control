#!/usr/bin/env bash
# @purpose Fire the storm pre-charge unattended: arm storm mode for a clean window, then boost the
# buffer to strictCapF so the heat lands BEFORE onset. Written for the 2026-09-26/27 High Wind
# Warning (onset Sat 12:00 EDT), to run ~10:30 EDT — the owner's "only an hour or two before."
#
# Sizing is from knowledge/reference/storm-precharge-economics.md: 135 °F buys ~12.8 h of coast above
# the 120 °F DHW floor and ~1.6 showers for ~$0.39, at an 8 % COP penalty. 135 is strictCapF, so this
# stays inside every existing write envelope — boost() is capped there and rejects anything higher.
#
# FAIL-SAFE BY DESIGN: it refuses to act on an unhealthy system rather than pushing heat into one.
# A boost also self-expires after MINUTES, so the worst case of it firing wrongly is ~2 h of a warmer
# tank, not a stuck setpoint.
#
# Needs PLANNER_API_TOKEN (env, or one line in $TOKEN_FILE). The token is never logged.
#
# Usage:  DRY_RUN=1 bash scripts/storm-precharge.sh     # validate everything, POST nothing
#         bash scripts/storm-precharge.sh               # for real
set -uo pipefail

PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.a2w-planner-token}"
TOKEN="${PLANNER_API_TOKEN:-$( [ -f "$TOKEN_FILE" ] && tr -d '[:space:]' < "$TOKEN_FILE" )}"
TARGET_F="${TARGET_F:-135}"
MINUTES="${MINUTES:-120}"
ARM_HOURS="${ARM_HOURS:-24}"
DRY_RUN="${DRY_RUN:-0}"
LOG="${LOG:-/tmp/a2w-storm-precharge.log}"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

log "=== storm-precharge start (target=${TARGET_F}F minutes=${MINUTES} arm=${ARM_HOURS}h dry=${DRY_RUN}) ==="

if [ -z "${TOKEN:-}" ]; then
  log "ABORT: no PLANNER_API_TOKEN. Put it in $TOKEN_FILE (chmod 600) or export it."
  log "       Nothing was sent. This is the ONE thing the script cannot supply itself."
  exit 3
fi

# --- Gate: never push heat into a system that is already unhealthy ---
PH="$(curl -sf -m 20 "$PLANNER/health" 2>/dev/null)" || PH=""
if [ -z "$PH" ]; then log "ABORT: planner /health unreachable — did nothing."; exit 4; fi
OK="$(jq -r '.ok' <<<"$PH")"; LEASE="$(jq -r '.writer_lease.held' <<<"$PH")"
HUBH="$(curl -sf -m 20 "$HUB/health" 2>/dev/null)" || HUBH=""
PI="$(jq -r '.pi_connected // "?"' <<<"${HUBH:-{\}}" 2>/dev/null || echo '?')"
log "pre-state: ok=$OK writer_lease=$LEASE pi_connected=$PI storm=$(jq -r '.storm.state' <<<"$PH")"

if [ "$OK" != "true" ];    then log "ABORT: planner reports not-ok."; exit 4; fi
if [ "$LEASE" != "true" ]; then log "ABORT: writer lease not held — planner is not commanding setpoints, so a boost would not stick."; exit 4; fi
if [ "$PI" != "true" ];    then log "ABORT: Pi not connected — no path to the pumps."; exit 4; fi

post() { # $1=path $2=json
  if [ "$DRY_RUN" = "1" ]; then log "DRY: would POST $1 $2"; return 0; fi
  local out; out="$(curl -s -m 25 -X POST "$PLANNER$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2" 2>&1)"
  log "POST $1 -> ${out:0:280}"
}

# Arm first: storm shaping only ever RAISES, so it composes with the boost instead of fighting it.
# A manual window is never re-timed by the forecast, which is the point — one clean window instead of
# the stand-down/re-arm churn the live (unpatched) machine would produce overnight (#119).
post "/api/storm/arm" "{\"hours\": $ARM_HOURS}"
post "/api/hbx/boost" "{\"target_f\": $TARGET_F, \"minutes\": $MINUTES}"

if [ "$DRY_RUN" = "1" ]; then log "=== dry run complete, nothing sent ==="; exit 0; fi

sleep 45
PH2="$(curl -sf -m 20 "$PLANNER/health" 2>/dev/null)" || PH2=""
if [ -n "$PH2" ]; then
  S2="$(jq -r '.storm.state' <<<"$PH2")"
  T2="$(jq -r '.storm.trigger // "-"' <<<"$PH2")"
  E2="$(jq -r '.storm.windowEnd // "-"' <<<"$PH2")"
  log "post-state: storm=$S2/$T2 windowEnd=$E2"
  [ "$T2" = "manual" ] && log "OK: manual window in force — the forecast will not re-time it." \
                       || log "WARN: trigger is '$T2', not 'manual' — the arm may not have taken."
else
  log "WARN: could not re-read /health to verify. Check the Control page."
fi
log "NOTE: boost self-expires after ${MINUTES} min; the banked heat then coasts. Verify the tank on the Control page."
log "=== storm-precharge done ==="
