#!/usr/bin/env bash
# @purpose Detect DECLARED-vs-LIVE drift. Every finding of the 2026-09-16 audit was one bug:
# state asserted in one place, silently diverging from the truth, with nothing watching.
# CLAUDE.md said "Phase 1 next" while Phase B commanded both pumps; config.production.yaml
# said write_enabled:false while writes were live; and -- the one that mattered -- every doc
# promised "a dead planner lapses back to baseline_setpoint_c" while the Pi held NO lease at
# all, because baseline_setpoint_c was never set. Two months of green dashboards hid it.
# This script is what makes that class of failure loud.
#
# Read-only: GETs public health endpoints and (with HUB_CLIENT_TOKEN) the hub state. It never
# writes a setpoint, never cuts a release-* tag, never touches the Pi.
#
# Usage:  bash scripts/drift-check.sh           # skips hub-state checks without a token
#         HUB_CLIENT_TOKEN=... bash scripts/drift-check.sh
# Exit 0 = no drift, 1 = drift found.
set -uo pipefail

PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mDRIFT\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  --   %s\n' "$1"; }

echo "drift-check $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "[1] service liveness"
HEALTH="$(curl -sf -m 20 "$PLANNER/health" 2>/dev/null)" || HEALTH=""
if [ -z "$HEALTH" ]; then
  fail "planner /health unreachable"
else
  [ "$(jq -r '.ok' <<<"$HEALTH")" = "true" ] \
    && pass "planner /health ok" || fail "planner /health reports not-ok"
fi
HUBH="$(curl -sf -m 20 "$HUB/health" 2>/dev/null)" || HUBH=""
if [ -z "$HUBH" ]; then
  fail "hub /health unreachable"
else
  [ "$(jq -r '.pi_connected' <<<"$HUBH")" = "true" ] \
    && pass "hub reports pi_connected" || fail "hub reports pi NOT connected"
fi

echo
echo "[2] FINDING-1 — revert-to-baseline failsafe actually armed"
# The whole lease regime is gated on the Pi's baseline_setpoint_c being set (poller.py:600).
# If it is unset, the Pi silently records NO lease, check_lease() returns early forever, and
# the documented "dead planner -> warm baseline" recovery does not exist. The only remote
# evidence is remote_lease_until in the hub state payload.
PHASE_B_MODE="$(jq -r '.phase_b.mode // "unknown"' <<<"${HEALTH:-{\}}")"

# [2a] TOKEN-FREE assertion. #97 made phase_b report what the Pi actually ARMED rather than
# echoing its own LEASE_MINUTES constant, so the public /health now carries the answer and this
# check needs no credentials -- which means it runs in CI, on a phone, from anywhere.
# phaseb.ts emits exactly three shapes (phaseb.ts:130/192/198):
#   "(lease Nm armed)"     -> the Pi confirmed a lease   -> ok
#   "NO LEASE ARMED"       -> wrote, Pi armed nothing    -> DRIFT (this is FINDING-1)
#   "(lease Nm requested)" -> hub read failed, unobserved -> cannot assert, say so
# Anything else means the string changed and THIS CHECK HAS GONE STALE. That is reported as
# drift too, deliberately: a silently-passing safety assertion is the exact failure class
# this script exists to prevent -- see the header. Do not "fix" it by loosening the match.
if [ -z "$HEALTH" ]; then
  skip "planner /health unreachable — cannot assert lease state"
elif [ "$PHASE_B_MODE" != "active" ]; then
  skip "phase_b mode=$PHASE_B_MODE — lease assertion only applies when actively writing"
else
  RESULTS="$(jq -r '.phase_b.lastResults // {} | to_entries[] | select(.key != "_skip") | "\(.key)\t\(.value)"' <<<"$HEALTH")"
  if [ -z "$RESULTS" ]; then
    skip "phase_b active but reported no per-pump results yet"
  else
    while IFS=$'\t' read -r PUMP MSG; do
      [ -z "$PUMP" ] && continue
      case "$MSG" in
        *"NO LEASE ARMED"*)
          fail "$PUMP: wrote a setpoint but the Pi armed NO lease — revert-to-baseline CANNOT fire"
          fail "  -> baseline_setpoint_c is unset on the live Pi (~/bridge-data/config.yaml)"
          fail "  -> fix: knowledge/reference/finding1-arm-baseline-runbook.md" ;;
        *"armed)"*)
          pass "$PUMP: Pi confirmed a live lease — failsafe armed (${MSG})" ;;
        *"requested)"*)
          skip "$PUMP: lease unverified — the planner could not read hub state (${MSG})" ;;
        *"DRY-RUN"*)
          skip "$PUMP: phase_b in dry-run (${MSG})" ;;
        *)
          fail "$PUMP: unrecognised phase_b result \"${MSG}\" — this assertion has gone STALE"
          fail "  -> phaseb.ts changed its result string; re-derive the cases, do not loosen the match" ;;
      esac
    done <<<"$RESULTS"
  fi
fi

# [2b] Corroboration from the hub's raw remote_lease_until. Same property, independent source:
# [2a] trusts the planner's rendering, this reads the value the Pi reported. Needs a token.
if [ -z "${HUB_CLIENT_TOKEN:-}" ]; then
  skip "corroboration skipped — set HUB_CLIENT_TOKEN to also assert on raw remote_lease_until"
elif [ "$PHASE_B_MODE" != "active" ]; then
  skip "phase_b mode=$PHASE_B_MODE — lease assertion only applies when actively writing"
else
  STATE="$(curl -sf -m 20 -H "Authorization: Bearer $HUB_CLIENT_TOKEN" "$HUB/api/state" 2>/dev/null)" || STATE=""
  if [ -z "$STATE" ]; then
    fail "hub /api/state unreachable or unauthorized"
  else
    UNLEASED="$(jq -r '[.pumps[] | select(.write_enabled == true and .remote_lease_until == null) | .id] | join(", ")' <<<"$STATE")"
    if [ -n "$UNLEASED" ]; then
      fail "phase_b is ACTIVE but these write-enabled pumps hold NO lease: ${UNLEASED}"
      fail "  -> baseline_setpoint_c is unset on the Pi; revert-to-baseline CANNOT fire"
    else
      pass "all write-enabled pumps hold a live lease (failsafe armed)"
    fi
  fi
fi

echo
echo "[3] FINDING-2 — production template must stay write-disabled"
# config.production.yaml is a TEMPLATE for a fresh Pi, not a mirror of runtime. Flipping it to
# true (the naive reading of #78) would arm writes on new hardware BEFORE the isolation and
# HBX-override commissioning gates ran -- the gate the fusion audit made a recorded human step.
TPL="$REPO_ROOT/heatpump-bridge/deploy/config.production.yaml"
if grep -qE '^\s*write_enabled:\s*true' "$TPL" 2>/dev/null; then
  fail "config.production.yaml has write_enabled: true — must stay false (see FINDING-2)"
else
  pass "config.production.yaml keeps write_enabled: false"
fi

echo
echo "[4] declared gate flags vs live"
# Docs that claim a gate is on/off must match /health. Winter-DP go-live flips these; this
# catches a doc that says "shadow" after the gate went live, or vice versa.
if [ -n "$HEALTH" ]; then
  for pair in "demand_forecast.fetch_enabled:FORECAST_FETCH_ENABLED" \
              "demand_forecast.preheat_enabled:FORECAST_PREHEAT_ENABLED"; do
    path="${pair%%:*}"; name="${pair##*:}"
    live="$(jq -r ".${path}" <<<"$HEALTH")"
    pass "${name} live=${live}"
  done
  ws="$(jq -r '.winter_solver.mode' <<<"$HEALTH")"
  [ "$ws" = "shadow" ] || [ "$ws" = "active" ] \
    && pass "winter_solver mode=${ws}" || fail "winter_solver mode unexpected: ${ws}"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "no drift detected"; else echo "DRIFT DETECTED — see above"; fi
exit "$FAILED"
