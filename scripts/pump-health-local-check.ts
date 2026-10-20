/**
 * @purpose Pump health: prove the store SQL behind pumphealth.ts against a LOCAL Postgres before it runs on the live
 * planner. Covers the window reads over the mirror's own table shapes (analytics-mirror/lib/db.ts readings +
 * span_readings), the real fixture replayed through them (SPAN NEGATIVE watts preserved), the daily jsonb round-trip,
 * the digest claim, the shadow-episode exclusions on alert_episodes (the paging outbox must never re-send a shadow
 * row), and the shadow outbox itself. Never touches production (the analyze-local.sh rule): needs LOCAL_DATABASE_URL and
 * refuses anything that is not localhost.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_pumphealth npx tsx ../scripts/pump-health-local-check.ts
 * (createdb a2w_pumphealth first; the check DROPs/recreates readings + span_readings and TRUNCATEs the pump-health tables,
 * slx_readings and alert_episodes.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { AlertOutbox } from "../planner/src/alerts";
import { evaluatePump, rollupDay, episodeKind, PH, type PumpReading, type SpanSample } from "../planner/src/pumphealth";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local database only): ${(e as Error).message}`);
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;

async function main(): Promise<void> {
  await store.ensureSchema();
  await pool.query(`DROP TABLE IF EXISTS readings; DROP TABLE IF EXISTS span_readings;
    CREATE TABLE readings (id BIGSERIAL PRIMARY KEY, ts DOUBLE PRECISION NOT NULL, pump_id TEXT NOT NULL, name TEXT, online BOOLEAN,
      state TEXT, mode_kind TEXT, setpoint_c REAL, inlet_c REAL, outlet_c REAL, ambient_c REAL, power_w REAL, active_faults INT, error_rate REAL);
    CREATE INDEX idx_readings_pump_ts ON readings (pump_id, ts);
    CREATE TABLE span_readings (id BIGSERIAL PRIMARY KEY, source_id BIGINT UNIQUE, ts DOUBLE PRECISION NOT NULL, circuit_id TEXT, name TEXT NOT NULL, power_w REAL);
    CREATE INDEX idx_span_readings_name_ts ON span_readings (name, ts);
    TRUNCATE pump_health_daily, pump_health_digests, slx_readings, alert_episodes;`);

  // the real fixture, shifted so it ends "now"
  const fx = JSON.parse(readFileSync(new URL("../planner/fixtures/pumphealth-20261018.json", import.meta.url), "utf8"));
  const end = Math.max(...fx.readings.pump1.map((r: number[]) => r[0]));
  const shift = Math.floor(Date.now() / 1000) - end;
  for (const p of ["pump1", "pump2"]) {
    const rows = fx.readings[p] as [number, string, number, number, number][];
    await pool.query(`INSERT INTO readings (ts, pump_id, online, state, inlet_c, outlet_c, ambient_c)
      SELECT t, $2, true, s, i, o, a FROM UNNEST($1::float8[], $3::text[], $4::real[], $5::real[], $6::real[]) AS x(t, s, i, o, a)`,
      [rows.map((r) => r[0] + shift), p, rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4])]);
  }
  let sid = 1;
  for (const n of ["Air-Water 1", "Air-Water 2"]) {
    const rows = fx.span[n] as [number, number][];
    await pool.query(`INSERT INTO span_readings (source_id, ts, name, power_w) SELECT sid, t, $2, w FROM UNNEST($1::float8[], $3::real[], $4::bigint[]) AS x(t, w, sid)`,
      [rows.map((r) => r[0] + shift), n, rows.map((r) => r[1]), rows.map(() => sid++)]);
  }

  // 1. window reads: ascending, scoped, NEGATIVE watts preserved; the replay over SQL matches the replay over the fixture
  const nowPi = Math.floor(Date.now() / 1000);
  const rd = await store.pumpReadingsWindow(["pump1", "pump2"], nowPi - PH.LOOKBACK_S, nowPi + 60);
  const sp = await store.spanWindow(["Air-Water 1", "Air-Water 2"], nowPi - PH.LOOKBACK_S, nowPi + 60);
  assert.ok(rd && sp);
  assert.ok(rd!.pump1.length >= 75 && rd!.pump1.length <= 85, `pump1 readings in the 80-min lookback: ${rd!.pump1.length}`);
  assert.ok(rd!.pump1.every((r, i, a) => i === 0 || a[i - 1].ts <= r.ts), "ascending");
  assert.ok(sp!["Air-Water 1"].some((s) => (s.power_w ?? 0) < 0) || sp!["Air-Water 1"].every((s) => Math.abs(s.power_w ?? 0) < 20), "raw sign preserved");
  const direct = (p: string, n: string): [PumpReading[], SpanSample[]] => [
    (fx.readings[p] as [number, string, number, number, number][]).map(([ts, state, i, o, a]) => ({ ts: ts + shift, online: true, state, inlet_c: i, outlet_c: o, ambient_c: a })),
    (fx.span[n] as [number, number][]).map(([ts, w]) => ({ ts: ts + shift, power_w: w })),
  ];
  // the stuck defrost, through the SQL path: 02:40Z of the fixture day
  const stuck = Date.parse("2026-10-18T02:40:00Z") / 1000 + shift;
  const rdS = await store.pumpReadingsWindow(["pump1"], stuck - PH.LOOKBACK_S, stuck);
  const spS = await store.spanWindow(["Air-Water 1"], stuck - PH.LOOKBACK_S, stuck);
  const viaSql = evaluatePump("pump1", rdS!.pump1, spS!["Air-Water 1"], stuck);
  const [dr, ds] = direct("pump1", "Air-Water 1");
  const viaFx = evaluatePump("pump1", dr.filter((r) => r.ts >= stuck - PH.LOOKBACK_S && r.ts <= stuck), ds.filter((s) => s.ts >= stuck - PH.LOOKBACK_S && s.ts <= stuck), stuck);
  assert.deepEqual(viaSql.map((v) => [v.kind, v.state]), viaFx.map((v) => [v.kind, v.state]), "SQL path = fixture path");
  assert.equal(viaSql.find((v) => v.kind === "defrost_overlong")!.state, "tripped", "the stuck defrost trips through the SQL path");

  // 2. the daily rollup: jsonb round trip
  const m = rollupDay(dr, ds, dr[0].ts, dr[dr.length - 1].ts + 1);
  await store.upsertPumpHealthDay("2026-10-18", "pump1", m);
  await store.upsertPumpHealthDay("2026-10-18", "pump1", { ...m, starts: m.starts + 1 }); // upsert, not a second row
  const days = await store.pumpHealthDays("2026-10-01");
  assert.equal(days.length, 1); assert.equal(days[0].day, "2026-10-18"); assert.equal(days[0].m.starts, m.starts + 1);
  assert.deepEqual(days[0].m.bins, m.bins, "bins survive jsonb");

  // 3. tank window: boolean[] round trip, epoch seconds
  await pool.query(`INSERT INTO slx_readings (ts, tank_f, stages_called) VALUES (now() - interval '10 minutes', 118.5, ARRAY[true,false]), (now() - interval '5 minutes', 119, NULL)`);
  const tank = await store.tankWindow(new Date(Date.now() - 3_600_000));
  assert.equal(tank.length, 2); assert.deepEqual(tank[0].stages_called, [true, false]); assert.equal(tank[1].stages_called, null);
  assert.ok(Math.abs(tank[0].ts - (Date.now() / 1000 - 600)) < 5);

  // 4. digest claim: one claimant; a failed send gives it back; a sent claim is never released
  assert.equal(await store.claimPumpDigest("2026-10-18"), true);
  assert.equal(await store.claimPumpDigest("2026-10-18"), false, "a second instance never double-sends");
  await store.releasePumpDigest("2026-10-18");
  assert.equal(await store.claimPumpDigest("2026-10-18"), true, "released → claimable again");
  await store.markPumpDigestSent("2026-10-18");
  await store.releasePumpDigest("2026-10-18");
  assert.equal(await store.claimPumpDigest("2026-10-18"), false, "a sent digest is never released");

  // 5. shadow episodes: the paging outbox's re-send query never sees them; the digest list does
  await store.openAlertEpisode("u-shadow", episodeKind("defrost_overlong", false), "pump1", "pump1", "stuck in defrost (shadow)", "d");
  await store.openAlertEpisode("u-live", episodeKind("idle_draw", true), "pump2", "pump2", "idle but drawing power", "d");
  await store.openAlertEpisode("u-stage", "stage_unserved", "2", "pump2", "stage 2 unserved", "d");
  await store.openAlertEpisode("u-pumpkin", "pumpkin_spice", "x", null, "not pump health", "d");
  const undelivered = (await store.undeliveredAlertEpisodes()).map((x) => x.kind).sort();
  assert.deepEqual(undelivered, ["pump_idle_draw", "pumpkin_spice", "stage_unserved"], "shadow_* is never re-sent as a page");
  const eps = (await store.pumpHealthEpisodes24h()).map((x) => x.kind).sort();
  assert.deepEqual(eps, ["pump_idle_draw", "shadow_pump_defrost_overlong"], "the digest lists shadow + live pump episodes only");

  // 6. the shadow outbox: its "channel" is the log — the row is marked, and a retry never forwards a live row
  const logged: string[] = [];
  const shadow = new AlertOutbox(store, async (t) => { logged.push(t); return true; }, () => {});
  await shadow.open(episodeKind("running_no_lift", false), "pump1", "pump1", "no lift (shadow)", "b");
  assert.deepEqual(logged, ["no lift (shadow)"]);
  assert.equal(await shadow.retry(() => false), 0, "retry(() => false) forwards nothing — the live idle_draw row stays the paging outbox's");
  assert.deepEqual(logged, ["no lift (shadow)"]);
  const r = await pool.query(`SELECT notified_at IS NOT NULL AS n FROM alert_episodes WHERE kind = 'shadow_pump_running_no_lift'`);
  assert.equal(r.rows[0].n, true);
  await shadow.close(episodeKind("running_no_lift", false), "pump1");
  const c = await pool.query(`SELECT cleared_at IS NOT NULL AS c FROM alert_episodes WHERE kind = 'shadow_pump_running_no_lift'`);
  assert.equal(c.rows[0].c, true);

  console.log("pump-health-local-check: all assertions passed");
}

main().then(() => store.close(), async (e) => { console.error(e); await store.close(); process.exit(1); });
