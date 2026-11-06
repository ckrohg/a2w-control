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

# ---- 3. [11]'s readers (#164) on the REAL files, so a PR that drops a watch pattern from either config fails CI here
# rather than surfacing as a redeploy storm (or a missed deploy) after it lands.
for pair in "a2w-planner:planner" "a2w-hub:hub"; do
  svc="${pair%%:*}"; dir="${pair##*:}"; want="$(railway_watch_want "$dir")"
  ck "${svc}: declared set has both spellings" 6 "$(wc -w <<<"$want" | tr -d ' ')"
  ck "${svc}: .railway/railway.ts = declared"  "$want" "$(iac_watch .railway/railway.ts "$svc")"
  [ -f "$dir/railway.toml" ] && ck "${dir}/railway.toml = declared" "$want" "$(toml_watch "$dir/railway.toml")"
done
# a dropped pattern must read as a difference, not as a match
sed 's|\["planner/\*\*", |[|' .railway/railway.ts > "$TMP/dropped.ts"
ck "a dropped planner/** reads as 5 patterns" "package-lock.json package.json railway.toml src/** tsconfig.json" \
   "$(iac_watch "$TMP/dropped.ts" a2w-planner)"
ck "an unknown service reads as empty" "" "$(iac_watch .railway/railway.ts a2w-nonexistent)"

# ---- 4. [5] over a /health fixture carrying backup_gate.generator.feed, the shape generator.ts status() writes
# (toISOString() timestamps with fractional seconds). The dead OutageWatch app made [5] permanently red; it now reads
# the 6bb feed's health from the planner and must go green on a fresh answer and red on each way the feed can be absent.
run_5() { # $1 = feed JSON, or "none" for a planner that predates the feed; prints the [5] lines
  if [ "$1" = none ]; then printf '{"ok":true}' > "$TMP/health"
  else printf '{"ok":true,"backup_gate":{"generator":{"feed":%s}}}' "$1" > "$TMP/health"; fi
  PLANNER_URL="file://$TMP" HUB_URL="file://$TMP/nohub" HUB_CLIENT_TOKEN="" DRIFT_ACK_FILE=/dev/null \
    bash scripts/drift-check.sh 2>/dev/null | awk '/^\[5\]/{on=1} /^\[6\]/{on=0} on'
}
FRESH="$(date -u +%Y-%m-%dT%H:%M:%S).038Z"   # BSD and GNU date; the fraction is what the planner writes
OUT="$(run_5 "{\"supply\":\"grid\",\"why\":\"no outage reported (6bb feed)\",\"assumed\":false,\"last_answer_at\":\"$FRESH\",\"outage_active\":false,\"last_outage_seen_at\":null,\"last_failure\":null}")"
ck "fresh answer: passes with the age"      1 "$(grep -c '6bb outage feed answered 0 min ago' <<<"$OUT")"
ck "fresh answer: prints why"               1 "$(grep -c 'no outage reported (6bb feed)' <<<"$OUT")"
ck "fresh answer: no DRIFT line in [5]"     0 "$(grep -c 'DRIFT' <<<"$OUT")"
OUT="$(run_5 '{"supply":"grid","why":"the outage feed has not answered for 181 min; assuming the grid (no outage seen in the last 6 h)","assumed":true,"last_answer_at":"2026-01-01T00:00:00.000Z","outage_active":false,"last_outage_seen_at":null,"last_failure":null}')"
ck "stale answer (> 2 h): DRIFT with the age" 1 "$(grep -c 'DRIFT.*last answered [0-9][0-9]* min ago (> 120 min)' <<<"$OUT")"
ck "stale answer: says the grid is assumed" 1 "$(grep -c 'the planner is assuming the grid' <<<"$OUT")"
OUT="$(run_5 '{"supply":"unknown","why":"the outage feed has not answered in the 12 min since the planner started","assumed":false,"last_answer_at":null,"outage_active":false,"last_outage_seen_at":null,"last_failure":"unreachable or unreadable"}')"
ck "recorded failure: DRIFT names it"       1 "$(grep -c 'DRIFT.*last poll failed: unreachable or unreadable' <<<"$OUT")"
OUT="$(run_5 "{\"supply\":\"grid\",\"why\":\"no outage reported (6bb feed)\",\"assumed\":false,\"last_answer_at\":\"$FRESH\",\"outage_active\":false,\"last_outage_seen_at\":null,\"last_failure\":\"HTTP 401\"}")"
ck "fresh but failing: still DRIFT"         1 "$(grep -c 'DRIFT.*last poll failed: HTTP 401' <<<"$OUT")"
OUT="$(run_5 '{"supply":"unknown","why":"the outage feed has not answered in the 12 min since the planner started","assumed":false,"last_answer_at":null,"outage_active":false,"last_outage_seen_at":null,"last_failure":null}')"
ck "never answered: DRIFT"                  1 "$(grep -c 'DRIFT.*has not answered since the planner started' <<<"$OUT")"
OUT="$(run_5 none)"
ck "planner predates the feed: DRIFT"       1 "$(grep -c 'DRIFT.*has no backup_gate.generator.feed' <<<"$OUT")"

[ "$fails" = 0 ] && echo "drift-check.test: all passed" || { echo "drift-check.test: FAILURES"; exit 1; }
