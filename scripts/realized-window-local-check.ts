/**
 * @purpose Regression check for the realized-savings WINDOW EDGE. Store.getRealizedDayInputs buckets rows by
 * America/New_York day, so its lookback cutoff must be a LOCAL MIDNIGHT, not the moving instant now() − N days: with
 * the instant, the day the cutoff fell in came back with only its remaining minutes of rows, and because
 * computeAndStore runs hourly that partial recompute was the LAST one a day ever got — the ledger kept
 * 2026-08-28 … 09-03 as 0.2 kWh / modeled / energy_metered=false, one per night (2026-10-20 restore). The cutover had
 * the same flaw at the fixed edge: cast as timestamptz it is midnight in the SESSION zone (UTC on Railway), 20:00
 * EDT the evening before, hence the 4-hour "2026-07-15" row.
 * On a LOCAL Postgres this builds complete local days on both sides of a 45-day window's edge and of the cutover
 * (288 slx rows, 24 span hours, 3 COP sessions each), then asserts: every day returned is complete, the day before
 * each edge is absent — a day is fully recomputed or not returned, never partial. Fails on the previous SQL at any
 * time of day. Never touches production (the analyze-local.sh rule): needs LOCAL_DATABASE_URL, refuses non-loopback.
 *
 * Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_realized_window_check npx tsx ../scripts/realized-window-local-check.ts
 * (createdb a2w_realized_window_check first; the check TRUNCATEs slx_readings, span_energy and tempiq_cop_points.)
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { CUTOVER } from "../planner/src/realized";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local database only): ${(e as Error).message}`);
  process.exit(2);
}
// Railway's Postgres sessions run in UTC; a local Postgres often runs in America/New_York, where the old cutover cast
// happened to look right. Pin the session zone to UTC (libpq startup `options`) so the check sees what production sees.
const store = new Store(url + (url.includes("?") ? "&" : "?") + "options=-c%20TimeZone%3DUTC");
const pool = (store as unknown as { pool: import("pg").Pool }).pool;

const TZ = "America/New_York";
const LOOKBACK = 45;
const SPAN_TOTAL = (h: number, scale: number) => +((h + 1) * scale).toFixed(2); // SPAN's day-cumulative counter at hour h (never 0)
type DayRow = Awaited<ReturnType<Store["getRealizedDayInputs"]>>[number];

/** One complete local day: 5-min slx rows, the hourly span counter through the live writer, three COP sessions. */
async function completeDay(day: string, spanScale: number): Promise<{ slxRows: number }> {
  const slx = await pool.query(
    `INSERT INTO slx_readings (ts, tank_f, tank_target_f, outdoor_f)
     SELECT g AT TIME ZONE $2, 120, 125, 50
     FROM generate_series($1::date::timestamp, $1::date::timestamp + interval '23:55', interval '5 minutes') g
     ON CONFLICT DO NOTHING`, [day, TZ]);
  const hours = await pool.query<{ h: number; at: Date }>(
    `SELECT h, ($1::date::timestamp + make_interval(hours => h, mins => 30)) AT TIME ZONE $2 AS at FROM generate_series(0, 23) h`, [day, TZ]);
  for (const r of hours.rows) await store.upsertSpanEnergyHour(r.at, SPAN_TOTAL(r.h, spanScale));
  await pool.query(
    `INSERT INTO tempiq_cop_points (measured_at, system, outdoor_temp_f, sink_temp_f, cop, thermal_kwh, electrical_kwh, quality_score)
     SELECT ($1::date::timestamp + t) AT TIME ZONE $2, 'hp1', 50, 140, 2.5, 5, 2, 0.9
     FROM unnest(ARRAY['00:10', '12:00', '23:50']::interval[]) t ON CONFLICT DO NOTHING`, [day, TZ]);
  return { slxRows: slx.rowCount ?? 0 };
}

/** The returned row for `day` must carry ALL of the day's fixture rows — the whole point of the check. `ref` is the
 *  same day's row from a run whose window starts long before it: the edge day must come out identical, span
 *  aggregate included (main sums span_energy per day; #207 changes that to max — this check is agnostic). */
function assertComplete(rows: DayRow[], day: string, slxRows: number, label: string, ref?: DayRow): void {
  const r = rows.find((x) => x.day === day);
  assert.ok(r, `${label} ${day} must be returned (got ${rows.map((x) => x.day).join(", ") || "nothing"})`);
  assert.equal(r.coverage, Math.min(1, slxRows / 288), `${label} ${day}: coverage must reflect all ${slxRows} slx rows, got ${r.coverage} — a partial day`);
  assert.equal(r.measured?.sessions, 3, `${label} ${day}: all 3 COP sessions (00:10, 12:00, 23:50) must be in, got ${r.measured?.sessions ?? 0}`);
  if (ref) assert.deepEqual(r, ref, `${label} ${day}: must equal the row computed with the day deep inside the window`);
  else assert.ok(r.spanKwh != null && r.spanKwh > 0, `${label} ${day}: the day's span rows must be in`);
}

async function main(): Promise<void> {
  await store.ensureSchema();
  assert.equal((await pool.query(`SHOW timezone`)).rows[0].TimeZone, "UTC", "the session zone must be UTC, as on Railway");
  await pool.query(`TRUNCATE slx_readings, span_energy, tempiq_cop_points`);

  // 1. The moving edge: the local day that now() − 45 days falls in. Build it and its neighbours, complete.
  const edge = await pool.query<{ before: string; edge: string; after: string }>(
    `SELECT to_char(d - 1, 'YYYY-MM-DD') AS before, to_char(d, 'YYYY-MM-DD') AS edge, to_char(d + 1, 'YYYY-MM-DD') AS after
     FROM (SELECT (date_trunc('day', now() AT TIME ZONE $2) - ($1 || ' days')::interval)::date AS d) x`, [LOOKBACK, TZ]);
  const { before, edge: edgeDay, after } = edge.rows[0];
  assert.ok(before > CUTOVER, `fixture days must be after the cutover ${CUTOVER} (edge ${edgeDay})`);
  const fx = { [before]: await completeDay(before, 1.5), [edgeDay]: await completeDay(edgeDay, 2), [after]: await completeDay(after, 1) };

  // reference: the same three days with the window starting years earlier — nothing near an edge
  const ref = await store.getRealizedDayInputs(CUTOVER, 10_000);
  for (const d of [before, edgeDay, after]) assertComplete(ref, d, fx[d].slxRows, "reference");

  const rows = await store.getRealizedDayInputs(CUTOVER, LOOKBACK);
  assert.ok(!rows.some((r) => r.day === before), `${before} lies before the window and must not be returned at all`);
  assertComplete(rows, edgeDay, fx[edgeDay].slxRows, "edge day", ref.find((r) => r.day === edgeDay)); // the day the old cutoff sliced
  assertComplete(rows, after, fx[after].slxRows, "day after edge", ref.find((r) => r.day === after));
  assert.deepEqual(rows.map((r) => r.day), [edgeDay, after], "exactly the two complete days inside the window");

  // 2. The fixed edge: the cutover is a LOCAL day. With a UTC session the old cast let the evening before in.
  await pool.query(`TRUNCATE slx_readings, span_energy, tempiq_cop_points`);
  const dayBeforeCutover = (await pool.query<{ d: string }>(`SELECT to_char($1::date - 1, 'YYYY-MM-DD') AS d`, [CUTOVER])).rows[0].d;
  const cfx = { [dayBeforeCutover]: await completeDay(dayBeforeCutover, 1.5), [CUTOVER]: await completeDay(CUTOVER, 2) };
  const wide = await store.getRealizedDayInputs(CUTOVER, 10_000); // the one-off wide recompute (REALIZED_LOOKBACK_DAYS)
  assert.ok(!wide.some((r) => r.day === dayBeforeCutover), `${dayBeforeCutover} precedes the cutover and must not be returned (old cast: 20:00–24:00 EDT slice)`);
  assertComplete(wide, CUTOVER, cfx[CUTOVER].slxRows, "cutover day");
  assert.deepEqual(wide.map((r) => r.day), [CUTOVER], "the wide recompute starts exactly at the cutover day");

  await pool.query(`TRUNCATE slx_readings, span_energy, tempiq_cop_points`);
  console.log(`realized-window-local-check: all assertions passed (window edge ${edgeDay} complete, ${before} absent; cutover ${CUTOVER} complete, ${dayBeforeCutover} absent)`);
}

main().then(() => store.close(), async (e) => { console.error(e); await store.close(); process.exit(1); });
