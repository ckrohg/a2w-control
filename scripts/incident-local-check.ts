/**
 * @purpose Incident fixes 2026-10-16 (#183, #185, #187): exercise the new store SQL against a LOCAL Postgres with the
 * real table shapes — the storm_events sweep (every open row closes; orphans at their own windowEnd), the alert-
 * episode outbox, fault codes from the mirror's pump_snapshots, and the SPAN-local latest-per-circuit read from
 * span_readings (absent tables → the documented empty answers). Never touches production: refuses any URL whose
 * effective host is not loopback (planner/src/local-db.ts).
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/incident-local-check.ts
 * (createdb a2w_local first if needed; the check TRUNCATEs storm_events / alert_episodes and drops/recreates
 * pump_snapshots + span_readings.) Exits non-zero on any failed assertion.
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
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;

async function main() {
  await store.ensureSchema();
  await store.ensureSchema(); // idempotent

  // ── #183: the storm sweep ──────────────────────────────────────────────────────────────────────────────────────
  await pool.query(`TRUNCATE storm_events RESTART IDENTITY`);
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  await pool.query(
    `INSERT INTO storm_events (started_at, trigger, detail, ceiling_f) VALUES
       ($1, 'nws:Winter Storm Warning', jsonb_build_object('windowEnd', $2::text), 135),   -- orphan, window long over
       ($3, 'forecast:<10F',            jsonb_build_object('windowEnd', $4::text), 135),   -- orphan
       ($5, 'manual',                   jsonb_build_object('windowEnd', $6::text), 135),   -- the live one, window ahead
       ($7, 'odd',                      jsonb_build_object('windowEnd', 'not a date'), NULL), -- malformed windowEnd
       ($8, 'closed long ago',          NULL, NULL)`,
    [iso(now - 21 * day), iso(now - 20 * day), iso(now - 19 * day), iso(now - 18.5 * day),
     iso(now - 3_600_000), iso(now + 6 * 3_600_000), iso(now - 2 * day), iso(now - 30 * day)]);
  await pool.query(`UPDATE storm_events SET ended_at = started_at + interval '1 hour' WHERE trigger = 'closed long ago'`);
  const closed = await store.closeStormEvents("planner restart while idle");
  assert.equal(closed, 4, "every open row closes — not just max(id)");
  const rows = (await pool.query(`SELECT trigger, started_at, ended_at, detail FROM storm_events ORDER BY id`)).rows;
  assert.ok(rows.every((r: any) => r.ended_at != null), "nothing left open");
  assert.equal(new Date(rows[0].ended_at).toISOString(), iso(now - 20 * day), "an orphan ends at its own windowEnd, not today");
  assert.equal(new Date(rows[1].ended_at).toISOString(), iso(now - 18.5 * day));
  assert.ok(Math.abs(new Date(rows[2].ended_at).getTime() - Date.now()) < 60_000, "the live window ends now");
  assert.ok(Math.abs(new Date(rows[3].ended_at).getTime() - Date.now()) < 60_000, "a malformed windowEnd ends now (no cast error)");
  assert.equal(rows[0].detail.closed, "planner restart while idle");
  assert.equal(rows[0].detail.windowEnd, iso(now - 20 * day), "detail kept, note merged");
  assert.equal(rows[4].detail, null, "an already-closed row is untouched");
  assert.equal(await store.closeStormEvents("stand-down"), 0, "idempotent");
  // the STARTUP sweep is scoped to rows started before boot: a storm this process armed meanwhile stays open
  const boot = new Date(Date.now() - 60_000);
  await pool.query(`INSERT INTO storm_events (started_at, trigger, detail) VALUES ($1, 'orphan', NULL), (now(), 'armed by this process', NULL)`, [iso(now - 3_600_000)]);
  assert.equal(await store.closeStormEvents("planner restart while idle", boot), 1);
  const live = (await pool.query(`SELECT trigger, ended_at FROM storm_events WHERE trigger IN ('orphan', 'armed by this process') ORDER BY id`)).rows;
  assert.deepEqual(live.map((r: any) => [r.trigger, r.ended_at != null]), [["orphan", true], ["armed by this process", false]]);
  // a stand-down at 10:00 whose close only lands at 11:00 still ends the row at 10:00 (codex pass 6)
  await pool.query(`TRUNCATE storm_events RESTART IDENTITY`);
  const standDown = new Date(now - 3_600_000);
  await pool.query(`INSERT INTO storm_events (started_at, trigger, detail) VALUES ($1, 'manual', jsonb_build_object('windowEnd', $2::text))`,
    [iso(now - 3 * 3_600_000), iso(now + 3_600_000)]);
  assert.equal(await store.closeStormEvents("stand-down", standDown, standDown), 1);
  const ended = (await pool.query(`SELECT ended_at FROM storm_events`)).rows[0].ended_at;
  assert.equal(new Date(ended).toISOString(), standDown.toISOString(), "ended at the stand-down, not at the retry");

  // ── #185 / #187: the alert-episode outbox ─────────────────────────────────────────────────────────────────────
  await pool.query(`TRUNCATE alert_episodes RESTART IDENTITY`);
  const f = await store.openAlertEpisode("fault_called", "2", "pump2", "⚠ Stage 2 called but Heat Pump 2 is FAULTED", "E21");
  const u = await store.openAlertEpisode("stage_unserved", "2", "pump2", "⚠ Stage 2 called 10 min but Heat Pump 2 is not heating", "…");
  await store.openAlertEpisode("span_local_stale", "span", null, "⚠ SPAN local stream stale", "…");
  assert.deepEqual((await store.undeliveredAlertEpisodes()).map((x) => x.id), [1, 2, 3], "nothing acknowledged yet → all in the outbox");
  await store.markAlertNotified(f);
  assert.deepEqual((await store.undeliveredAlertEpisodes()).map((x) => x.id), [u, 3]);
  const recur = await store.openAlertEpisode("fault_called", "2", "pump2", "⚠ again", "E21");
  await store.closeAlertEpisodeIds([f, 3]);
  assert.deepEqual((await store.openAlertEpisodes()).map((x) => x.id), [u, recur], "closes exactly the IDs given — a recurrence stays open");
  await store.closeAlertEpisodeIds([recur]);
  await store.closeAlertEpisodeIds([]);
  assert.deepEqual((await store.openAlertEpisodes()).map((x) => [x.kind, x.key]), [["stage_unserved", "2"]], "a restart re-adopts what is still open");
  assert.deepEqual((await store.undeliveredAlertEpisodes()).map((x) => x.id), [u], "a cleared episode leaves the outbox");
  assert.deepEqual(await store.alertEpisodes24h(), { fault_called: 2, stage_unserved: 1, span_local_stale: 1 });

  // ── #185: fault codes from pump_snapshots (the mirror's latest-only full snapshot) ────────────────────────────────
  await pool.query(`DROP TABLE IF EXISTS pump_snapshots`);
  assert.deepEqual(await store.pumpFaultCodes(), {}, "absent table → {}");
  await pool.query(`CREATE TABLE pump_snapshots (pump_id TEXT PRIMARY KEY, ts DOUBLE PRECISION NOT NULL, name TEXT, snapshot JSONB NOT NULL)`);
  await pool.query(`INSERT INTO pump_snapshots (pump_id, ts, name, snapshot) VALUES
    ('pump2', 1792000000, 'Heat Pump 2', '{"state":"fault","active_faults":[{"key":"x","code":"E21","message":"Display controller lost communication","severity":"warning"},{"key":"y","code":"P17","message":"anti-freeze","severity":"info"},{"key":"z","code":"E21","severity":"warning"}]}'),
    ('pump1', 1792000000, 'Heat Pump 1', '{"state":"idle","active_faults":[]}')`);
  assert.deepEqual(await store.pumpFaultCodes(), { pump2: { codes: ["E21"], ts: 1792000000 }, pump1: { codes: [], ts: 1792000000 } },
    "non-info codes, de-duplicated; P17 anti-freeze (info) is not a fault");

  // ── #187: SPAN local latest per circuit ────────────────────────────────────────────────────────────────────────
  await pool.query(`DROP TABLE IF EXISTS span_readings`);
  const nowS = Date.now() / 1000;
  assert.equal(await store.spanLocalLatest(nowS), null, "absent table → null (rehearsal DB)");
  await pool.query(`CREATE TABLE span_readings (id BIGSERIAL PRIMARY KEY, source_id BIGINT UNIQUE, ts DOUBLE PRECISION NOT NULL, circuit_id TEXT, name TEXT NOT NULL, power_w REAL)`);
  assert.deepEqual(await store.spanLocalLatest(nowS), {}, "empty table → {}");
  await pool.query(`INSERT INTO span_readings (source_id, ts, name, power_w) VALUES
    (1, $1, 'Buffer Tank', 0), (2, $2, 'Buffer Tank', 0), (3, $3, 'Air-Water 1', 2100),
    (4, $4, 'Air-Water 2', 7), (5, $5, 'Old circuit', 0), (6, $6, 'Air-Water 1', 2200)`,
    [nowS - 60, nowS - 25, nowS - 40, nowS - 3_600, nowS - 2 * 86_400, nowS + 3_600]);
  const latest = await store.spanLocalLatest(nowS);
  assert.deepEqual(Object.keys(latest ?? {}).sort(), ["Air-Water 1", "Air-Water 2", "Buffer Tank", "Old circuit"], "every circuit, at any age");
  assert.equal(latest?.["Buffer Tank"], nowS - 25);
  assert.equal(latest?.["Old circuit"], nowS - 2 * 86_400, "a 2-day-old circuit keeps its honest age (codex pass 1)");
  assert.equal(latest?.["Air-Water 1"], nowS - 40, "a sample stamped an hour in the future is ignored");
  // a planner started during a 2-day outage: every circuit is old → the newest sample is 2 days old
  await pool.query(`DELETE FROM span_readings WHERE ts > $1`, [nowS - 2 * 86_400 + 1]);
  assert.deepEqual(await store.spanLocalLatest(nowS), { "Old circuit": nowS - 2 * 86_400 });

  console.log("incident-local-check: all assertions passed");
}

main().then(() => store.close(), (e) => { console.error(e); process.exitCode = 1; return store.close(); });
