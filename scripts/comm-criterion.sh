#!/usr/bin/env bash
# @purpose Measure Phase B tracking fidelity the way it actually matters (#76).
#
# The original done-criterion for the Aug-5 comm degradation was "<=1 offline event per pump
# per week". Against it we were failing by ~10x (18 offline events in 3.15 days) -- but the
# owner measured what those events COST and the answer was ~28 minutes per fortnight, always
# LOW, never high. The criterion was counting the wrong failure mode: a comm blip that drops
# and recovers between two identical renewals costs nothing, while a single sustained
# over-drive would be a real problem the event count would never surface.
#
# So this measures TIME OFF PLAN, DIRECTION-AWARE:
#   actual setpoint (readings.setpoint_c) vs the last value Phase B successfully sent
#   (phase_b_log where result='sent'), sampled at the reading cadence.
#
# SETTLING. Phase B renews every ~5 min, usually at the SAME value; a renewal needs no settle
# time. Only a CHANGE in commanded value does -- the pump takes a cycle to adopt it, and until
# it does the reading still shows the previous value. Keying the settle window off renewals
# instead of changes discards ~97% of samples and hides everything. So the window is measured
# from the last value CHANGE. Verified: the only 3 "above plan" samples in 14 days all sit
# inside that window, and there are ZERO after it -- which is what makes "always low, never
# high" a sound claim rather than an anecdote.
#
# EXIT CRITERION (the proposed replacement for the event count):
#   FAIL if any settled sample is ABOVE plan          -- over-driving is the dangerous direction
#   FAIL if settled time below plan > MAX_BELOW_PCT   -- sustained under-delivery
#   Offline event COUNT is reported for context but no longer gates.
#
# Usage: DATABASE_URL=... bash scripts/comm-criterion.sh [days] [max_below_pct]
set -uo pipefail
DAYS="${1:-14}"
MAX_BELOW_PCT="${2:-1.0}"
SETTLE="${SETTLE_MIN:-5}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "error: set DATABASE_URL (the planner Postgres connection string)" >&2
  echo "  cd planner && export DATABASE_URL=\$(railway variables --service Postgres --json | jq -r ...)" >&2
  exit 1
fi

read -r -d '' SQL <<SQL
WITH sent AS (
  SELECT pump_id, ts, value_c FROM phase_b_log WHERE result='sent'
), changes AS (          -- collapse renewals: keep only rows where the commanded value CHANGED
  SELECT pump_id, ts, value_c FROM (
    SELECT pump_id, ts, value_c,
           LAG(value_c) OVER (PARTITION BY pump_id ORDER BY ts) AS prev
    FROM sent
  ) s WHERE prev IS DISTINCT FROM value_c
), intent AS (
  SELECT pump_id, ts, value_c,
         LEAD(ts) OVER (PARTITION BY pump_id ORDER BY ts) AS next_ts
  FROM changes
), r AS (
  SELECT pump_id, to_timestamp(ts) AS ts, setpoint_c FROM readings
  WHERE to_timestamp(ts) > now() - interval '$DAYS days' AND setpoint_c IS NOT NULL
), j AS (
  SELECT r.pump_id, r.setpoint_c, i.value_c, (r.ts - i.ts) AS since_change
  FROM r JOIN intent i
    ON i.pump_id=r.pump_id AND r.ts>=i.ts AND (i.next_ts IS NULL OR r.ts<i.next_ts)
), settled AS (
  SELECT * FROM j WHERE since_change > interval '$SETTLE min'
)
SELECT pump_id,
       count(*) AS settled_samples,
       round(100.0*count(*) FILTER (WHERE setpoint_c=value_c)/NULLIF(count(*),0),3) AS pct_on_plan,
       count(*) FILTER (WHERE setpoint_c > value_c) AS above_plan,
       round(100.0*count(*) FILTER (WHERE setpoint_c < value_c)/NULLIF(count(*),0),3) AS pct_below,
       round(COALESCE(max(value_c - setpoint_c),0)::numeric,1) AS worst_shortfall_c
FROM settled GROUP BY pump_id ORDER BY pump_id;
SQL

echo "Phase B tracking fidelity — last ${DAYS}d (settle window ${SETTLE}min from last value CHANGE)"
echo
OUT="$(psql "$DATABASE_URL" -At -F'|' -c "$SQL")"
[ -z "$OUT" ] && { echo "no data in window"; exit 1; }
printf '%-8s %10s %12s %11s %11s %10s\n' pump samples on_plan% above below% worst_short
FAILED=0
while IFS='|' read -r pump n on above below worst; do
  printf '%-8s %10s %12s %11s %11s %10s\n' "$pump" "$n" "$on" "$above" "$below" "$worst"
  [ "${above:-0}" -gt 0 ] 2>/dev/null && { echo "  FAIL $pump: ${above} settled sample(s) ABOVE plan — over-driving"; FAILED=1; }
  awk -v b="${below:-0}" -v m="$MAX_BELOW_PCT" -v p="$pump" \
    'BEGIN{ if (b+0 > m+0) { printf("  FAIL %s: %.3f%% of settled time BELOW plan (max %.1f%%)\n", p, b, m); exit 1 } }' || FAILED=1
done <<< "$OUT"
echo
[ "$FAILED" -eq 0 ] && echo "PASS — no over-drive, under-delivery within tolerance" || echo "FAIL — see above"
exit "$FAILED"
