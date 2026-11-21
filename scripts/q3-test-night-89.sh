#!/usr/bin/env bash
# @purpose Read-only query pack for issue #89's decisive question, Q3: on a cold night (forecast
# <= 20 F) with the Living Room Baseboard thermostat switched ON at its usual setpoint for ~4 h,
# did the room hold setpoint at the supply water temperature A2W actually delivered?
#
# Runs ONLY against the LOCAL restore made by scripts/analyze-local.sh (default db a2w_local),
# never production: the connection string must name a loopback host or a unix socket, the same
# rule as planner/src/local-db.ts. Every statement is a SELECT (plus a session SET TIME ZONE);
# nothing is created, written or deleted. scripts/ is inert and deploys nothing.
#
# Usage:
#   DATABASE_URL=postgres://localhost:5432/a2w_local \
#     bash scripts/q3-test-night-89.sh <start-iso> <end-iso> [zone='Living Room Baseboard']
#
#   <start-iso>/<end-iso> are the hours the stat was ON (e.g. 2026-12-05T19:00 2026-12-05T23:00).
#   A bare local time is read in $TZ (default America/New_York); an explicit offset wins.
#   The table covers the window plus 2 h either side, in 10-minute buckets.
#
# Tunables (env): TZ=America/New_York  ELEMENT_W=1000 (Buffer Tank draw that means the element
#   ran)  HOLD_TOL_F=1  MIN_CALL_MIN=120  MAX_OUTDOOR_F=25
#
# Sources, with the column names taken from the schema in this repo (not guessed):
#   slx_readings (planner/src/store.ts)           ts, outdoor_f, tank_f, tank_target_f, backup_called,
#                                                 stages_called                      -- HBX, every 5 min
#   hbx_config_versions.config (store.ts)         dbt, mbt, dot, wwsd -> the curve IN FORCE at the
#                                                 bucket's outdoor, the formula store.ts hourlyActuals uses
#   zone_call_samples (store.ts)                  calling_zone_ids (TempIQ zone ids), every ~5 min, 60-day prune
#   zone_floor_snapshots.zones[] (store.ts; keys  zoneId, name, calling, setpointF, roomF, localF,
#     from planner/src/demand.ts ZoneFloor)       ceilingF, ceilingSource, awtF        -- hourly
#   tempiq_zone_physics (store.ts)                zone_id, name, emitter_type, ua_btu_hr_f, source, confidence
#   span_readings (analytics-mirror/lib/db.ts)    ts (epoch s), name, power_w; names 'Buffer Tank',
#                                                 'Air-Water 1', 'Air-Water 2'; draw is reported NEGATIVE (#202)
#
# Known limits, stated so the verdict is read correctly:
#   * roomF / setpointF / ceilingF / localF come from the HOURLY zone_floor_snapshots row nearest each
#     bucket (snap_age says how old). The rise rate and hold minutes are therefore hourly-resolution.
#   * ceilingF is persisted only when TempIQ emitted requiredSupplyWaterTempF for the zone (owner-verified
#     hydronic zone with fresh outdoor data) -- '-' means TempIQ gave no number that hour, not 0.
#   * The restore ends at its backup date; a window newer than that prints nothing. Re-run analyze-local.sh.
set -euo pipefail

usage() {
  echo "usage: DATABASE_URL=postgres://localhost:5432/a2w_local bash $0 <start-iso> <end-iso> [zone]" >&2
  exit 2
}
[ $# -ge 2 ] && [ $# -le 3 ] || usage
START="$1"; END="$2"; ZONE="${3:-Living Room Baseboard}"
TZ_NAME="${TZ:-America/New_York}"
ELEMENT_W="${ELEMENT_W:-1000}"
HOLD_TOL_F="${HOLD_TOL_F:-1}"
MIN_CALL_MIN="${MIN_CALL_MIN:-120}"
MAX_OUTDOOR_F="${MAX_OUTDOOR_F:-25}"

command -v psql >/dev/null || { echo "error: psql not found on PATH (brew install postgresql@17)" >&2; exit 1; }

# ── local-only guard (mirrors planner/src/local-db.ts: loopback host or unix socket, else refuse) ──
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="postgres://localhost:5432/a2w_local"
  echo "note: DATABASE_URL unset -- using the analyze-local.sh default $DATABASE_URL" >&2
fi
case "$DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "error: DATABASE_URL is not a postgres:// URL" >&2; exit 1 ;;
esac
is_loopback() {
  case "$1" in
    localhost|127.0.0.1|::1|'[::1]') return 0 ;;
    /*) return 0 ;;   # unix socket directory
    *) return 1 ;;
  esac
}
_auth="${DATABASE_URL#*://}"            # user:pass@host:port/db?query
_auth="${_auth%%\?*}"                   # drop the query string
_auth="${_auth%%/*}"                    # drop /db
_auth="${_auth##*@}"                    # drop user:pass@
case "$_auth" in
  \[*\]*) _host="${_auth%%]*}"; _host="${_host}]" ;;     # [::1]:5432
  *)      _host="${_auth%%:*}" ;;
esac
if [ -z "$_host" ]; then
  echo "error: no host in DATABASE_URL (PGHOST would decide) -- name localhost explicitly" >&2; exit 1
fi
is_loopback "$_host" || { echo "error: DATABASE_URL host is '$_host', not a loopback address. This script runs ONLY against the local restore (scripts/analyze-local.sh)." >&2; exit 1; }
# a `host=` query parameter overrides the authority in libpq -- it must be loopback too
_q="${DATABASE_URL#*\?}"
if [ "$_q" != "$DATABASE_URL" ] && [ -n "$_q" ]; then
  _rest="$_q"
  while [ -n "$_rest" ]; do
    _p="${_rest%%&*}"
    case "$_p" in
      host=*) is_loopback "${_p#host=}" || { echo "error: DATABASE_URL query host=${_p#host=} is not loopback" >&2; exit 1; } ;;
    esac
    [ "$_rest" = "$_p" ] && break
    _rest="${_rest#*&}"
  done
fi

PSQL=(psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1
      -v start="$START" -v end="$END" -v zone="$ZONE" -v tz="$TZ_NAME"
      -v element_w="$ELEMENT_W" -v hold_tol="$HOLD_TOL_F" -v min_call="$MIN_CALL_MIN" -v max_out="$MAX_OUTDOOR_F")

# ── preflight: every table this pack reads must exist in the restore ──
MISSING="$("${PSQL[@]}" -At <<'SQL'
SELECT string_agg(t, ' ')
FROM unnest(ARRAY['slx_readings','hbx_config_versions','zone_floor_snapshots','zone_call_samples',
                  'tempiq_zone_physics','span_readings']) t
WHERE to_regclass(t) IS NULL;
SQL
)"
if [ -n "$MISSING" ]; then
  echo "error: table(s) not in this database: $MISSING -- is DATABASE_URL the analyze-local.sh restore?" >&2
  exit 1
fi

# ── the shared CTE block: one row per 10-minute bucket, window +/- 2 h ──
sql_common() { cat <<'SQL'
WITH params AS (
  SELECT :'start'::timestamptz AS w_start, :'end'::timestamptz AS w_end, :'zone'::text AS zone_name
),
zone_ids AS (
  -- TempIQ zone id(s) for the named zone: tempiq_zone_physics first, then any snapshot naming it
  SELECT DISTINCT zone_id FROM (
    SELECT p.zone_id FROM tempiq_zone_physics p, params q WHERE p.name = q.zone_name
    UNION ALL
    SELECT z->>'zoneId' FROM zone_floor_snapshots s, params q, jsonb_array_elements(s.zones) z
     WHERE s.ts BETWEEN q.w_start - interval '2 hours' AND q.w_end + interval '2 hours'
       AND z->>'name' = q.zone_name
  ) x WHERE zone_id IS NOT NULL AND zone_id <> ''
),
grid AS (
  SELECT g AS b, g + interval '10 minutes' AS b_end, (g >= p.w_start AND g < p.w_end) AS in_window
  FROM params p,
       generate_series(p.w_start - interval '2 hours', p.w_end + interval '2 hours' - interval '10 minutes',
                       interval '10 minutes') g
),
slx AS (
  SELECT g.b, avg(r.outdoor_f) AS outdoor_f, avg(r.tank_f) AS tank_f, avg(r.tank_target_f) AS tank_target_f,
         bool_or(coalesce(r.backup_called, false)) AS backup_called,
         bool_or(EXISTS (SELECT 1 FROM unnest(r.stages_called) s WHERE s)) AS stage_called,
         count(r.ts)::int AS n
  FROM grid g LEFT JOIN slx_readings r ON r.ts >= g.b AND r.ts < g.b_end
  GROUP BY g.b
),
curve AS (
  -- the curve IN FORCE: newest hbx_config_versions row at or before the bucket end, evaluated at the
  -- bucket's outdoor exactly as store.ts hourlyActuals / shadow.ts curveTargetF do
  SELECT s.b, c.cmd_f, c.observed_at AS curve_since
  FROM slx s LEFT JOIN LATERAL (
    SELECT v.observed_at,
           CASE
             WHEN (v.config->>'dbt') IS NULL OR (v.config->>'mbt') IS NULL THEN NULL
             WHEN (v.config->>'dot') IS NULL OR (v.config->>'wwsd') IS NULL OR s.outdoor_f IS NULL
                  OR (v.config->>'wwsd')::float8 = (v.config->>'dot')::float8
               THEN ((v.config->>'dbt')::float8 + (v.config->>'mbt')::float8) / 2
             ELSE GREATEST(LEAST((v.config->>'dbt')::float8, (v.config->>'mbt')::float8),
                    LEAST(GREATEST((v.config->>'dbt')::float8, (v.config->>'mbt')::float8),
                      (v.config->>'dbt')::float8 + (s.outdoor_f - (v.config->>'dot')::float8)
                        * ((v.config->>'mbt')::float8 - (v.config->>'dbt')::float8)
                        / ((v.config->>'wwsd')::float8 - (v.config->>'dot')::float8)))
           END AS cmd_f
    FROM hbx_config_versions v
    WHERE v.observed_at <= s.b + interval '10 minutes'
    ORDER BY v.id DESC LIMIT 1
  ) c ON true
),
calls AS (
  -- calling_zone_ids NULL = call feed unhealthy for that sample (store.ts); bool_or skips those rows,
  -- so a bucket counts as unhealthy only when EVERY sample in it was
  SELECT g.b, count(c.ts)::int AS n,
         bool_and(c.calling_zone_ids IS NULL) AS feed_unhealthy,
         bool_or(c.calling_zone_ids && (SELECT array_agg(zone_id) FROM zone_ids)) AS calling
  FROM grid g LEFT JOIN zone_call_samples c ON c.ts >= g.b AND c.ts < g.b_end
  GROUP BY g.b
),
snap AS (
  -- the HOURLY floor snapshot nearest the bucket (up to 65 min before, 15 min after)
  SELECT g.b, ns.*
  FROM grid g LEFT JOIN LATERAL (
    SELECT s.ts AS snap_ts,
           (z->>'calling')::boolean AS snap_calling,
           (z->>'setpointF')::real   AS setpoint_f,
           (z->>'roomF')::real       AS room_f,
           (z->>'localF')::real      AS local_f,
           (z->>'ceilingF')::real    AS ceiling_f,
           z->>'ceilingSource'       AS ceiling_source,
           (z->>'awtF')::real        AS awt_f
    FROM zone_floor_snapshots s, params p, jsonb_array_elements(s.zones) z
    WHERE s.ts BETWEEN g.b - interval '65 minutes' AND g.b + interval '15 minutes'
      AND (z->>'zoneId' IN (SELECT zone_id FROM zone_ids) OR z->>'name' = p.zone_name)
    ORDER BY abs(extract(epoch FROM (s.ts - g.b))) LIMIT 1
  ) ns ON true
),
span AS (
  -- SPAN local samples (~25 s). Consumption is reported negative (#202): abs() throughout.
  SELECT g.b,
         max(abs(p.power_w)) FILTER (WHERE p.name = 'Buffer Tank')  AS element_w_max,
         avg(abs(p.power_w)) FILTER (WHERE p.name = 'Air-Water 1')  AS hp1_w,
         avg(abs(p.power_w)) FILTER (WHERE p.name = 'Air-Water 2')  AS hp2_w,
         count(p.ts) FILTER (WHERE p.name = 'Buffer Tank')::int     AS n_element
  FROM grid g LEFT JOIN span_readings p
         ON p.ts >= extract(epoch FROM g.b)::float8 AND p.ts < extract(epoch FROM g.b_end)::float8
        AND p.name IN ('Buffer Tank', 'Air-Water 1', 'Air-Water 2')
  GROUP BY g.b
),
buckets AS (
  SELECT g.b, g.in_window,
         s.n AS slx_n, s.outdoor_f, s.tank_f, s.tank_target_f,
         CASE WHEN s.n > 0 THEN s.backup_called END AS backup_called,
         CASE WHEN s.n > 0 THEN s.stage_called  END AS stage_called,
         cv.cmd_f, cv.curve_since,
         -- calling: the 5-min call feed when it has samples and was healthy, else the hourly snapshot
         CASE WHEN ca.n > 0 AND NOT ca.feed_unhealthy THEN ca.calling ELSE sn.snap_calling END AS calling,
         CASE WHEN ca.n > 0 AND NOT ca.feed_unhealthy THEN 'calls' WHEN sn.snap_calling IS NOT NULL THEN 'snap' END AS calling_src,
         sn.snap_ts, sn.setpoint_f, sn.room_f, sn.local_f, sn.ceiling_f, sn.ceiling_source, sn.awt_f,
         sp.element_w_max, sp.hp1_w, sp.hp2_w, sp.n_element
  FROM grid g
  LEFT JOIN slx   s  USING (b)
  LEFT JOIN curve cv USING (b)
  LEFT JOIN calls ca USING (b)
  LEFT JOIN snap  sn USING (b)
  LEFT JOIN span  sp USING (b)
)
SQL
}

{
  cat <<'SQL'
SET TIME ZONE :'tz';
\pset null '-'
\pset footer off
\pset border 1
\echo
\echo '=== #89 Q3 cold-night query pack (read-only, LOCAL restore) ==='
SELECT :'zone' AS zone,
       :'start'::timestamptz AS window_start, :'end'::timestamptz AS window_end,
       round(extract(epoch FROM (:'end'::timestamptz - :'start'::timestamptz)) / 60)::int AS window_min,
       current_setting('TimeZone') AS tz;
\echo
\echo '-- the zone as TempIQ knows it (tempiq_zone_physics) --'
SELECT zone_id, name, emitter_type, ua_btu_hr_f, confidence, source, fetched_at
FROM tempiq_zone_physics WHERE name = :'zone';
\echo
\echo '-- data extent of this restore vs the window (anything newer than the restore is NOT here) --'
SELECT (SELECT max(ts) FROM slx_readings)                                     AS slx_newest,
       (SELECT max(ts) FROM zone_floor_snapshots)                             AS snapshot_newest,
       (SELECT max(ts) FROM zone_call_samples)                                AS call_sample_newest,
       (SELECT to_timestamp(max(ts)) FROM span_readings)                      AS span_newest,
       CASE WHEN (SELECT max(ts) FROM slx_readings) < :'end'::timestamptz
            THEN 'RESTORE ENDS BEFORE THE WINDOW -- re-run scripts/analyze-local.sh after the next backup'
            ELSE 'window covered' END                                         AS coverage;
\echo
\echo '-- per 10 min, window +/- 2 h.  call/src: calls = zone_call_samples, snap = hourly snapshot.'
\echo '   tgt_rep = HBX reported target (freezes while idle); curve = curve in force at this outdoor;'
\echo '   tiq_ceil = TempIQ required-supply ceiling (+ provenance); local = A2W local model; awt = floor used.'
\echo '   bkup = HBX backup_called; elem_W = max Buffer Tank draw; hp1/hp2_W = mean Air-Water draw. --'
SQL
  sql_common
  cat <<'SQL'
SELECT to_char(b, 'MM-DD HH24:MI')                                   AS "time",
       CASE WHEN in_window THEN '*' ELSE '' END                     AS "in",
       round(outdoor_f::numeric, 1)                                 AS "out_F",
       CASE calling WHEN true THEN 'ON' WHEN false THEN 'off' END   AS "call",
       calling_src                                                  AS "src",
       round(setpoint_f::numeric, 1)                                AS "sp_F",
       round(room_f::numeric, 1)                                    AS "room_F",
       round((room_f - setpoint_f)::numeric, 1)                     AS "room-sp",
       CASE WHEN snap_ts IS NOT NULL
            THEN round(extract(epoch FROM (b - snap_ts)) / 60)::int END AS "snap_age",
       round(tank_target_f::numeric, 1)                             AS "tgt_rep",
       round(tank_f::numeric, 1)                                    AS "tank_F",
       round(cmd_f::numeric, 1)                                     AS "curve_F",
       round(ceiling_f::numeric, 1)                                 AS "tiq_ceil",
       ceiling_source                                               AS "ceil_src",
       round(local_f::numeric, 1)                                   AS "local_F",
       round(awt_f::numeric, 1)                                     AS "awt_F",
       CASE backup_called WHEN true THEN 'Y' WHEN false THEN '' END AS "bkup",
       round(element_w_max::numeric)                                AS "elem_W",
       round(hp1_w::numeric)                                        AS "hp1_W",
       round(hp2_w::numeric)                                        AS "hp2_W"
FROM buckets
ORDER BY b;
\echo
\echo '=== verdict (window only; rule printed at the bottom) ==='
\x on
SQL
  sql_common
  cat <<'SQL'
, w AS (SELECT * FROM buckets WHERE in_window),
bounds AS (
  SELECT min(b) FILTER (WHERE calling) AS t0, max(b) FILTER (WHERE calling) AS t1 FROM w
),
stats AS (
  -- aggregates over the window; no GROUP BY, so an empty window still yields one row
  SELECT
    (SELECT count(*) FROM zone_ids)                                                  AS zone_ids_found,
    count(*) FILTER (WHERE calling) * 10                                             AS calling_min,
    count(*) FILTER (WHERE calling IS NULL) * 10                                     AS unknown_call_min,
    count(*) FILTER (WHERE calling AND b >= (SELECT t0 FROM bounds) + interval '60 minutes'
                       AND room_f IS NOT NULL AND setpoint_f IS NOT NULL) * 10       AS eval_min,
    count(*) FILTER (WHERE calling AND b >= (SELECT t0 FROM bounds) + interval '60 minutes'
                       AND room_f >= setpoint_f - :hold_tol::real) * 10              AS held_min,
    count(*) FILTER (WHERE calling AND b > (SELECT t1 FROM bounds) - interval '60 minutes'
                       AND room_f IS NOT NULL AND setpoint_f IS NOT NULL) * 10       AS final_eval_min,
    count(*) FILTER (WHERE calling AND b > (SELECT t1 FROM bounds) - interval '60 minutes'
                       AND room_f >= setpoint_f - :hold_tol::real) * 10              AS final_held_min,
    min(room_f - setpoint_f) FILTER (WHERE calling AND b > (SELECT t1 FROM bounds) - interval '60 minutes')
                                                                                     AS final_worst_deficit_f,
    min(outdoor_f)                                                                   AS min_outdoor_f,
    avg(outdoor_f) FILTER (WHERE calling)                                            AS mean_outdoor_calling_f,
    avg(tank_f)    FILTER (WHERE calling)                                            AS mean_tank_f,
    avg(cmd_f)     FILTER (WHERE calling)                                            AS mean_curve_f,
    avg(tank_target_f) FILTER (WHERE calling)                                        AS mean_reported_target_f,
    avg(ceiling_f) FILTER (WHERE calling)                                            AS mean_tempiq_ceiling_f,
    avg(local_f)   FILTER (WHERE calling)                                            AS mean_local_model_f,
    avg(awt_f)     FILTER (WHERE calling)                                            AS mean_awt_floor_f,
    coalesce(bool_or(backup_called), false)                                          AS hbx_backup_called,
    max(element_w_max)                                                               AS element_w_max,
    coalesce(bool_or(element_w_max >= :element_w::real), false)                      AS element_drew_power,
    avg(hp1_w) FILTER (WHERE calling)                                                AS mean_hp1_w,
    avg(hp2_w) FILTER (WHERE calling)                                                AS mean_hp2_w,
    min(room_f) FILTER (WHERE calling)                                               AS min_room_f,
    max(room_f) FILTER (WHERE calling)                                               AS max_room_f,
    max(setpoint_f) FILTER (WHERE calling)                                           AS setpoint_seen_f,
    (SELECT t0 FROM bounds)                                                          AS t0,
    (SELECT t1 FROM bounds)                                                          AS t1
  FROM w
),
rise AS (
  -- room rise rate over the DISTINCT hourly snapshots while calling (deg F per hour)
  SELECT regr_slope(room_f::float8, (extract(epoch FROM snap_ts) / 3600.0)::float8) AS rise_f_per_h,
         count(*)::int AS snapshots
  FROM (SELECT DISTINCT snap_ts, room_f FROM w WHERE calling AND room_f IS NOT NULL AND snap_ts IS NOT NULL) d
),
judged AS (
  SELECT s.*, r.rise_f_per_h, r.snapshots,
         CASE WHEN s.eval_min > 0 THEN s.held_min::numeric / s.eval_min END AS held_share,
         CASE
           WHEN s.zone_ids_found = 0                     THEN 'inconclusive: zone not found in tempiq_zone_physics or any snapshot'
           WHEN s.calling_min < :min_call               THEN 'inconclusive: zone called ' || s.calling_min || ' min (< ' || :min_call || ')'
           WHEN s.min_outdoor_f IS NULL                 THEN 'inconclusive: no slx_readings in the window'
           WHEN s.min_outdoor_f > :max_out              THEN 'inconclusive: outdoor never below ' || :max_out || ' F (min ' || round(s.min_outdoor_f::numeric, 1) || ')'
           WHEN r.snapshots < 2 OR s.eval_min = 0       THEN 'inconclusive: fewer than 2 room/setpoint snapshots after the first 60 min of calling'
           WHEN s.held_min::numeric / s.eval_min >= 0.8 THEN 'A2W adequate'
           WHEN s.final_worst_deficit_f <= -2 AND coalesce(r.rise_f_per_h, 0) <= 0.5
                                                        THEN 'A2W too cold'
           ELSE 'inconclusive: room below setpoint but still rising (near the crossover, or coasting on thermal mass)'
         END AS verdict
  FROM stats s, rise r
)
SELECT verdict,
       zone_ids_found,
       t0  AS first_call_at, t1 AS last_call_at,
       calling_min, unknown_call_min,
       held_min || ' of ' || eval_min || ' min (after first 60 min of calling)'        AS room_held_setpoint_minus_tol,
       final_held_min || ' of ' || final_eval_min || ' min'                          AS room_held_final_hour,
       round(final_worst_deficit_f::numeric, 1)                                      AS final_hour_worst_room_minus_sp_f,
       round(rise_f_per_h::numeric, 2)                                               AS room_rise_f_per_h,
       snapshots                                                                      AS room_snapshots_used,
       round(min_room_f::numeric, 1) || ' -> ' || round(max_room_f::numeric, 1)      AS room_f_range_while_calling,
       round(setpoint_seen_f::numeric, 1)                                            AS setpoint_f,
       round(mean_tank_f::numeric, 1)                                                AS mean_supply_delivered_tank_f,
       round(mean_curve_f::numeric, 1)                                               AS mean_curve_in_force_f,
       round(mean_reported_target_f::numeric, 1)                                     AS mean_hbx_reported_target_f,
       round(mean_tempiq_ceiling_f::numeric, 1)                                      AS mean_tempiq_ceiling_f,
       round(mean_local_model_f::numeric, 1)                                         AS mean_a2w_local_model_f,
       round(mean_awt_floor_f::numeric, 1)                                           AS mean_awt_floor_f,
       round(min_outdoor_f::numeric, 1)                                              AS min_outdoor_f,
       round(mean_outdoor_calling_f::numeric, 1)                                     AS mean_outdoor_while_calling_f,
       hbx_backup_called,
       element_drew_power                                                            AS element_ran,
       round(element_w_max::numeric)                                                 AS element_w_max,
       round(mean_hp1_w::numeric) || ' / ' || round(mean_hp2_w::numeric)             AS mean_hp1_hp2_w_while_calling,
       'INCONCLUSIVE if the zone called < ' || :min_call || ' min, outdoor never fell below ' || :max_out
         || ' F, or < 2 room snapshots after the first 60 min. '
         || 'A2W ADEQUATE if room >= setpoint - ' || :hold_tol || ' F for >= 80% of evaluated minutes after the first 60 min of calling. '
         || 'A2W TOO COLD if the final hour sits >= 2 F below setpoint and the room is not rising (<= 0.5 F/h). '
         || 'Otherwise inconclusive. Element ran = HBX backup_called or Buffer Tank >= ' || :element_w
         || ' W; it does not change the verdict but means the supply was not heat-pump-only.'   AS rule
FROM judged;
\x off
SQL
} | "${PSQL[@]}"
