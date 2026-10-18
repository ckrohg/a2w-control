#!/usr/bin/env bash
# @purpose Observation capture for the end-to-end eval (epic #122). One JSONL line per pass with the
# FULL planner /health, hub /health, OutageWatch status and active NWS alerts, so time-dependent
# questions -- did storm mode stand down when the warning ended? was the writer lease ever dropped?
# did Phase B ever fail? -- are answered from data captured while nobody was watching, not from
# memory. Complements storm-watch.sh (which shouts on change); this records everything, always.
#
# Read-only by construction: public health endpoints only. The hub serves its IN-MEMORY copy of the
# Pi's last push (hub/src/index.ts:275), so no pass reaches the Pi.
#
# Usage: bash scripts/eval-capture.sh            # one line appended to $OUT
#        */10 * * * * ... eval-capture.sh        # the 30 h capture
set -uo pipefail
PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
OUTAGE="${OUTAGEWATCH_URL:-https://victorious-light-production.up.railway.app}"
OUT="${OUT:-$HOME/.a2w/a2w-eval-capture.jsonl}"
g() { curl -sf -m 20 "$@" 2>/dev/null || echo null; }
# A failed fetch must record as null, NEVER as "no alerts" / "no outage": the capture exists to
# answer "did storm mode stand down when the warning ended?", and a transient NWS 5xx that reads
# as [] would answer that question falsely. null = unknown; [] = genuinely none.
# 2026-09-27: api.weather.gov returned 403 for User-Agent "a2w-eval (...)" and 200 for "a2w (...)" --
# same request, same env, only the UA string differed. 57 of the first 58 samples were lost to it.
# Use the planner's own production UA (storm.ts), which is what the live system sees the warning
# through, and RECORD the HTTP code so the next failure is diagnosable from the data itself.
NWS_TMP="$(mktemp)"
NWS_HTTP="$(curl -s -o "$NWS_TMP" -m 20 -H 'User-Agent: a2w-control-planner (ckrohg@me.com)' -w '%{http_code}' 'https://api.weather.gov/alerts/active?point=42.63,-70.87' 2>/dev/null || echo 000)"
if [ "$NWS_HTTP" = "200" ]; then NWS="$(jq -c '[.features[]?.properties | {event,severity,onset,ends,expires}]' "$NWS_TMP" 2>/dev/null || echo null)"; else NWS=null; fi
rm -f "$NWS_TMP"
jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson planner "$(g "$PLANNER/health")" --argjson hub "$(g "$HUB/health")" \
  --argjson outage "$(g "$OUTAGE/api/status")" --argjson nws "$NWS" --arg nws_http "$NWS_HTTP" \
  '{ts:$ts, planner:$planner, hub:$hub, outage:$outage, nws:$nws, nws_http:$nws_http}' >> "$OUT"
