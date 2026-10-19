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
ACKED=0; ACKED_BY=""
# Acknowledged drift: dated, issue-linked regexes in scripts/drift-ack.txt (see that file's header).
# DRIFT_ACK_FILE=/dev/null disables acks (then this script behaves exactly as before);
# DRIFT_ACK_TODAY=YYYY-MM-DD overrides "today" so expiry can be tested.
ACK_FILE="${DRIFT_ACK_FILE:-$(dirname "${BASH_SOURCE[0]}")/drift-ack.txt}"
TODAY="${DRIFT_ACK_TODAY:-$(date -u +%Y-%m-%d)}"
# prints "<issue> <expires>" if $1 matches a LIVE ack, "EXPIRED <issue> <expires>" if it matches
# only an expired one, nothing otherwise.
ack_match() {
  local msg="$1" exp iss rx hit=""
  [ -r "$ACK_FILE" ] || return 0
  while read -r exp iss rx; do
    case "$exp" in ''|\#*) continue;; esac
    if printf '%s' "$msg" | grep -Eq -- "$rx"; then
      if [[ "$TODAY" < "$exp" || "$TODAY" == "$exp" ]]; then printf '%s %s' "$iss" "$exp"; return 0; fi
      hit="EXPIRED $iss $exp"
    fi
  done < "$ACK_FILE"
  [ -n "$hit" ] && printf '%s' "$hit"; return 0
}

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() {
  local a; a="$(ack_match "$1")"
  case "$a" in
    EXPIRED*) printf '  \033[31mDRIFT\033[0m %s\n' "$1"
              printf '  \033[31mDRIFT\033[0m   ^ ack for %s EXPIRED %s — renew it in drift-ack.txt or fix it\n' "$(cut -d" " -f2 <<<"$a")" "$(cut -d" " -f3 <<<"$a")"
              FAILED=1 ;;
    "")       printf '  \033[31mDRIFT\033[0m %s\n' "$1"; FAILED=1 ;;
    *)        printf "  \033[33mACK'D\033[0m %s   \033[33m(%s until %s)\033[0m\n" "$1" "${a%% *}" "${a##* }"
              ACKED=$((ACKED+1)); [[ "$ACKED_BY" == *"${a%% *}"* ]] || ACKED_BY="${ACKED_BY:+$ACKED_BY, }${a%% *} until ${a##* }" ;;
  esac
}
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
echo "[2c] #121 — the TZ the storm + DHW windows depend on"
if [ -z "$HEALTH" ]; then
  skip "planner unreachable — cannot assert TZ"
else
  TZ_RESOLVED="$(jq -r '.tz.resolved // empty' <<<"$HEALTH")"
  TZ_ENV="$(jq -r '.tz.env // empty' <<<"$HEALTH")"
  if [ -z "$TZ_RESOLVED" ]; then
    skip "planner predates the tz field (#121) — redeploy to assert it"
  elif [ "$TZ_RESOLVED" = "America/New_York" ]; then
    pass "planner TZ is America/New_York (env=${TZ_ENV:-unset})"
  else
    fail "planner TZ is '$TZ_RESOLVED', not America/New_York (env=${TZ_ENV:-unset})"
    fail "  -> shadow.ts:120 getHours() is NOT local; DHW windows are shifted"
    fail "  -> storm.ts parses OpenMeteo naive timestamps wrong; every storm window is shifted"
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
echo "[5] storm-mode inputs — OutageWatch (eval 2026-10-18 F4)"
# storm.ts treats an unreachable OutageWatch as "no signal", never as an outage -- correct, and also
# why nobody noticed it had been CRASHED since 2026-03-15: a fail-soft input that is permanently
# absent is drift the system cannot see about itself. The grid-outage trigger (#115: zero positive
# examples) has had no source all year.
OW="${OUTAGEWATCH_URL:-https://victorious-light-production.up.railway.app}"
OW_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$OW/api/status" 2>/dev/null || echo 000)"
if [ "$OW_CODE" = "200" ]; then
  pass "OutageWatch /api/status answers 200"
else
  fail "OutageWatch /api/status answers HTTP ${OW_CODE} — storm mode has no grid-outage input (#175 N5)"
fi

echo
echo "[6] Pi link — hub dropout episodes (eval 2026-10-18 F1; the field lands with #166)"
# Five 2-3 h dropouts in four days, Oct 14-17; 14 % of Phase B writes failed. The hub counts
# episodes once #166 deploys; until then this section says so instead of passing vacuously.
if [ -z "$HUBH" ]; then
  skip "hub unreachable — cannot assert dropouts"
else
  DROPS="$(jq -r '.pi_dropouts_24h // empty' <<<"$HUBH")"
  LONGEST="$(jq -r '.longest_dropout_min // "?"' <<<"$HUBH")"
  if [ -z "$DROPS" ]; then
    skip "hub predates pi_dropouts_24h (#166) — redeploy the hub to assert it"
  elif [ "$DROPS" -le 1 ] 2>/dev/null; then
    pass "hub saw ${DROPS} Pi dropout(s) in 24 h (longest ${LONGEST} min)"
  else
    fail "hub saw ${DROPS} Pi dropouts in 24 h (longest ${LONGEST} min) — the Pi link is not winter-grade (#165, #76)"
  fi
fi

echo
echo "[7] declared posture vs live — identification + shaped curve (wave 2026-10-18)"
# Owner intent since 2026-10-01: identification ARMED (first draws 2026-10-17/18) and SHAPED_CURVE=1
# (2026-09-30). A quiet flip of either is drift; a deliberate pause gets a dated ack, not silence.
# in_force.shaped is reported, not asserted: an excursion hour (soak / bank / pre-boost / storm)
# legitimately writes a flat target on top of the curve, so a false here at 13:23Z can be normal.
if [ -n "$HEALTH" ]; then
  IDM="$(jq -r '.identification.mode // "absent"' <<<"$HEALTH")"
  if [ "$IDM" = "armed" ]; then
    pass "identification mode=armed"
  else
    fail "identification mode=${IDM} — owner intent is armed; ack with a date in drift-ack.txt if paused deliberately"
  fi
  CM="$(jq -r '.curve.mode // "absent"' <<<"$HEALTH")"
  # NOT `// "absent"`: jq's // treats a boolean false as missing, which would report a real
  # false as "absent". Test for null explicitly.
  CS="$(jq -r 'if .curve.in_force.shaped == null then "absent" else (.curve.in_force.shaped|tostring) end' <<<"$HEALTH")"
  if [ "$CM" = "shaped" ]; then
    pass "shaped curve mode=shaped (in_force.shaped=${CS}$([ "$CS" = "true" ] || echo ' — excursion hour, or the curve was overwritten'))"
  else
    fail "curve mode=${CM} — SHAPED_CURVE=1 since 2026-09-30 (#133); a flat fallback is the #133 risk again"
  fi
fi

echo "[8] SPAN local stream — the path every SPAN safety action depends on (#187, incident 2026-10-16 F5)"
# The Pi's LAN poller (span_local.py) lands span_readings in the mirror every ~25 s; the planner reports the newest
# sample's age at /health.span. The cloud path failing alone is reported there but is not drift.
if [ -n "$HEALTH" ]; then
  # the CURRENT age: /health.span is computed each loop tick and served from memory — add the time since computed_at,
  # and refuse a failed or stale computation outright (a frozen healthy result must not pass forever)
  SPANAGE="$(jq -r 'if .span.local_last_reading_age_s == null or .span.computed_at == null then empty
                    else (.span.local_last_reading_age_s + (now - (.span.computed_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601))) | floor end' <<<"$HEALTH")"
  SPANCOMPUTED_AGO="$(jq -r 'if .span.computed_at == null then empty else (now - (.span.computed_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) | floor end' <<<"$HEALTH")"
  SPANERR="$(jq -r '.span.refresh_error // empty' <<<"$HEALTH")"
  SPANTABLE="$(jq -r 'if .span.local_table == null then "absent" else (.span.local_table|tostring) end' <<<"$HEALTH")"
  CLOUDSTREAK="$(jq -r '.span.cloud.fail_streak // 0' <<<"$HEALTH")"
  if [ "$(jq -r '.span.pending // false' <<<"$HEALTH")" = "true" ]; then
    skip "planner just started — /health.span not computed yet"
  elif [ -n "$SPANERR" ] || { [ -n "$SPANCOMPUTED_AGO" ] && [ "$SPANCOMPUTED_AGO" -gt 900 ]; }; then
    fail "/health.span is not being refreshed (computed ${SPANCOMPUTED_AGO:-?}s ago${SPANERR:+; error: $SPANERR}) — the SPAN-local check itself is failing"
  elif [ "$SPANTABLE" = "absent" ]; then
    skip "planner predates /health.span (#187), or span_readings is absent — redeploy the planner to assert it"
  elif [ -z "$SPANAGE" ]; then
    fail "no SPAN local samples in span_readings (table=${SPANTABLE}) — the local path is not reporting"
  elif [ "${SPANAGE%.*}" -le 900 ]; then
    pass "SPAN local stream ${SPANAGE}s old (≤ 900 s)$([ "$CLOUDSTREAK" -gt 0 ] && echo "; cloud path failing ${CLOUDSTREAK}× (reported, not drift)")"
  else
    fail "SPAN local stream ${SPANAGE}s old (> 900 s) — the Pi's LAN poller is not landing span_readings (#187)"
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  if [ "$ACKED" -gt 0 ]; then echo "no NEW drift ($ACKED acknowledged: $ACKED_BY)"; else echo "no drift detected"; fi
else
  echo "NEW DRIFT DETECTED — see above$([ "$ACKED" -gt 0 ] && echo " ($ACKED acknowledged lines excluded)")"
fi
exit "$FAILED"
