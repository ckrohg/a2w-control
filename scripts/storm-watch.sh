#!/usr/bin/env bash
# @purpose Read-only watch for the 2026-09-26/27 High Wind Warning. Polls the planner, the hub and
# OutageWatch and shouts only when something CHANGES, so a quiet storm produces a quiet log. Covers
# the one gap #116 identifies: nothing watches writer_lease, so a planner that is up, healthy and
# silently not commanding setpoints looks fine everywhere else.
#
# Read-only by construction: GETs public health endpoints. Never writes a setpoint, never queries the
# production database (CLAUDE.md), never cuts a release-* tag.
#
# Usage:  bash scripts/storm-watch.sh            # one pass, prints a line, exit 0
#         WATCH_LOOP=1 INTERVAL=300 bash scripts/storm-watch.sh   # poll until killed
# Log:    ${LOG:-/tmp/a2w-storm-watch.log}
set -uo pipefail

PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
OUTAGE="${OUTAGEWATCH_URL:-https://victorious-light-production.up.railway.app}"
LOG="${LOG:-/tmp/a2w-storm-watch.log}"
STATE="${STATE:-/tmp/a2w-storm-watch.state}"

one_pass() {
  local ts ph hubh ow lease pi storm trig wend pb outage alerts line prev
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ph="$(curl -sf -m 20 "$PLANNER/health" 2>/dev/null)" || ph=""
  hubh="$(curl -sf -m 20 "$HUB/health" 2>/dev/null)" || hubh=""
  ow="$(curl -sf -m 15 "$OUTAGE/api/status" 2>/dev/null)" || ow=""

  if [ -z "$ph" ]; then
    lease="UNREACHABLE"; storm="?"; trig="?"; wend="?"; pb="?"
  else
    lease="$(jq -r '.writer_lease.held // "?"' <<<"$ph")"
    storm="$(jq -r '.storm.state // "?"' <<<"$ph")"
    trig="$(jq -r '.storm.trigger // "-"' <<<"$ph")"
    wend="$(jq -r '.storm.windowEnd // "-"' <<<"$ph")"
    pb="$(jq -r '[.phase_b.lastResults // {} | to_entries[] | .value] | join(" / ")' <<<"$ph")"
  fi
  pi="$(jq -r '.pi_connected // "?"' <<<"${hubh:-{\}}" 2>/dev/null || echo '?')"
  outage="$(jq -r '[.[].hasActiveOutage] | any' <<<"${ow:-[]}" 2>/dev/null || echo '?')"
  # NWS: are the arm-tier warnings still up?
  alerts="$(curl -sf -m 20 -H 'User-Agent: a2w-storm-watch (ckrohg@me.com)' \
    "https://api.weather.gov/alerts/active?point=42.63,-70.87" 2>/dev/null \
    | jq -r '[.features[].properties.event] | map(select(test("Warning"))) | unique | join(",")' 2>/dev/null)" || alerts="?"

  line="lease=$lease pi=$pi storm=$storm/$trig end=$wend outage=$outage nws=[${alerts:-none}]"
  printf '%s  %s\n' "$ts" "$line" >> "$LOG"

  # Only shout on a change, or on any of the four conditions that actually matter.
  prev="$(cat "$STATE" 2>/dev/null || true)"
  if [ "$line" != "$prev" ]; then
    printf '%s  CHANGED  %s\n' "$ts" "$line" | tee -a "$LOG"
    printf '%s' "$line" > "$STATE"
  fi
  [ "$lease" = "false" ]     && printf '%s  *** WRITER LEASE NOT HELD — planner may be up but not commanding (#116) ***\n' "$ts" | tee -a "$LOG"
  [ "$lease" = "UNREACHABLE" ] && printf '%s  *** PLANNER UNREACHABLE ***\n' "$ts" | tee -a "$LOG"
  [ "$pi" = "false" ]        && printf '%s  *** PI DISCONNECTED — setpoints frozen, and FINDING-1 means no revert (#117) ***\n' "$ts" | tee -a "$LOG"
  [ "$outage" = "true" ]     && printf '%s  *** GRID OUTAGE — first positive example for #115 calibration; capture storm_events ***\n' "$ts" | tee -a "$LOG"
  return 0
}

if [ "${WATCH_LOOP:-0}" = "1" ]; then
  echo "storm-watch: polling every ${INTERVAL:-300}s → $LOG"
  while :; do one_pass; sleep "${INTERVAL:-300}"; done
else
  one_pass; tail -1 "$LOG"
fi
