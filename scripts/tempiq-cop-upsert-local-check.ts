/**
 * @purpose Proof for Store.insertTempiqCopPoints as an UPSERT (TempIQv2#2124: TempIQ defers a COP point until the
 * charge's end is observable and re-upserts its overlap day, so a mirrored row can change after it was first seen).
 * Against a LOCAL Postgres it asserts: a new PK inserts; the identical row re-sent is neither inserted nor updated;
 * a changed field updates (value → value, null → value, value → null, a quality string); the updated values are what
 * getCopAnchor then reads (the winter DP's anchor follows the completed row, not the provisional one); and
 * latestTempiqCopAt still reports the newest measured_at.
 * Never touches production (the analyze-local.sh rule): needs LOCAL_DATABASE_URL and refuses anything not loopback.
 *
 * Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_cop_check npx tsx ../scripts/tempiq-cop-upsert-local-check.ts
 * (createdb a2w_cop_check first; the check TRUNCATEs tempiq_cop_points.)
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local database only): ${(e as Error).message}`);
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any>; end: () => Promise<void> } }).pool;

// Recent timestamps so getCopAnchor(days) sees them; two systems sharing one timestamp (the page-boundary case).
const t0 = new Date(Date.now() - 2 * 24 * 3600_000);
const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
const point = (h: number, system: string, over: Partial<{ outdoorTempF: number | null; sinkTempF: number | null; cop: number | null; thermalKwh: number | null; electricalKwh: number | null; quality: string | null; qualityScore: number | null }> = {}) => ({
  measuredAt: at(h), system, outdoorTempF: 40, sinkTempF: 125, cop: 2.0, thermalKwh: 4.0, electricalKwh: 2.0,
  quality: "high", qualityScore: 0.8, ...over,
});

async function main() {
  await store.ensureSchema();
  await pool.query(`TRUNCATE tempiq_cop_points`);

  // 1. three new PKs insert — two of them share a timestamp (different systems)
  let r = await store.insertTempiqCopPoints([point(0, "heat_pump:hp1"), point(0, "heat_pump:hp2"), point(1, "heat_pump:hp1")]);
  assert.deepEqual(r, { inserted: 3, updated: 0 }, `first insert: ${JSON.stringify(r)}`);

  // 2. the identical rows re-sent (TempIQ re-upserts its overlap day): nothing inserted, nothing updated
  r = await store.insertTempiqCopPoints([point(0, "heat_pump:hp1"), point(0, "heat_pump:hp2"), point(1, "heat_pump:hp1")]);
  assert.deepEqual(r, { inserted: 0, updated: 0 }, `unchanged re-send: ${JSON.stringify(r)}`);

  // 3. a completed row: a deferred/short charge finished later with more thermal energy and a better score
  r = await store.insertTempiqCopPoints([point(1, "heat_pump:hp1", { thermalKwh: 6.0, cop: 3.0, qualityScore: 0.9 })]);
  assert.deepEqual(r, { inserted: 0, updated: 1 }, `completed row: ${JSON.stringify(r)}`);
  let row = (await pool.query(`SELECT cop, thermal_kwh, quality_score FROM tempiq_cop_points WHERE system = 'heat_pump:hp1' AND measured_at = $1`, [at(1)])).rows[0];
  assert.equal(Number(row.cop), 3);
  assert.equal(Number(row.thermal_kwh), 6);
  assert.ok(Math.abs(Number(row.quality_score) - 0.9) < 1e-6);

  // 4. null → value, value → null and a quality-string change each count as an update (row-wise IS DISTINCT FROM)
  r = await store.insertTempiqCopPoints([point(2, "heat_pump:hp2", { sinkTempF: null })]);
  assert.deepEqual(r, { inserted: 1, updated: 0 });
  r = await store.insertTempiqCopPoints([point(2, "heat_pump:hp2", { sinkTempF: 130 })]);
  assert.deepEqual(r, { inserted: 0, updated: 1 }, "null → value is a change");
  r = await store.insertTempiqCopPoints([point(2, "heat_pump:hp2", { sinkTempF: 130, qualityScore: null })]);
  assert.deepEqual(r, { inserted: 0, updated: 1 }, "value → null is a change");
  r = await store.insertTempiqCopPoints([point(2, "heat_pump:hp2", { sinkTempF: 130, qualityScore: null, quality: "medium" })]);
  assert.deepEqual(r, { inserted: 0, updated: 1 }, "quality string change");
  r = await store.insertTempiqCopPoints([point(2, "heat_pump:hp2", { sinkTempF: 130, qualityScore: null, quality: "medium" })]);
  assert.deepEqual(r, { inserted: 0, updated: 0 }, "and re-sending that state is unchanged again");
  row = (await pool.query(`SELECT sink_temp_f, quality, quality_score FROM tempiq_cop_points WHERE system = 'heat_pump:hp2' AND measured_at = $1`, [at(2)])).rows[0];
  assert.equal(Number(row.sink_temp_f), 130);
  assert.equal(row.quality, "medium");
  assert.equal(row.quality_score, null);

  // 5. a mixed batch reports both counts
  r = await store.insertTempiqCopPoints([
    point(3, "heat_pump:hp1"),                          // new
    point(4, "heat_pump:hp1"),                          // new
    point(0, "heat_pump:hp1", { electricalKwh: 2.5 }), // changed
    point(0, "heat_pump:hp2"),                          // unchanged
  ]);
  assert.deepEqual(r, { inserted: 2, updated: 1 }, `mixed batch: ${JSON.stringify(r)}`);

  // 6. the anchor reads the COMPLETED values: energy-weighted COP over the 6 rows now in the window
  const rows = (await pool.query(`SELECT thermal_kwh AS q, electrical_kwh AS e FROM tempiq_cop_points`)).rows;
  assert.equal(rows.length, 6);
  const expected = rows.reduce((a: number, x: any) => a + Number(x.q), 0) / rows.reduce((a: number, x: any) => a + Number(x.e), 0);
  const anchor = await store.getCopAnchor(7);
  assert.ok(anchor, "6 quality rows ≥ the 5-session floor");
  assert.equal(anchor!.sessions, 6);
  assert.ok(Math.abs(anchor!.cop - expected) < 1e-5, `anchor cop ${anchor!.cop} vs ${expected}`);
  assert.ok(anchor!.cop > 2.0 && anchor!.cop < 3.0, "the completed 6 kWh / 2 kWh row lifted the pooled COP above the provisional 2.0");

  // 7. latestTempiqCopAt is the newest measured_at (the overlap window is computed from it)
  const newest = await store.latestTempiqCopAt();
  assert.equal(newest?.toISOString(), at(4).toISOString());

  console.log("ok tempiq-cop-upsert-local-check: insert / unchanged / completed-row update / null transitions / mixed batch / anchor follows the update / newest");
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
