#!/usr/bin/env bash
# @purpose The repeatable half of the end-to-end eval (epic #122). Two sections:
#   1. MECHANICAL — things checkable right now from code, workflows and public health endpoints.
#   2. CAPTURE   — analysis of the 10-minute observation log (~/.a2w/eval-capture.sh → JSONL),
#                  which answers the questions that need TIME rather than a look.
# Prints a scorecard. Read-only: never writes a setpoint, never queries production, never touches the Pi.
# Usage: bash scripts/eval-run.sh [capture.jsonl]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CAP="${1:-/tmp/a2w-eval-capture.jsonl}"
PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
ok(){ printf '  ok      %s\n' "$1"; } ; bad(){ printf '  FAIL    %s\n' "$1"; } ; warn(){ printf '  WARN    %s\n' "$1"; } ; info(){ printf '  --      %s\n' "$1"; }

echo "eval-run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo; echo "[1] §6.4 write guardrails present in bridge code (handoff: non-negotiable)"
grep -q '422' heatpump-bridge/bridge/guardrails.py            && ok "1 clamp rejects with 422" || bad "1 clamp"
grep -q 'readback' heatpump-bridge/bridge/poller.py           && ok "2 read-back verify"       || bad "2 read-back"
grep -q '_last_write' heatpump-bridge/bridge/guardrails.py    && ok "3 per-pump rate limit"    || bad "3 rate limit"
grep -q 'FAILED poll' heatpump-bridge/bridge/poller.py        && ok "4 offline watchdog"       || bad "4 watchdog"
grep -q 'setpoint_write' heatpump-bridge/bridge/store.py      && ok "5 write audit log"        || bad "5 audit"
grep -q 'comm_stats' heatpump-bridge/bridge/store.py          && ok "6 comm error stats"       || bad "6 comm stats"

echo; echo "[2] load-bearing defaults (bridge config.py) — the 'never relax' set"
grep -q 'write_enabled: bool = False' heatpump-bridge/bridge/config.py            && ok "write_enabled defaults OFF" || bad "write_enabled default"
grep -q 'restrict_unattended_writes: bool = True' heatpump-bridge/bridge/config.py && ok "restrict_unattended_writes ON" || bad "restrict_unattended_writes"
grep -q 'arm_live: bool = False' heatpump-bridge/bridge/config.py                  && ok "SPAN backup arm defaults SHADOW" || bad "arm_live default"
info "baseline_setpoint_c / unattended_min_setpoint_c are Pi-side runtime values — see [4]"

echo; echo "[3] scheduled jobs actually scheduled"
grep -q 'cron:' .github/workflows/db-backup.yml   && ok "weekly DB backup (Mon 08:17 UTC)" || bad "db-backup schedule"
grep -q 'cron:' .github/workflows/drift-check.yml && ok "daily drift-check (13:23 UTC)"     || bad "drift-check schedule"
grep -q '"0 12 \* \* 1"' analytics-mirror/vercel.json && ok "Monday digest cron"           || bad "digest cron"
last=$(gh run list --workflow=drift-check.yml --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || echo "?")
[ "$last" = "success" ] && ok "drift-check last run green" || warn "drift-check last run: ${last} (red since 2026-09-23 on FINDING-1 — a permanently-red check hides new drift)"

echo; echo "[4] live system (public /health, no token)"
H="$(curl -sf -m 20 "$PLANNER/health" 2>/dev/null)" || H=""
if [ -z "$H" ]; then bad "planner unreachable"; else
  [ "$(jq -r .ok <<<"$H")" = "true" ] && ok "planner ok" || bad "planner not ok"
  [ "$(jq -r '.writer_lease.held' <<<"$H")" = "true" ] && ok "writer lease held" || bad "writer lease NOT held"
  jq -r '.phase_b.lastResults[]' <<<"$H" | grep -q 'NO LEASE ARMED' && bad "FINDING-1: Pi has NO lease — revert-to-baseline cannot fire (#117)" || ok "revert-to-baseline armed"
  [ "$(jq -r '.i1.violated' <<<"$H")" = "false" ] && ok "I1 invariant clean" || bad "I1 VIOLATED: $(jq -r .i1.detail <<<"$H")"
  [ "$(jq -r '.hygiene.last_satisfied' <<<"$H")" = "true" ] && ok "I8 hygiene satisfied ($(jq -r .hygiene.hours_since_dwell <<<"$H")h since dwell)" || bad "I8 hygiene NOT satisfied"
  [ "$(jq -r '.hygiene.blind' <<<"$H")" = "false" ] && ok "hygiene monitor not blind" || warn "hygiene monitor BLIND"
  [ "$(jq -r '.tempiq_read.consecutiveFailures' <<<"$H")" = "0" ] && ok "TempIQ read healthy" || warn "TempIQ read failing"
  [ "$(jq -r '.winter_solver.mode' <<<"$H")" = "shadow" ] && ok "winter solver in shadow (correct pre-cold)" || warn "winter solver mode: $(jq -r .winter_solver.mode <<<"$H")"
  jq -e '.thermal' <<<"$H" >/dev/null 2>&1 && ok "thermal block deployed (Wave 1)" || info "thermal block not yet deployed (#120 unmerged)"
  jq -e '.tz' <<<"$H" >/dev/null 2>&1 && ok "tz reported: $(jq -r .tz.resolved <<<"$H")" || info "tz not yet reported (#120 unmerged) — TZ dependency unverified (#121)"
fi

echo; echo "[5] observation capture — $CAP"
if [ ! -s "$CAP" ]; then warn "no capture yet"; else
  n=$(wc -l < "$CAP" | tr -d ' '); first=$(head -1 "$CAP" | jq -r .ts); lastts=$(tail -1 "$CAP" | jq -r .ts)
  info "$n samples, $first → $lastts"
  unk=$(jq -r 'select(.planner==null)|.ts' "$CAP" | wc -l | tr -d ' '); [ "$unk" = 0 ] && ok "planner reachable every sample" || warn "planner unreachable in $unk samples"
  lu=$(jq -r 'select(.planner!=null and .planner.writer_lease.held!=true)|.ts' "$CAP" | wc -l | tr -d ' '); [ "$lu" = 0 ] && ok "writer lease held in every sample" || warn "lease NOT held in $lu samples: $(jq -r 'select(.planner!=null and .planner.writer_lease.held!=true)|.ts' "$CAP" | head -3 | tr '\n' ' ')"
  pd=$(jq -r 'select(.hub!=null and .hub.pi_connected!=true)|.ts' "$CAP" | wc -l | tr -d ' '); [ "$pd" = 0 ] && ok "Pi connected in every sample" || warn "Pi DISCONNECTED in $pd samples: $(jq -r 'select(.hub!=null and .hub.pi_connected!=true)|.ts' "$CAP" | head -3 | tr '\n' ' ')"
  pf=$(jq -r 'select(.planner!=null)|.planner.phase_b.lastResults[]?' "$CAP" | grep -c failed || true); [ "$pf" = 0 ] && ok "Phase B never reported a failed write" || warn "Phase B reported 'failed' $pf times"
  og=$(jq -r 'select(.outage!=null)|.outage[0].hasActiveOutage' "$CAP" | grep -c true || true); [ "$og" = 0 ] && info "no grid outage observed (OutageWatch still has zero positive examples — #115)" || warn "GRID OUTAGE observed in $og samples — FIRST positive example for #115; preserve storm_events"
  echo "  storm state transitions:"; jq -r 'select(.planner!=null)|"\(.ts) \(.planner.storm.state)/\(.planner.storm.trigger // "-") end=\(.planner.storm.windowEnd // "-")"' "$CAP" | awk '{k=$2" "$3; if(k!=p){print "    "$0; p=k}}'
  nu=$(jq -r 'select(.nws==null)|.ts' "$CAP" | wc -l | tr -d ' '); [ "$nu" = 0 ] || warn "NWS fetch unknown in $nu samples (recorded as null, not as no-alerts)"
  # Samples before 2026-09-26T22:05Z predate the null-vs-[] fix: an [] there is a MASKED fetch
  # failure, not "no alerts". Data is never rewritten; it is flagged so a reader doesn't take the
  # first 'false' below as a real transition.
  pre=$(jq -r 'select(.ts < "2026-09-26T22:05" and .nws==[])|.ts' "$CAP" | wc -l | tr -d ' '); [ "$pre" = 0 ] || warn "$pre pre-fix sample(s) with nws=[] — treat as unknown, not as 'no warning'"
  echo "  NWS High Wind Warning seen:"; jq -r 'select(.nws!=null)|"\(.ts) \([.nws[]?|select(.event=="High Wind Warning")]|length>0)"' "$CAP" | awk '{if($2!=p){print "    "$0; p=$2}}'
fi
