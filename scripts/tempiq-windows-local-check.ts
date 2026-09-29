/**
 * @purpose a2w#137: exercise the poster's FOUR store queries against a LOCAL Postgres with a synthetic
 * history, so the SQL is proven before it runs on the live planner. Never touches production (the
 * analyze-local.sh rule): it needs LOCAL_DATABASE_URL and refuses anything that is not localhost.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/tempiq-windows-local-check.ts
 * (createdb a2w_local first if needed.) Exits non-zero on any failed assertion.
 *
 * Scenario (all UTC, 2026-09-28 — a day in the past, because an open window's stats run to now()):
 *   10:00 autopilot set 128   (reason "DHW window floor")        → window A, closed by B at 10:30
 *   10:30 autopilot set 140   (reason "daily sanitize …")        → window B (sanitize), closed by restore at 11:30
 *   11:30 boost-expiry restore                                    → closes B, opens nothing
 *   12:00 dashboard set 130   (storm armed 11:50–12:55, boost row) → window C (storm), closed by FOREIGN dbt change 12:40
 *   13:00 dashboard set 125   (no correlates)                      → window D (manual), OPEN (newest, no closer)
 *   Rejected/failed rows are sprinkled in and must be ignored. slx_readings every 5 min 10:00–13:30 with
 *   tank_target_f adopting the commanded target 10 min after each write (compliance < 1 is expected).
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { callingZoneIds } from "../planner/src/tempiq-windows";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: LOCAL_DATABASE_URL must point at localhost (this check is for a local snapshot only)");
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;
const at = (hhmm: string) => new Date(`2026-09-28T${hhmm}:00Z`);

async function main() {
  await store.ensureSchema();
  await pool.query(`TRUNCATE hbx_writes, hbx_config_versions, autopilot_log, storm_events, hbx_boosts, slx_readings, zone_floor_snapshots, tempiq_window_posts RESTART IDENTITY`);

  const w = (ts: Date, source: string, action: string, requested: unknown, result: string, detail: string) =>
    pool.query(`INSERT INTO hbx_writes (ts, source, action, requested, result, detail) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ts, source, action, JSON.stringify(requested), result, detail]).then((r) => Number(r.rows[0].id));
  const det = (t: number) => `target ${t}°F commanded (curve ${t + 2}/${t - 2} → ${t}°F output at 50°F outdoor; adopts on the next reheat cycle)`;

  const A = await w(at("10:00"), "autopilot", "set_target", { dbt: 130, mbt: 126 }, "accepted", det(128));
  await w(at("10:10"), "autopilot", "set_target", { target_f: 150 }, "rejected", "target 150°F outside the I4 envelope [118–135]°F at 50°F outdoor");
  const B = await w(at("10:30"), "autopilot", "set_target", { dbt: 142, mbt: 138 }, "accepted", det(140));
  await w(at("11:00"), "dashboard", "set_target", { dbt: 132, mbt: 128 }, "failed", "SensorLinx write failed: 502");
  const R = await w(at("11:30"), "boost-expiry", "restore", { dbt: 165, mbt: 140 }, "accepted", "as-found curve restored (165/140°F)");
  const C = await w(at("12:00"), "dashboard", "set_target", { dbt: 132, mbt: 128 }, "accepted", det(130));
  const D = await w(at("13:00"), "dashboard", "set_target", { dbt: 127, mbt: 123 }, "accepted", det(125));

  // autopilot_log: a 'set' row a few ms after each autopilot write; a stale unrelated one earlier.
  await pool.query(`INSERT INTO autopilot_log (ts, target_f, reason, result, dry_run) VALUES
    ($1, 120, 'off-window DHW-ready floor (draws possible any hour)', 'set', false),
    ($2, 128, 'DHW window floor', 'set', false),
    ($3, 140, 'daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)', 'set', false)`,
    [at("09:00"), new Date(at("10:00").getTime() + 40), new Date(at("10:30").getTime() + 40)]);
  // storm window armed 11:50–12:55 (covers C, not D — the end bound is inclusive, so ending it AT
  // 13:00 would rightly label D too); boost row created by C.
  await pool.query(`INSERT INTO storm_events (started_at, ended_at, trigger, detail, ceiling_f) VALUES ($1,$2,'manual','{}',135)`, [at("11:50"), at("12:55")]);
  await pool.query(`INSERT INTO hbx_boosts (created_at, target_f, restore_at, restored) VALUES ($1, 130, $2, true)`, [new Date(at("12:00").getTime() + 120), at("13:00")]);
  // FOREIGN dbt change at 12:40 (no _source) — closes C; our own self-recorded versions carry _source.
  await pool.query(`INSERT INTO hbx_config_versions (observed_at, changed_fields, config) VALUES
    ($1, '{"dbt":{"old":165,"new":130},"mbt":{"old":140,"new":126},"_source":"autopilot:set_target"}', '{}'),
    ($2, '{"dbt":{"old":132,"new":150},"mbt":{"old":128,"new":146}}', '{}'),
    ($3, NULL, '{}')`, [at("10:00"), at("12:40"), at("09:00")]);
  // Readings every 5 min; the operative target adopts each commanded value 10 min after the write.
  const commandedAt = (t: Date): number | null => {
    const m = t.getTime();
    if (m >= at("13:10").getTime()) return 125;
    if (m >= at("12:10").getTime()) return 130;
    if (m >= at("11:40").getTime()) return 152; // restored as-found (outside any window)
    if (m >= at("10:40").getTime()) return 140;
    if (m >= at("10:10").getTime()) return 128;
    return 120;
  };
  for (let t = at("10:00").getTime(); t <= at("13:30").getTime(); t += 5 * 60_000) {
    const ts = new Date(t);
    const tgt = commandedAt(ts)!;
    await pool.query(`INSERT INTO slx_readings (ts, tank_f, tank_target_f, outdoor_f, hd_active, cd_active, stages_called, backup_called, relays, connected)
      VALUES ($1, $2, $3, $4, true, false, '{true,false}', false, 0, true)`, [ts, tgt - 1.5, tgt, 45 + (t - at("10:00").getTime()) / 3_600_000 * 4]);
  }
  await pool.query(`INSERT INTO zone_floor_snapshots (ts, zones, binding_zone, binding_awt_f, tank_target_f, source) VALUES ($1, $2, 'z-lr', 124, 128, 'insights+calls')`,
    [at("09:58"), JSON.stringify([{ zoneId: "z-lr", calling: true, awtF: 124 }, { zoneId: "z-kit", calling: false, awtF: 110 }, { zoneId: "z-ms", calling: true, awtF: null }])]);

  // ── pendingCurveWrites: the episode rules ──
  const pending = await store.pendingCurveWrites(500);
  const ids = pending.map((p) => p.id);
  assert.deepEqual(ids, [A, B, R, C, D], `accepted curve writes only, in order: ${JSON.stringify(ids)}`);
  const by = new Map(pending.map((p) => [p.id, p]));
  assert.equal(by.get(A)!.closedAt?.toISOString(), at("10:30").toISOString(), "A closed by B");
  assert.equal(by.get(A)!.commandedTargetF, 128);
  assert.equal(by.get(A)!.reason, "DHW window floor");
  assert.equal(by.get(B)!.closedAt?.toISOString(), at("11:30").toISOString(), "B closed by the restore");
  assert.match(by.get(B)!.reason ?? "", /sanitize/);
  assert.equal(by.get(R)!.action, "restore");
  assert.equal(by.get(C)!.closedAt?.toISOString(), at("12:40").toISOString(), "C closed by the FOREIGN dbt change, not by D");
  assert.equal(by.get(C)!.stormActive, true);
  assert.equal(by.get(C)!.boostMatched, true);
  assert.equal(by.get(C)!.reason, null, "dashboard writes do not borrow the autopilot's reason");
  assert.equal(by.get(D)!.closedAt, null, "D is the newest — still our curve, OPEN");
  assert.equal(by.get(D)!.stormActive, false);
  assert.equal(by.get(D)!.boostMatched, false);

  // ── windowStats: dose + adoption compliance + outdoor band ──
  const sA = await store.windowStats(at("10:00"), at("10:30"), 128);
  assert.equal(sA.samples, 6);
  // 10:00,10:05 still at 120 → 4 of 6 within 3 °F of 128
  assert.ok(Math.abs(sA.compliance! - 4 / 6) < 1e-9, `compliance ${sA.compliance}`);
  assert.ok(Math.abs(sA.achievedAwtF! - (2 * 118.5 + 4 * 126.5) / 6) < 1e-6, `achieved ${sA.achievedAwtF}`);
  assert.ok(sA.outdoorLowF! >= 45 && sA.outdoorHighF! <= 47.1, `band ${sA.outdoorLowF}–${sA.outdoorHighF}`);
  const sD = await store.windowStats(at("13:00"), null, 125); // open → until now
  assert.equal(sD.samples, 7, "13:00..13:30 inclusive = 7 samples");
  const sNull = await store.windowStats(at("13:00"), null, null);
  assert.equal(sNull.compliance, null, "no commanded target → no compliance claim");

  // ── zoneFloorSnapshotNear + callingZoneIds ──
  assert.deepEqual(callingZoneIds(await store.zoneFloorSnapshotNear(at("10:00"))), ["z-lr"]);
  assert.equal(await store.zoneFloorSnapshotNear(at("12:00")), null, "nothing within ±15 min");

  // ── markWindowPosts + the pending filter (posted-open stays out until a closer exists) ──
  await store.markWindowPosts(pending.map((p) => ({
    writeId: p.id, externalId: `a2w-hbx-write-${p.id}`, kind: p.action === "restore" ? "restore" : "x",
    closedAt: p.action === "restore" ? p.ts : p.closedAt, lastError: null,
  })));
  const after = await store.pendingCurveWrites(500);
  assert.deepEqual(after.map((p) => p.id), [], `everything posted; the open D waits for a closer: ${JSON.stringify(after.map((p) => p.id))}`);
  // A new write closes D → D becomes pending again (to be re-posted closed), plus the new write itself.
  const E = await w(at("13:40"), "autopilot", "set_target", { dbt: 124, mbt: 120 }, "accepted", det(122));
  const again = await store.pendingCurveWrites(500);
  assert.deepEqual(again.map((p) => p.id), [D, E]);
  assert.equal(again[0].closedAt?.toISOString(), at("13:40").toISOString());
  // Re-marking D closed is an upsert on the same write_id.
  await store.markWindowPosts([{ writeId: D, externalId: `a2w-hbx-write-${D}`, kind: "manual", closedAt: at("13:40"), lastError: null }]);
  const row = await pool.query(`SELECT closed_at FROM tempiq_window_posts WHERE write_id = $1`, [D]);
  assert.equal(new Date(row.rows[0].closed_at).toISOString(), at("13:40").toISOString());
  // A rejection is recorded with its error.
  await store.markWindowPosts([{ writeId: E, externalId: `a2w-hbx-write-${E}`, kind: "autopilot", closedAt: new Date(), lastError: "ended_before_started" }]);
  const err = await pool.query(`SELECT last_error FROM tempiq_window_posts WHERE write_id = $1`, [E]);
  assert.equal(err.rows[0].last_error, "ended_before_started");
  assert.deepEqual((await store.pendingCurveWrites(500)).map((p) => p.id), [], "a recorded rejection leaves the pending set");

  console.log("tempiq-windows-local-check: all assertions passed");
}

main().then(() => store.close(), (e) => { console.error(e); process.exitCode = 1; return store.close(); });
