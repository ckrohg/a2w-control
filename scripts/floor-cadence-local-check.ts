/**
 * @purpose #136: exercise Store.raiseLatestPlanBlock against a LOCAL Postgres (never prod): the raise
 * applies, a lower value is refused, two overlapping raises leave the maximum, a bank/boost flag the
 * floor overtakes is dropped, the meta records every raise. Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/floor-cadence-local-check.ts
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: LOCAL_DATABASE_URL must point at localhost");
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;

async function main() {
  await store.ensureSchema();
  const ts = new Date(Date.now() - 20 * 60_000); ts.setMinutes(0, 0, 0);
  const tsIso = ts.toISOString();
  const plan = [
    { ts: tsIso, outdoor_f: 30, tank_target_f: 120, hp1_setpoint_f: 125, reason: "DHW window floor" },
    { ts: new Date(ts.getTime() + 3600_000).toISOString(), outdoor_f: 29, tank_target_f: 124, hp1_setpoint_f: 129, reason: "afternoon bank to 124°F", bank: true },
  ];
  await store.insertShadowPlan(plan, { local_check: true });
  const latestId = async () => (await pool.query(`SELECT id FROM shadow_plans ORDER BY computed_at DESC LIMIT 1`)).rows[0].id;
  const block = async (id: number) => (await pool.query(`SELECT plan, meta FROM shadow_plans WHERE id = $1`, [id])).rows[0];
  const id = await latestId();

  // 1. a raise applies, records meta, keeps other blocks byte-identical
  const r1 = await store.raiseLatestPlanBlock(tsIso, { tank_target_f: 128, hp1_setpoint_f: 133, reason: "binding zone: bb needs 124°F (re-check)" }, { at: "t1" });
  assert.equal(r1.applied, true); assert.equal(r1.planId, id);
  let row = await block(id);
  assert.equal(row.plan[0].tank_target_f, 128); assert.equal(row.plan[0].hp1_setpoint_f, 133);
  assert.match(row.plan[0].reason, /re-check/);
  assert.deepEqual(row.plan[1], plan[1], "the other block is untouched");
  assert.equal(row.meta.floor_raises.length, 1); assert.equal(row.meta.floor_raises[0].to, 128);

  // 2. raises only: a lower or equal value is refused and changes nothing
  const r2 = await store.raiseLatestPlanBlock(tsIso, { tank_target_f: 125, hp1_setpoint_f: 130, reason: "stale" }, { at: "t2" });
  assert.equal(r2.applied, false);
  row = await block(id);
  assert.equal(row.plan[0].tank_target_f, 128); assert.equal(row.meta.floor_raises.length, 1, "a refused raise records nothing");

  // 3. two overlapping raises: the maximum wins, both attempts are serialised by the row lock
  const [a, b] = await Promise.all([
    store.raiseLatestPlanBlock(tsIso, { tank_target_f: 132, hp1_setpoint_f: 137, reason: "A" }, { at: "A" }),
    store.raiseLatestPlanBlock(tsIso, { tank_target_f: 130, hp1_setpoint_f: 135, reason: "B" }, { at: "B" }),
  ]);
  row = await block(id);
  assert.equal(row.plan[0].tank_target_f, 132, "the higher raise stands whatever the order");
  assert.ok(a.applied, "the higher raise always applies");
  assert.equal(row.meta.floor_raises.filter((x: any) => x.to === 132).length, 1);
  if (b.applied) assert.equal(row.meta.floor_raises.some((x: any) => x.to === 130), true, "B applied first, then A overtook it");

  // 4. a floor that overtakes a bank drops the flag (one identity per block)
  const ts2 = plan[1].ts;
  const r4 = await store.raiseLatestPlanBlock(ts2, { tank_target_f: 130, hp1_setpoint_f: 135, reason: "binding zone: bb (re-check)" }, { at: "t4" });
  assert.equal(r4.applied, true);
  row = await block(id);
  assert.equal(row.plan[1].bank, undefined); assert.equal(row.plan[1].tank_target_f, 130);

  // 5. unknown ts → nothing
  const r5 = await store.raiseLatestPlanBlock("2000-01-01T00:00:00.000Z", { tank_target_f: 200, hp1_setpoint_f: 205, reason: "x" }, {});
  assert.equal(r5.applied, false);

  await pool.query(`DELETE FROM shadow_plans WHERE id = $1`, [id]);
  console.log("floor-cadence-local-check: all assertions passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
