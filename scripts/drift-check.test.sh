#!/usr/bin/env bash
# @purpose drift-check [2a] — every phase_b result shape phaseb.ts writes, classified as it should be. The deploy
# handover string ("skipped <T> — writer lease not held / handing over") was reported as "unrecognised … STALE" DRIFT
# on every deploy; it is a known transient state. An unknown string must STILL fail as STALE (the match is not loosened).
#
# Run: bash scripts/drift-check.test.sh     (no network: /health is served from file:// fixtures)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DRIFT_CHECK_LIB_ONLY=1 . scripts/drift-check.sh

fails=0
ck() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"
  else printf '  FAIL %s — expected %q, got %q\n' "$1" "$2" "$3"; fails=1; fi
}

# ---- 1. The classifier, on the exact strings phaseb.ts builds (runOnce + verifyLeases).
ck "armed (verified)"        armed     "$(phaseb_result_class 'ok 61°C (lease 87m armed)')"
ck "armed, half degree"      armed     "$(phaseb_result_class 'ok 61.5°C (lease 0m armed)')"
ck "no lease (FINDING-1)"    nolease   "$(phaseb_result_class 'ok 61°C — ⚠ NO LEASE ARMED')"
ck "requested (unverified)"  requested "$(phaseb_result_class 'ok 61°C (lease 90m requested)')"
ck "write failed"            failed    "$(phaseb_result_class 'failed: Pi not connected')"
ck "deploy handover"         handover  "$(phaseb_result_class 'skipped 61°C — writer lease not held / handing over')"
ck "dry-run"                 dryrun    "$(phaseb_result_class 'DRY-RUN would send 61°C — tracking HBX target 140°F')"
# NOT loosened: near-misses of the known shapes are still STALE
ck "unknown string is STALE"           STALE "$(phaseb_result_class 'skipped 61°C — something new')"
ck "handover with a changed tail"      STALE "$(phaseb_result_class 'skipped 61°C — writer lease not held')"
ck "a bare 'armed)' is not enough"     STALE "$(phaseb_result_class 'whatever armed)')"
ck "empty is STALE"                    STALE "$(phaseb_result_class '')"

# ---- 2. End to end: [2a] over a /health fixture captured from a deploy handover (the old instance's view).
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
run_2a() { # $1 = lastResults JSON; prints the [2a] lines (the rest of the script sees no hub and no token)
  printf '{"ok":true,"phase_b":{"mode":"active","lastResults":%s}}' "$1" > "$TMP/health"
  PLANNER_URL="file://$TMP" HUB_URL="file://$TMP/nohub" HUB_CLIENT_TOKEN="" DRIFT_ACK_FILE=/dev/null \
    bash scripts/drift-check.sh 2>/dev/null | awk '/^\[2\]/{on=1} /corroboration skipped/{on=0} on'
}
OUT="$(run_2a '{"pump1":"skipped 61°C — writer lease not held / handing over","pump2":"skipped 61°C — writer lease not held / handing over"}')"
ck "handover: no DRIFT line in [2]"    0 "$(grep -c 'DRIFT' <<<"$OUT")"
ck "handover: no STALE line in [2]"    0 "$(grep -c 'STALE' <<<"$OUT")"
ck "handover: both pumps noted"        2 "$(grep -c 'deploy handover' <<<"$OUT")"
OUT="$(run_2a '{"pump1":"ok 61°C (lease 88m armed)","pump2":"skipped 61°C — a new state nobody taught me"}')"
ck "mixed: the armed pump passes"      1 "$(grep -c 'Pi confirmed a live lease' <<<"$OUT")"
ck "mixed: the unknown one is STALE"   1 "$(grep -c 'pump2: unrecognised phase_b result' <<<"$OUT")"
OUT="$(run_2a '{"pump1":"ok 61°C — ⚠ NO LEASE ARMED"}')"
ck "no lease is still DRIFT"           1 "$(grep -c 'DRIFT.*armed NO lease' <<<"$OUT")"

[ "$fails" = 0 ] && echo "drift-check.test: all passed" || { echo "drift-check.test: FAILURES"; exit 1; }
