/**
 * @purpose stale-slx-target-2026-10-19.md: prove the SQL half of the stale-report handling against a LOCAL scratch
 * Postgres (never prod, never the a2w_local restore — this TRUNCATEs slx_readings, hbx_config_versions and
 * plan_scores). Replays the real 2026-10-19 14:00–19:00 ET series (soak 141/137 at 14:09, the 120/118 curve at
 * 15:04, the 129/125 bank at :19 every hour; SensorLinx reported 139.9 °F throughout while the tank coasted 141 → 128
 * with no call after 15:04) shifted onto the last six completed hours, then asserts:
 *   - hourlyActuals: the soak hour and the 15:xx hour (a call, tank above the threshold) are NOT stale; 16:xx–18:xx
 *     ARE, with commanded_f = the curve in force at each sample's outdoor (≈119.5 for 120/118 dot 28 wwsd 125 at 54 °F,
 *     128.x for 129/125) and the report still 139.9;
 *   - windowStats compliance: a probe commanded at 128 °F over a stale hour is 1.0 (the device is on the command),
 *     the soak hour against 140 °F is ≥ 0.9 (its first sample predates the soak), a stale hour against 110 °F is 0;
 *   - upsertPlanScore persists commanded_target_f + reported_stale and the gap on the operative basis.
 * Run from planner/:  createdb a2w_stale_check && LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_stale_check npx tsx ../scripts/stale-target-local-check.ts
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { STALE_TANK_MARGIN_DEFAULT_F } from "../planner/src/stale-target";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) { console.error(`refusing: LOCAL_DATABASE_URL ${(e as Error).message}`); process.exit(2); }
if (!/_check(\?|$)/.test(url)) { console.error("refusing: the database name must end in _check (this harness TRUNCATEs slx_readings / hbx_config_versions / plan_scores)"); process.exit(2); }
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;

// [minutes after 14:00 ET, tank_f, tank_target_f, outdoor_f, hd_active, stages_called, backup_called] — slx_readings, mirror a2w-db-2026-10-20T014442Z
const READINGS: Array<[number, number, number, number, boolean, boolean[], boolean]> = [
  [4,119.9,119.5,53.7,true,[false,false],false],[9,119.8,119.5,53.9,true,[false,false],false],[14,118.2,139.9,54,true,[false,true],false],[19,120.9,139.9,54.1,true,[false,true],false],[24,126,139.9,54,true,[false,true],false],[29,129.7,139.9,53.9,true,[false,true],false],[34,132.7,139.9,53.9,true,[false,true],false],[39,137.8,139.9,53.8,true,[false,true],false],[44,142.6,139.9,53.8,true,[false,false],false],[49,142.7,139.9,53.8,true,[false,false],false],[54,141.9,139.9,54,true,[false,false],false],[59,140.6,139.9,54.2,true,[false,false],false],
  [64,141,139.9,54.3,true,[false,true],false],[69,141.3,139.9,54.3,true,[false,false],false],[74,140.7,139.9,54.4,true,[false,false],false],[79,139.8,139.9,54.4,true,[false,false],false],[84,136.8,139.9,54.4,true,[false,false],false],[89,133.9,139.9,54.5,true,[false,false],false],[94,132.9,139.9,54.5,true,[false,false],false],[99,132.5,139.9,54.5,true,[false,false],false],[104,132.1,139.9,54.5,true,[false,false],false],[109,131.7,139.9,54.5,true,[false,false],false],[114,131.5,139.9,54.4,true,[false,false],false],[119,131.1,139.9,54.4,true,[false,false],false],
  [124,130.9,139.9,54.3,true,[false,false],false],[129,130.2,139.9,54.3,true,[false,false],false],[134,130.1,139.9,54.2,true,[false,false],false],[139,130.1,139.9,54.2,true,[false,false],false],[144,130.1,139.9,54.2,true,[false,false],false],[149,130.1,139.9,54,true,[false,false],false],[154,130.1,139.9,54,true,[false,false],false],[159,130.1,139.9,54,true,[false,false],false],[164,130,139.9,53.8,true,[false,false],false],[169,129.8,139.9,53.8,true,[false,false],false],[174,129.8,139.9,53.6,true,[false,false],false],[179,129.8,139.9,53.4,true,[false,false],false],
  [184,129.6,139.9,53.3,true,[false,false],false],[189,129.6,139.9,53.1,true,[false,false],false],[194,129.6,139.9,52.7,true,[false,false],false],[199,129.6,139.9,52.5,true,[false,false],false],[204,129.4,139.9,52.4,true,[false,false],false],[209,129.2,139.9,52.4,true,[false,false],false],[214,129.2,139.9,52.4,true,[false,false],false],[219,129.2,139.9,52.4,true,[false,false],false],[224,129.2,139.9,52.4,true,[false,false],false],[229,129,139.9,52.4,true,[false,false],false],[234,129,139.9,52.4,true,[false,false],false],[239,128.8,139.9,52.2,true,[false,false],false],
  [244,128.7,139.9,52,true,[false,false],false],[249,128.5,139.9,51.9,true,[false,false],false],[254,128.5,139.9,51.9,true,[false,false],false],[259,128.4,139.9,51.7,true,[false,false],false],[264,130.7,139.9,51.3,true,[false,false],false],[269,130.6,139.9,50.9,true,[false,false],false],[274,130.5,139.9,50.5,true,[false,false],false],[279,130.4,139.9,50.1,true,[false,false],false],[284,130.3,139.9,49.9,true,[false,false],false],[289,130.3,139.9,49.9,true,[false,false],false],[294,130.2,139.9,49.7,true,[false,false],false],[299,130.1,139.9,49.3,true,[false,false],false],
];
// [minutes after 14:00 ET, dbt, mbt, dot, wwsd, htDif] — hbx_config_versions (planner writes), same mirror
const VERSIONS: Array<[number, number, number, number, number, number]> = [
  [-336,120,118,30,125,4],[9,141,137,30,125,4],[64,120,118,28,125,4],[79,129,125,28,125,4],[124,120,118,28,125,4],[139,129,125,28,125,4],[184,120,118,28,125,4],[204,129,125,28,125,4],[244,120,118,30,125,4],[259,129,125,30,125,4],
];

async function main() {
  await store.ensureSchema();
  await pool.query(`TRUNCATE slx_readings, hbx_config_versions, plan_scores`);
  // Shift the replay so its 14:00 lands six completed hours before now (hourlyActuals reads completed hours only).
  const base = new Date(); base.setMinutes(0, 0, 0); base.setTime(base.getTime() - 6 * 3600_000);
  const at = (min: number) => new Date(base.getTime() + min * 60_000);
  for (const [min, dbt, mbt, dot, wwsd, htDif] of VERSIONS) {
    await pool.query(`INSERT INTO hbx_config_versions (observed_at, changed_fields, config) VALUES ($1, $2, $3)`,
      [at(min), JSON.stringify({ dbt: { new: dbt } , _source: "autopilot:replay" }), JSON.stringify({ dbt, mbt, dot, wwsd, htDif })]);
  }
  for (const [min, tank, target, outdoor, hd, stages, backup] of READINGS) {
    await store.insertReading({ ts: at(min), tankF: tank, tankTargetF: target, outdoorF: outdoor, hdActive: hd, cdActive: false, stagesCalled: stages, backupCalled: backup, relays: 16, connected: true });
  }

  // 1. hourlyActuals
  const hours = await store.hourlyActuals(8);
  const byOffset = new Map(hours.map((h) => [Math.round((h.hour.getTime() - base.getTime()) / 3600_000), h]));
  const h14 = byOffset.get(0)!, h15 = byOffset.get(1)!, h16 = byOffset.get(2)!, h17 = byOffset.get(3)!, h18 = byOffset.get(4)!;
  assert.ok(h14 && h15 && h16 && h17 && h18, `expected hours 0..4 of the replay, got ${[...byOffset.keys()].join(",")}`);
  assert.equal(h14.samples, 12);
  assert.equal(h14.reportedStale, false, "the soak hour calls — not stale");
  assert.equal(h15.reportedStale, false, "15:xx has the 15:04 call and the tank above the threshold until 15:24 — not stale");
  for (const [name, h] of [["16", h16], ["17", h17], ["18", h18]] as const) {
    assert.equal(h.reportedStale, true, `${name}:xx is provably stale (idle, demand, tank 128–131 against a 139.9 report)`);
    assert.ok(Math.abs((h.targetF ?? 0) - 139.9) < 0.05, `${name}:xx reported stays 139.9 (got ${h.targetF})`);
    // 3 samples on the 120/118 curve (≈119.5 at 54 °F) + 9 on 129/125 (≈128.3) → ≈126.1; 18:xx sees 129/125 from :19 at dot 30
    assert.ok((h.commandedF ?? 0) > 124 && (h.commandedF ?? 0) < 128, `${name}:xx commanded is the curve in force, averaged (got ${h.commandedF})`);
  }
  // the curve output follows the sample's outdoor exactly as shadow.ts curveTargetF: at 15:09 the 120/118 dot 28
  // wwsd 125 curve is in force (the 129/125 bank lands at 15:19) → 120 + (54.3 − 28)(118 − 120)/(125 − 28) = 119.458
  const cmd69 = await pool.query(`
    SELECT (v.config->>'dbt')::float8 + ($2::float8 - (v.config->>'dot')::float8) * ((v.config->>'mbt')::float8 - (v.config->>'dbt')::float8) / ((v.config->>'wwsd')::float8 - (v.config->>'dot')::float8) AS f
    FROM hbx_config_versions v WHERE v.observed_at <= $1 ORDER BY v.id DESC LIMIT 1`, [at(69), 54.3]);
  assert.ok(Math.abs(Number(cmd69.rows[0].f) - 119.458) < 0.01, `curve math in SQL matches curveTargetF (got ${cmd69.rows[0].f})`);
  // and at 15:34 the bank curve 129/125 dot 28 at 54.5 °F = 127.907 — the harness's own expectation was once wrong here
  const cmd94 = await pool.query(`
    SELECT (v.config->>'dbt')::float8 + ($2::float8 - (v.config->>'dot')::float8) * ((v.config->>'mbt')::float8 - (v.config->>'dbt')::float8) / ((v.config->>'wwsd')::float8 - (v.config->>'dot')::float8) AS f
    FROM hbx_config_versions v WHERE v.observed_at <= $1 ORDER BY v.id DESC LIMIT 1`, [at(94), 54.5]);
  assert.ok(Math.abs(Number(cmd94.rows[0].f) - 127.907) < 0.01, `got ${cmd94.rows[0].f}`);

  // 2. windowStats compliance
  const stale128 = await store.windowStats(at(120), at(180), 128);
  assert.equal(stale128.samples, 12);
  assert.equal(stale128.compliance, 1, `a 128 °F probe over the stale 16:xx hour is fully compliant (got ${stale128.compliance})`);
  const stale120 = await store.windowStats(at(120), at(180), 120);
  assert.equal(stale120.compliance, 1, "…and so is the 120 °F curve itself (tank 130 ≥ 120 − margin)");
  const soak140 = await store.windowStats(at(0), at(60), 140);
  assert.ok(Math.abs((soak140.compliance ?? 0) - 10 / 12) < 0.01, `the soak hour against 140 °F: 10 of 12 samples report 139.9, the 14:04/14:09 samples predate it and are LIVE reports of 119.5 (got ${soak140.compliance})`);
  // The proof can only DISPROVE the report, never the command: with the tank satisfied at 130 °F an idle device is
  // consistent with any command below it, and the single-writer invariant leaves no third candidate. So a far-lower
  // command is credited too — that is a statement about the evidence, not a loophole.
  const stale110 = await store.windowStats(at(120), at(180), 110);
  assert.equal(stale110.compliance, 1);
  // A sample with a call is scored by its report (the report is live while calling): the soak hour against 120 °F = 2/12.
  const soak120 = await store.windowStats(at(0), at(60), 120);
  assert.ok(Math.abs((soak120.compliance ?? 0) - 2 / 12) < 0.01, `got ${soak120.compliance}`);
  // A command whose own call threshold the tank sits BELOW is not credited: the device heats to neither value.
  const stale135 = await store.windowStats(at(120), at(180), 135);
  assert.equal(stale135.compliance, 0, `135 °F: tank 130 < 135 − ${STALE_TANK_MARGIN_DEFAULT_F} with no call — not on the command either (got ${stale135.compliance})`);
  // Within tolerance of the report itself is compliant as before.
  assert.equal((await store.windowStats(at(120), at(180), 140)).compliance, 1);

  // 3. plan_scores: the operative basis, both values kept
  const shadowF = 120;
  for (const h of [h15, h16]) {
    const operativeF = h.reportedStale && h.commandedF != null ? h.commandedF : h.targetF;
    await store.upsertPlanScore({ hourTs: h.hour, shadowTargetF: shadowF, actualTargetF: h.targetF, actualTankF: h.tankF, gapF: operativeF == null ? null : operativeF - shadowF, planComputedAt: new Date(), commandedTargetF: h.commandedF, reportedStale: h.reportedStale });
  }
  const rows = (await pool.query(`SELECT hour_ts, actual_target_f, commanded_target_f, reported_stale, gap_f FROM plan_scores ORDER BY hour_ts`)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reported_stale, false); assert.ok(Math.abs(Number(rows[0].gap_f) - 19.9) < 0.05, `15:xx still scores the live-ish report: +19.9 (got ${rows[0].gap_f})`);
  assert.equal(rows[1].reported_stale, true);
  assert.ok(Math.abs(Number(rows[1].actual_target_f) - 139.9) < 0.05, "the report is kept");
  assert.ok(Number(rows[1].gap_f) > 4 && Number(rows[1].gap_f) < 8, `16:xx scores the curve in force: ≈ +6, not +19.9 (got ${rows[1].gap_f})`);
  assert.ok(Math.abs(Number(rows[1].commanded_target_f) - Number(rows[1].gap_f) - shadowF) < 0.05, "gap = commanded − shadow when stale");
  // re-upsert of an older-shape score (no new fields) leaves NULLs, not a crash
  await store.upsertPlanScore({ hourTs: h14.hour, shadowTargetF: 140, actualTargetF: h14.targetF, actualTankF: h14.tankF, gapF: null, planComputedAt: new Date() });
  const legacy = (await pool.query(`SELECT commanded_target_f, reported_stale FROM plan_scores WHERE hour_ts = $1`, [h14.hour])).rows[0];
  assert.equal(legacy.commanded_target_f, null); assert.equal(legacy.reported_stale, null);

  console.log("stale-target-local-check: all assertions passed");
  console.log(`  16:xx reported ${h16.targetF?.toFixed(1)} / commanded ${h16.commandedF?.toFixed(1)} / stale ${h16.reportedStale}; compliance(128)=${stale128.compliance} compliance(135)=${stale135.compliance}; gap16=${Number(rows[1].gap_f).toFixed(1)}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
