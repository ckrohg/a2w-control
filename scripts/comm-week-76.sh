#!/usr/bin/env bash
# @purpose Weekly comm report for #76: did the Pi's move from Wi-Fi to wired Ethernet
# (~2026-11-24) fix the Pi <-> W610 Modbus degradation? One table per pump, judged against
# the 2026-08-27 done-criterion, next to the September baseline it has to beat.
#
# READ-ONLY. SELECTs only; the session is opened with default_transaction_read_only=on so
# even a typo cannot write. Run it against the LOCAL restore made by scripts/analyze-local.sh
# (DATABASE_URL=postgres:///a2w_local), NEVER against production — the restore exists so that
# window-function joins over a week of readings never land on the database the house ingests
# into (see the WHY in analyze-local.sh). URLs that look like Railway/Neon are refused.
#
# THE CRITERION (#76, revised 2026-08-27; all three must hold for 7 consecutive days, per pump):
#   (1) no single comm outage longer than 15 min
#   (2) total unavailable time <= 60 min per pump per week
#   (3) pump setpoint off-plan on <= 0.5% of samples per week
#       (readings.setpoint_c vs the latest phase_b_log row with result='sent')
#
# WHERE THE NUMBERS COME FROM
#   (1)+(2)  pump_events — the Pi's event log, mirrored by analytics-mirror/lib/db.ts
#            (pump_id, ts = Pi epoch seconds, type, code). The bridge's poller writes
#            type='comm' code='offline' when a pump stops answering and code='online' on the
#            first good poll after (heatpump-bridge/bridge/poller.py). One outage = one offline
#            edge paired with the next online edge; repeated edges of the same kind (bridge
#            restarts) collapse to one. An outage still open at the end of the data is clipped
#            to the newest reading in the restore and flagged.
#   (3)      scripts/comm-criterion.sh's measure, re-windowed to [start, start+days): the
#            intent is the last value Phase B CHANGED to (renewals at the same value are
#            collapsed), a sample counts only once it is SETTLE_MIN past that change, and the
#            direction is kept — ABOVE plan is over-driving, the dangerous way to be wrong.
#   context  phase_b_log (planner/src/store.ts: ts timestamptz, pump_id, mode, value_c, result)
#            failed results per local day (result LIKE 'failed%'), split out by the hub's
#            "no Pi connected" refusal (hub/src/index.ts 503) — that is the Pi-to-hub dropout
#            signature and the one the Ethernet move should erase. The hub's own dropout
#            episodes (/health pi_dropouts_24h/7d, hub/src/dropouts.ts) live in memory only —
#            the hub has no database — so they are NOT in the restore and not here.
#            readings.online=false samples are shown as a second opinion on (2).
#
# Usage:  DATABASE_URL=postgres:///a2w_local bash scripts/comm-week-76.sh <start-iso> [days=7]
#         e.g.  bash scripts/comm-week-76.sh 2026-11-24          # the week after the Ethernet move
#               bash scripts/comm-week-76.sh 2026-09-27 4        # reproduce the September baseline
#         A bare date means midnight in REPORT_TZ; add a time and zone (2026-11-24T05:00:00Z) to pin it.
# Knobs:  SETTLE_MIN (default 5), REPORT_TZ (default America/New_York; session TZ + the per-day table)
# Exit:   0 PASS on every pump over a full 7 days, 1 FAIL / incomplete / too short, 2 usage or connection error.
set -uo pipefail

START="${1:-}"
DAYS="${2:-7}"
SETTLE="${SETTLE_MIN:-5}"
TZ_NAME="${REPORT_TZ:-America/New_York}"

usage() { echo "usage: DATABASE_URL=postgres:///a2w_local bash $0 <start-iso> [days=7]" >&2; exit 2; }
[ -z "$START" ] && usage
# Loose shape check so a stray argument can never reach the SQL as anything but a timestamp
# literal (psql -v quoting does the escaping; this just fails early and clearly).
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'
[[ "$START" =~ $ISO_RE ]] || { echo "error: start must be an ISO date/time, got '$START'" >&2; usage; }
[[ "$DAYS" =~ ^[0-9]+$ ]] && [ "$DAYS" -ge 1 ] || { echo "error: days must be a positive integer, got '$DAYS'" >&2; usage; }
[[ "$SETTLE" =~ ^[0-9]+$ ]] || { echo "error: SETTLE_MIN must be an integer, got '$SETTLE'" >&2; exit 2; }

if [ -z "${DATABASE_URL:-}" ]; then
  echo "error: set DATABASE_URL to the LOCAL restore, e.g. DATABASE_URL=postgres:///a2w_local" >&2
  echo "  (make one with: bash scripts/analyze-local.sh)" >&2
  exit 2
fi
case "$DATABASE_URL" in
  *railway*|*rlwy.net*|*neon.tech*)
    echo "error: DATABASE_URL looks like PRODUCTION. This report runs against the local restore only (scripts/analyze-local.sh)." >&2
    exit 2 ;;
esac
command -v psql >/dev/null || { echo "error: psql not on PATH (brew install postgresql@17)" >&2; exit 2; }

# Belt and braces for "no writes of any kind": libpq hands this to the server, so every
# transaction psql opens is READ ONLY — an INSERT/UPDATE/DELETE/DDL would error, not run.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on"
# Bare dates and the per-day table both resolve in the house's zone, whatever this Mac is set to.
export PGTZ="$TZ_NAME"

# One psql session per query, SQL on stdin so psql's :'var' interpolation applies (it does not
# for -c). Variables arrive as quoted literals, never spliced into the text.
q() {
  psql "$DATABASE_URL" -X -q -At -F'|' -v ON_ERROR_STOP=1 \
       -v start="$START" -v days="$DAYS" -v settle="$SETTLE" -v tz="$TZ_NAME" -f -
}

# ---------------------------------------------------------------- preflight: tables, then data span
TABLES="$(q <<'SQL'
SELECT (to_regclass('public.readings')    IS NOT NULL)::int,
       (to_regclass('public.pump_events') IS NOT NULL)::int,
       (to_regclass('public.phase_b_log') IS NOT NULL)::int;
SQL
)" || { echo "error: could not query $DATABASE_URL (is the local restore up? pg_isready; bash scripts/analyze-local.sh)" >&2; exit 2; }
IFS='|' read -r HAS_R HAS_E HAS_P <<< "$TABLES"
MISSING=""
[ "$HAS_R" = 1 ] || MISSING="$MISSING readings"
[ "$HAS_E" = 1 ] || MISSING="$MISSING pump_events"
[ "$HAS_P" = 1 ] || MISSING="$MISSING phase_b_log"
[ -n "$MISSING" ] && { echo "error: table(s) missing in this database:$MISSING — wrong DB, or the restore failed" >&2; exit 2; }

SPAN="$(q <<'SQL'
WITH win AS (
  SELECT :'start'::timestamptz AS s, :'start'::timestamptz + (:'days')::int * interval '1 day' AS e
), d AS (
  SELECT to_timestamp(max(ts)) AS last_ts FROM readings
)
SELECT to_char(win.s AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
       to_char(win.e AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
       COALESCE(to_char(d.last_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), 'none'),
       COALESCE((d.last_ts < win.e)::int, 1)
FROM win, d;
SQL
)" || { echo "error: span query failed (bad start date?)" >&2; exit 2; }
IFS='|' read -r WIN_START WIN_END DATA_END INCOMPLETE <<< "$SPAN"

echo "#76 weekly comm report — window ${WIN_START} .. ${WIN_END} (${DAYS}d), settle ${SETTLE} min, days in ${TZ_NAME}"
echo "source: ${DATABASE_URL} (local restore; newest reading ${DATA_END})"
[ "${INCOMPLETE:-1}" = 1 ] && echo "NOTE: the restore ends BEFORE the window does — numbers below cover a partial window; the verdict is provisional."
echo

# ---------------------------------------------------------------- (1)+(2) outages from pump_events
# Edges are read from 2 days before the window so an outage already open at the start keeps its
# real start (then gets clipped to the window). Everything is clipped to [start, data_end).
OUTAGES="$(q <<'SQL'
WITH win AS (
  SELECT :'start'::timestamptz AS s,
         LEAST(:'start'::timestamptz + (:'days')::int * interval '1 day',
               COALESCE((SELECT to_timestamp(max(ts)) FROM readings), now())) AS e
), ev AS (
  SELECT pump_id, to_timestamp(ts) AS ts, code
  FROM pump_events, win
  WHERE type = 'comm' AND code IN ('offline', 'online')
    AND ts >= EXTRACT(EPOCH FROM win.s - interval '2 days') AND ts < EXTRACT(EPOCH FROM win.e)
), edges AS (        -- collapse offline,offline / online,online runs into one edge per transition
  SELECT pump_id, ts, code FROM (
    SELECT pump_id, ts, code, LAG(code) OVER (PARTITION BY pump_id ORDER BY ts) AS prev FROM ev
  ) x WHERE prev IS DISTINCT FROM code
), ep AS (           -- after collapsing, the row after an offline edge is its online edge
  SELECT pump_id, ts AS off_ts, code,
         LEAD(ts) OVER (PARTITION BY pump_id ORDER BY ts) AS on_ts
  FROM edges
), clipped AS (
  SELECT ep.pump_id,
         GREATEST(off_ts, win.s) AS s,
         LEAST(COALESCE(on_ts, win.e), win.e) AS e,
         (on_ts IS NULL)::int AS still_open
  FROM ep, win
  WHERE code = 'offline' AND COALESCE(on_ts, win.e) > win.s
), longest AS (
  SELECT DISTINCT ON (pump_id) pump_id, e AS longest_end
  FROM clipped ORDER BY pump_id, (e - s) DESC, e DESC
), pumps AS (
  SELECT DISTINCT pump_id FROM readings, win
  WHERE ts >= EXTRACT(EPOCH FROM win.s) AND ts < EXTRACT(EPOCH FROM win.e)
), per AS (
  SELECT p.pump_id,
         count(c.s) AS outages,
         round((COALESCE(max(EXTRACT(EPOCH FROM c.e - c.s)), 0) / 60)::numeric, 1) AS longest_min,
         round((COALESCE(sum(EXTRACT(EPOCH FROM c.e - c.s)), 0) / 60)::numeric, 1) AS total_min,
         COALESCE(max(c.still_open), 0) AS still_open
  FROM pumps p LEFT JOIN clipped c ON c.pump_id = p.pump_id
  GROUP BY p.pump_id
), rd AS (           -- second opinion: the mirror own online flag, one row per pump per ~60 s
  SELECT pump_id, count(*) AS samples, count(*) FILTER (WHERE online IS FALSE) AS off_samples
  FROM readings, win
  WHERE ts >= EXTRACT(EPOCH FROM win.s) AND ts < EXTRACT(EPOCH FROM win.e)
  GROUP BY pump_id
)
SELECT per.pump_id, per.outages, per.longest_min, per.total_min, per.still_open,
       COALESCE(to_char(l.longest_end AT TIME ZONE 'UTC', 'MM-DD HH24:MI"Z"'), '-'),
       COALESCE(rd.off_samples, 0), COALESCE(rd.samples, 0)
FROM per LEFT JOIN longest l USING (pump_id) LEFT JOIN rd USING (pump_id)
ORDER BY per.pump_id;
SQL
)" || { echo "error: outage query failed" >&2; exit 2; }

# ---------------------------------------------------------------- (3) off-plan, comm-criterion.sh's measure
OFFPLAN="$(q <<'SQL'
WITH win AS (
  SELECT :'start'::timestamptz AS s, :'start'::timestamptz + (:'days')::int * interval '1 day' AS e
), sent AS (
  SELECT pump_id, ts, value_c FROM phase_b_log WHERE result = 'sent'
), changes AS (      -- collapse renewals: keep only rows where the commanded value CHANGED
  SELECT pump_id, ts, value_c FROM (
    SELECT pump_id, ts, value_c, LAG(value_c) OVER (PARTITION BY pump_id ORDER BY ts) AS prev FROM sent
  ) s WHERE prev IS DISTINCT FROM value_c
), intent AS (
  SELECT pump_id, ts, value_c, LEAD(ts) OVER (PARTITION BY pump_id ORDER BY ts) AS next_ts FROM changes
), r AS (
  SELECT pump_id, to_timestamp(ts) AS ts, setpoint_c FROM readings, win
  WHERE ts >= EXTRACT(EPOCH FROM win.s) AND ts < EXTRACT(EPOCH FROM win.e) AND setpoint_c IS NOT NULL
), j AS (
  SELECT r.pump_id, r.setpoint_c, i.value_c, (r.ts - i.ts) AS since_change
  FROM r JOIN intent i ON i.pump_id = r.pump_id AND r.ts >= i.ts AND (i.next_ts IS NULL OR r.ts < i.next_ts)
), settled AS (
  SELECT * FROM j WHERE since_change > (:'settle')::int * interval '1 min'
)
SELECT pump_id,
       count(*) AS settled_samples,
       round(100.0 * count(*) FILTER (WHERE setpoint_c <> value_c) / NULLIF(count(*), 0), 3) AS pct_off,
       round(100.0 * count(*) FILTER (WHERE setpoint_c <  value_c) / NULLIF(count(*), 0), 3) AS pct_below,
       count(*) FILTER (WHERE setpoint_c > value_c) AS above_n,
       round(COALESCE(max(value_c - setpoint_c), 0)::numeric, 1) AS worst_short_c
FROM settled GROUP BY pump_id ORDER BY pump_id;
SQL
)" || { echo "error: off-plan query failed" >&2; exit 2; }

# ---------------------------------------------------------------- context: phase_b failed results per local day
FAILED="$(q <<'SQL'
WITH win AS (
  SELECT :'start'::timestamptz AS s, :'start'::timestamptz + (:'days')::int * interval '1 day' AS e
), rows_in AS (
  SELECT pump_id, (ts AT TIME ZONE :'tz')::date AS day, result
  FROM phase_b_log, win
  WHERE mode = 'active' AND ts >= win.s AND ts < win.e
)
SELECT pump_id,
       to_char(day, 'MM-DD'),
       count(*) FILTER (WHERE result LIKE 'failed%') AS failed,
       count(*) FILTER (WHERE result LIKE '%no Pi connected%') AS pi_gone,
       count(*) AS active_rows
FROM rows_in
GROUP BY pump_id, day
ORDER BY pump_id, day;
SQL
)" || { echo "error: phase_b_log query failed" >&2; exit 2; }

# ---------------------------------------------------------------- print, one block per pump
MAX_OUTAGE_MIN=15
MAX_TOTAL_MIN=60
MAX_OFF_PCT=0.5
VERDICT=0
ANY_PUMP=0

[ -z "$OUTAGES" ] && echo "no readings in the window — nothing to judge (is the start date inside the restore's span?)"

while IFS='|' read -r pump outages longest total still_open longest_end off_samples samples; do
  [ -z "$pump" ] && continue
  ANY_PUMP=1
  off_line="$(grep "^${pump}|" <<< "$OFFPLAN" || true)"
  IFS='|' read -r _ n_settled pct_off pct_below above_n worst <<< "${off_line:-|0|||0|}"

  if [ "${outages:-0}" -eq 0 ]; then ended_txt="none"
  elif [ "$still_open" = 1 ];  then ended_txt="longest STILL OPEN at data end"
  else                               ended_txt="longest ended ${longest_end}"
  fi

  echo "== ${pump} =="
  printf '  %-34s %10s   %s\n' "longest outage (min)"    "$longest" "limit ${MAX_OUTAGE_MIN}; ${ended_txt}"
  printf '  %-34s %10s   %s\n' "total unavailable (min)" "$total"   "limit ${MAX_TOTAL_MIN} per week"
  printf '  %-34s %10s\n'      "outage count"            "$outages"
  if [ -n "$off_line" ]; then
    printf '  %-34s %10s   %s\n' "off-plan % (settled)"   "$pct_off"   "limit ${MAX_OFF_PCT}; over ${n_settled} settled samples"
    printf '  %-34s %10s   %s\n' "  below plan %"         "$pct_below" "worst shortfall ${worst} C"
    printf '  %-34s %10s   %s\n' "  above plan (samples)" "$above_n"   "over-driving; comm-criterion.sh fails on any"
  else
    printf '  %-34s %10s   %s\n' "off-plan % (settled)"   "n/a"        "no settled samples: no result='sent' intent covers this window"
  fi
  if [ "${samples:-0}" -gt 0 ]; then
    printf '  %-34s %10s   %s\n' "readings online=false (samples)" "$off_samples" "of ${samples} (~1/min) — second opinion on unavailable time"
  fi

  # per-day phase_b failures
  day_rows="$(grep "^${pump}|" <<< "$FAILED" || true)"
  if [ -n "$day_rows" ]; then
    fail_sum="$(awk -F'|' '{s+=$3} END{print s+0}' <<< "$day_rows")"
    row_sum="$(awk -F'|' '{s+=$5} END{print s+0}' <<< "$day_rows")"
    if [ "$fail_sum" -gt 0 ]; then
      echo "  phase_b failed results per day (mode=active; pi_gone = hub answered 'no Pi connected'):"
      printf '    %-6s %7s %8s %8s\n' day failed pi_gone rows
      while IFS='|' read -r _ day failed pi_gone rows; do
        printf '    %-6s %7s %8s %8s\n' "$day" "$failed" "$pi_gone" "$rows"
      done <<< "$day_rows"
    else
      echo "  phase_b failed results per day: none (${row_sum} active rows, 0 failed)"
    fi
  else
    echo "  phase_b failed results per day: no active phase_b_log rows in the window"
  fi

  # verdict per criterion; (2) is "per week", so a shorter window is pro-rated
  pass1=$(awk -v v="$longest" -v m="$MAX_OUTAGE_MIN" 'BEGIN{print (v+0 <= m+0) ? "PASS" : "FAIL"}')
  pass2=$(awk -v v="$total" -v m="$MAX_TOTAL_MIN" -v d="$DAYS" 'BEGIN{print (v+0 <= m*d/7) ? "PASS" : "FAIL"}')
  if [ -n "$off_line" ]; then
    pass3=$(awk -v v="$pct_off" -v m="$MAX_OFF_PCT" 'BEGIN{print (v+0 <= m+0) ? "PASS" : "FAIL"}')
    note3=""
  else
    pass3="FAIL"; note3=" (unmeasurable: no intent)"
  fi
  note2=""; [ "$DAYS" -ne 7 ] && note2=" (pro-rated to ${DAYS}d)"
  echo "  (1) longest outage <= ${MAX_OUTAGE_MIN} min ........ ${pass1}"
  echo "  (2) unavailable <= ${MAX_TOTAL_MIN} min/week ....... ${pass2}${note2}"
  echo "  (3) off-plan <= ${MAX_OFF_PCT}% of samples ........ ${pass3}${note3}"
  [ "$pass1$pass2$pass3" = "PASSPASSPASS" ] || VERDICT=1
  echo
done <<< "$OUTAGES"

# ---------------------------------------------------------------- the bar to beat
cat <<'EOF'
== September baseline (from #76, comment of 2026-09-30; before the Ethernet move) ==
  failed /health.phase_b samples per pump per day (1 per 10 min, ~144/day) — the table above counts phase_b_log rows (~288/day), so halve it before comparing
    day     pump1 failed   pump2 failed
    09-27              1              7
    09-28             25             12
    09-29             13              1
    09-30              3              4
  fidelity measured 2026-08-27 (comm-criterion.sh, 14 d): pump1 100.0% on-plan, pump2 99.86%
  (loosely: 0.5% of ~144 cycles/day is ~0.7 failed/day; September ran 1-25)
EOF
echo

# ---------------------------------------------------------------- verdict
if [ "$ANY_PUMP" = 0 ]; then
  echo "VERDICT: NO DATA — nothing in [${WIN_START}, ${WIN_END})"; exit 1
fi
if [ "$VERDICT" -ne 0 ]; then
  echo "VERDICT: FAIL — at least one criterion missed on at least one pump (see above)."; exit 1
fi
if [ "${INCOMPLETE:-1}" = 1 ]; then
  echo "VERDICT: PASS so far — but the restore ends at ${DATA_END}, before the window does. Re-run on the next Monday's backup to close #76."
  exit 1
fi
if [ "$DAYS" -lt 7 ]; then
  echo "VERDICT: PASS on ${DAYS} days — #76 needs 7 consecutive; not enough yet."; exit 1
fi
echo "VERDICT: PASS — all three #76 criteria held for ${DAYS} days on every pump."
exit 0
