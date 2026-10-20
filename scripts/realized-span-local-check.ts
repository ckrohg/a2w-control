/**
 * @purpose Regression check for the realized-savings ENERGY BASIS (deep dive 2026-10-19 §4.1): span_energy holds
 * SPAN's DAY-cumulative pump kWh per hour, so Store.getRealizedDayInputs must report a day's spanKwh as that day's
 * MAX row — never the sum of 24 running totals, which inflated every metered day ~14x (686.1 kWh stored for the
 * 49.9 kWh of 2026-10-18). Replays the real 2026-10-18 hourly series through the live writer (upsertSpanEnergyHour,
 * several polls per hour, one out of order) on a LOCAL Postgres, plus the start of the next local day, and asserts:
 * spanKwh == the day's max, the day boundary is America/New_York (the 20:00–23:00 ET rows are not pushed into the
 * next UTC day), a day without span rows reads null, and computeDayRealized carries the number through as
 * actualElecKwh with energyMetered = true.
 * Never touches production (the analyze-local.sh rule): needs LOCAL_DATABASE_URL and refuses anything not loopback.
 *
 * Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_realized_check npx tsx ../scripts/realized-span-local-check.ts
 * (createdb a2w_realized_check first; the check TRUNCATEs span_energy and slx_readings.)
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { computeDayRealized, CUTOVER } from "../planner/src/realized";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local database only): ${(e as Error).message}`);
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;

// The real series from the 2026-10-18 restore (local hours 00..23): SPAN's running total for the day.
const OCT18 = [0, 0.88, 4.73, 8.64, 12.59, 14.1, 16.45, 20.14, 23.93, 27.68, 31.85, 33.91, 35.01, 35.93, 37, 37.97,
  38.94, 39.96, 41.7, 42.67, 42.77, 43.39, 45.87, 49.94];
const OCT18_SUM = OCT18.reduce((a, b) => a + b, 0); // 686.1 — what the ledger stored
const NEXT_DAY = [0, 0.9, 2.1, 3.4]; // 00..03 of the following local day, then a 23:00 reading
const NEXT_DAY_TOTAL = 30;

const TZ = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
function etParts(d: Date): { day: string; hour: number } {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
/** The UTC instant at which America/New_York reads `day` `hour`:`minute` (EDT or EST, whichever applies). */
function etInstant(day: string, hour: number, minute = 0): Date {
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hour + off, minute));
    const p = etParts(d);
    if (p.day === day && p.hour === hour) return d;
  }
  throw new Error(`no ET instant for ${day} ${hour}:00`);
}
const near = (a: number | null | undefined, b: number, tol = 0.02) => a != null && Math.abs(a - b) <= tol;

async function main(): Promise<void> {
  await store.ensureSchema();
  await pool.query(`TRUNCATE span_energy, slx_readings`);

  // three local days inside the lookback: C (no span rows), A (the Oct-18 series), B (the next day)
  const dayA = etParts(new Date(Date.now() - 3 * 86_400_000)).day;
  const dayB = etParts(new Date(etInstant(dayA, 12).getTime() + 24 * 3_600_000)).day;
  const dayC = etParts(new Date(etInstant(dayA, 12).getTime() - 24 * 3_600_000)).day;
  assert.ok(dayA > CUTOVER, `fixture day ${dayA} must be after the ledger cutover ${CUTOVER}`);

  // the realized engine only sees days slx_readings reported: 5-min rows all day (A: full coverage)
  for (const day of [dayC, dayA, dayB]) {
    await pool.query(
      `INSERT INTO slx_readings (ts, tank_f, tank_target_f, outdoor_f)
       SELECT g, 120, 125, 50 FROM generate_series($1::timestamptz, $2::timestamptz, interval '5 minutes') g
       ON CONFLICT DO NOTHING`,
      [etInstant(day, 0), etInstant(day, 23, 55)]);
  }

  // replay the spanwatch poll: within each hour the running total climbs; the writer keeps the hour's max
  // even when a poll lands out of order (the :45 reading arrives after the :59 one)
  let prev = 0;
  for (let h = 0; h < 24; h++) {
    const v = OCT18[h];
    for (const [minute, k] of [[1, 0.1], [30, 0.5], [59, 1], [45, 0.75]] as const) {
      await store.upsertSpanEnergyHour(etInstant(dayA, h, minute), prev + (v - prev) * k);
    }
    prev = v;
  }
  for (let h = 0; h < NEXT_DAY.length; h++) await store.upsertSpanEnergyHour(etInstant(dayB, h, 30), NEXT_DAY[h]);
  await store.upsertSpanEnergyHour(etInstant(dayB, 23, 30), NEXT_DAY_TOTAL);
  const stored = await pool.query(`SELECT count(*)::int AS n, round(sum(kwh)::numeric, 1)::float8 AS s FROM span_energy`);
  assert.equal(stored.rows[0].n, 24 + NEXT_DAY.length + 1, "one row per hour, whatever the number of polls");

  const rows = await store.getRealizedDayInputs(CUTOVER, 45);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const a = byDay.get(dayA), b = byDay.get(dayB), c = byDay.get(dayC);
  assert.ok(a && b && c, `all three fixture days must be reported (got ${rows.map((r) => r.day).join(", ")})`);

  // 1. the day's energy is its MAX running total — not the 686.1 the ledger carried for Oct 18
  assert.ok(near(a.spanKwh, 49.94), `day A spanKwh must be the day's max 49.94, got ${a.spanKwh}`);
  assert.ok(!near(a.spanKwh, OCT18_SUM, 1) && (a.spanKwh as number) < 60, `day A must not be the sum of running totals (${OCT18_SUM.toFixed(1)})`);
  assert.equal(a.coverage, 1, "288 five-minute rows = full coverage");

  // 2. the bucket is the LOCAL day: A's 20:00–23:00 ET rows (00:00–03:00 UTC next day) stay with A, and B
  //    reads its own total — under UTC bucketing B would inherit 49.94 and A would stop at 42.67
  assert.ok(near(b.spanKwh, NEXT_DAY_TOTAL), `day B spanKwh must be its own max ${NEXT_DAY_TOTAL}, got ${b.spanKwh}`);

  // 3. no span rows → null (the engine then falls back to dailyKwhFallback × coverage)
  assert.equal(c.spanKwh, null, "a day without span rows reads null, not 0");

  // 4. end to end: the engine books the metered number as the day's actual electricity
  const P = { rateUsdKwh: 0.30, uaBtuHrF: 25, ambientF: 70, dailyKwhFallback: 11.8 };
  const ra = computeDayRealized(a, P);
  assert.equal(ra.energyMetered, true);
  assert.equal(ra.actualElecKwh, 49.9, `actualElecKwh must be the metered 49.9, got ${ra.actualElecKwh}`);
  const rc = computeDayRealized(c, P);
  assert.equal(rc.energyMetered, false);
  assert.equal(rc.actualElecKwh, 11.8, "unmetered full day falls back to the SPAN daily average");

  await pool.query(`TRUNCATE span_energy, slx_readings`);
  console.log(`realized-span-local-check: all assertions passed (day ${dayA}: max ${a.spanKwh} vs sum ${OCT18_SUM.toFixed(1)})`);
}

main().then(() => store.close(), async (e) => { console.error(e); await store.close(); process.exit(1); });
