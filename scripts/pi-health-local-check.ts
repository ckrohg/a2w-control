/**
 * @purpose a2w#165: exercise store.piLinkInputs (the SQL reductions behind /health.pi) against a LOCAL Postgres with a
 * synthetic week in the mirror's own table shapes (analytics-mirror/lib/db.ts readings + system_stats), so the gap and
 * reboot SQL is proven before it runs on the live planner. Never touches production (the analyze-local.sh rule): needs
 * LOCAL_DATABASE_URL and refuses anything that is not localhost.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/pi-health-local-check.ts
 * (createdb a2w_local first if needed; the check DROPs/recreates readings + system_stats and TRUNCATEs phase_b_log.)
 *
 * The week (relative to now): readings every 60 s for both pumps and system_stats every 60 s, except —
 *   W1  −4 d 02:00 → 04:10  Phase B "no Pi connected"; readings + stats silent; Pi reboots at 04:06 → gap+reboot
 *   W2  −3 d 05:00 → 07:05  "no Pi connected"; readings silent; uptime keeps counting       → gap_only
 *   W3  −2 d 10:00 → 12:00  "no Pi connected"; readings + stats continue every minute       → socket_only
 * plus a reboot −6 h with no dropout (an owner power-cycle) → reboots_24h = 1, reboots_7d = 2; an NTP step +10 min on
 * the long-running Pi (−1 d 03:00) and a step −10 min (−1 d 15:00) that must NOT count as reboots; and a dropout
 * that began 9 d ago (before the query range) and ended 6 d ago, reported with its real start; and a +30 min clock
 * step 2 min after the power-cycle — ambiguous, never a reboot.
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { piHealth, READING_GAP_MIN_S, BOOT_JUMP_S, CLOCK_STEP_S, DROPOUT_WINDOW_S, LOOKBACK_S, FUTURE_S, SETTLE_S } from "../planner/src/pilink";

const OPTS = { gapS: READING_GAP_MIN_S, bootJumpS: BOOT_JUMP_S, clockStepS: CLOCK_STEP_S, windowS: DROPOUT_WINDOW_S, lookbackS: LOOKBACK_S, futureS: FUTURE_S, settleS: SETTLE_S };

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local database only): ${(e as Error).message}`);
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;

const NOW = Math.floor(Date.now() / 60_000) * 60; // epoch s, whole minute
const H = 3600, D = 86_400;
// windows as [start, end] epoch s
const W1: [number, number] = [NOW - 4 * D + 2 * H, NOW - 4 * D + 4 * H + 600];
const W2: [number, number] = [NOW - 3 * D + 5 * H, NOW - 3 * D + 7 * H + 300];
const W3: [number, number] = [NOW - 2 * D + 10 * H, NOW - 2 * D + 12 * H];
const W4: [number, number] = [NOW - D + 16 * H, NOW - D + 17 * H];           // socket outage while the Pi exports on
const W4_FWD = NOW - D + 16 * H + 1_800;   // the Pi clock steps +600 s mid-outage (readings AND stats)…
const W4_BACK = NOW - D + 17 * H + 1_800;  // …then −1037 s (to −437 s): samples interleave by ts, fractional stamps
// W5: BOTH paths silent 10:00–12:00 (−5 d), no reboot, and the Pi clock comes back 2 h SLOW — the resumed samples
// refill the silent span by ts, so no readings gap survives; a +2 h step 4 h later puts it right (codex pass 4 on #193)
const W5: [number, number] = [NOW - 5 * D + 10 * H, NOW - 5 * D + 12 * H];
const W5_FIX = W5[1] + 4 * H;
// a 5-min +1 h clock FLICK inside W2 (stats only; readings are silent there): displaced samples look like a reboot onto
// a new boot track, then the old track resumes — must stay ambiguous, and W2 becomes unknown (codex pass 5 on #193)
const FLICK: [number, number] = [W2[0] + 30 * 60, W2[0] + 35 * 60];
const offset = (t: number) => (t >= W4_FWD ? (t < W4_BACK ? 600 : -437.25) : 0) + (t >= W5[1] && t < W5_FIX ? -2 * H : 0);
const REBOOT1 = NOW - 4 * D + 4 * H + 360;   // 04:06, inside W1's slack
const REBOOT2 = NOW - 6 * H;                 // the power-cycle
const silent = (t: number, w: [number, number]) => t > w[0] + 60 && t < w[1] - 60;

async function main() {
  await store.ensureSchema();
  // ── 1. mirror tables ABSENT (the rehearsal's fresh DB): mirror-derived fields null, no throw ──────────────────
  await pool.query(`DROP TABLE IF EXISTS readings, system_stats, readings_hidden, system_stats_hidden, readings_full; TRUNCATE phase_b_log RESTART IDENTITY`);
  const bare = await store.piLinkInputs(NOW * 1000, OPTS);
  assert.equal(bare.lastByPump, null);
  assert.equal(bare.readings, null);
  assert.equal(bare.stats, null);
  assert.equal(bare.latestStat, null);
  assert.deepEqual(bare.phaseB, []);

  // ── 2. the mirror's own shapes (analytics-mirror/lib/db.ts) ───────────────────────────────────────────────────
  await pool.query(`CREATE TABLE readings (
    id BIGSERIAL PRIMARY KEY, ts DOUBLE PRECISION NOT NULL, pump_id TEXT NOT NULL, name TEXT, online BOOLEAN,
    state TEXT, mode_kind TEXT, setpoint_c REAL, inlet_c REAL, outlet_c REAL, ambient_c REAL, power_w REAL,
    active_faults INT, error_rate REAL)`);
  await pool.query(`CREATE INDEX ON readings (pump_id, ts)`);
  await pool.query(`CREATE TABLE system_stats (
    ts DOUBLE PRECISION PRIMARY KEY, cpu_pct REAL, load1 REAL, load5 REAL, load15 REAL, ncpu INT,
    mem_used_pct REAL, mem_total_mb INT, mem_avail_mb INT, disk_used_pct REAL, disk_free_gb REAL,
    disk_total_gb REAL, cpu_temp_c REAL, uptime_s REAL)`);
  // readings: both pumps every 60 s for 8 days, silent inside W1 and W2 (the exporter could not push either)
  await pool.query(
    `INSERT INTO readings (ts, pump_id, online, state)
     SELECT t + CASE WHEN t >= $7 AND t < $8 THEN 600 WHEN t >= $8 THEN -437.25 ELSE 0 END
              + CASE WHEN t >= $10 AND t < $11 THEN -7200 ELSE 0 END, p, true, 'heating'
     FROM generate_series($1::bigint, $2::bigint, 60) t, unnest(ARRAY['pump1','pump2']) p
     WHERE NOT (t > $3 + 60 AND t < $4 - 60) AND NOT (t > $5 + 60 AND t < $6 - 60) AND NOT (t > $9 + 60 AND t < $10 - 60)`,
    [NOW - 8 * D, NOW - 30 - 1_800, W1[0], W1[1], W2[0], W2[1], W4_FWD, W4_BACK, W5[0], W5[1], W5_FIX]);
  // system_stats: every 60 s, silent inside W1; boot time jumps at REBOOT1 and REBOOT2 (and the Pi's own clock jitters ±2 s)
  const boot0 = NOW - 30 * D;
  const rows: string[] = [];
  const STEP_FWD = NOW - D + 3 * H, STEP_BACK = NOW - D + 15 * H; // NTP corrections on the long-running Pi
  // a +30 min step 2 min after the power-cycle (REBOOT2): ambiguous by construction — must not count as a reboot
  const FRESH_STEP = REBOOT2 + 120;
  for (let t = NOW - 8 * D; t <= NOW - 30 - 1_800; t += 60) {
    if (silent(t, W1) || silent(t, W5)) continue;
    const boot = t >= REBOOT2 ? REBOOT2 : t >= REBOOT1 ? REBOOT1 : boot0;
    const jitter = (t / 60) % 3 - 1; // −1, 0, +1 s
    // the Pi's CLOCK (ts) steps +600 s at STEP_FWD and back −600 s at STEP_BACK; uptime is unaffected
    const clock = (t >= STEP_FWD && t < STEP_BACK ? 600 : 0) + offset(t) + (t >= FRESH_STEP ? 1_800 : 0)
      + (t >= FLICK[0] && t < FLICK[1] ? 3_600 : 0);
    rows.push(`(${t + clock}, ${t - boot + jitter})`);
  }
  for (let i = 0; i < rows.length; i += 2000) {
    // ON CONFLICT as the mirror's ingest does: the backward step re-stamps ts values already used
    await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${rows.slice(i, i + 2000).join(",")} ON CONFLICT (ts) DO NOTHING`);
  }
  // phase_b_log: both pumps every 5 min, active; "no Pi connected" inside each window, "sent" otherwise; plus noise
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), p, 'active', 55,
            CASE WHEN (t >= $2 AND t < $3) OR (t >= $4 AND t < $5) OR (t >= $6 AND t < $7) OR (t >= $9 AND t < $10)
                   OR (t >= $11 AND t < $12)
                 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $8::bigint, 300) t, unnest(ARRAY['pump1','pump2']) p`,
    [NOW - 8 * D + 600, W1[0], W1[1], W2[0], W2[1], W3[0], W3[1], NOW - 300, W4[0], W4[1], W5[0], W5[1]]);
  // a dropout that began 9 d ago (BEFORE the 8-d query range) and ended 6 d ago: its real start must be recovered
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $3::bigint, 300) t`, [NOW - 10 * D, NOW - 9 * D, NOW - 8 * D + 300]);
  await pool.query(`UPDATE phase_b_log SET result = 'failed: no Pi connected'
                    WHERE ts >= to_timestamp($1) AND ts < to_timestamp($2)`, [NOW - 8 * D, NOW - 6 * D]);
  await pool.query(`INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result) VALUES
    (to_timestamp($1), 'pump1', 'active', 55, 'skipped: no writer lease'),
    (to_timestamp($1), 'pump1', 'dry-run', 55, 'would-send')`, [W2[0] + 900]);

  const inputs = await store.piLinkInputs(NOW * 1000, OPTS);
  assert.deepEqual(Object.keys(inputs.lastByPump ?? {}).sort(), ["pump1", "pump2"]);
  assert.equal(inputs.readings?.gaps.length, 4, `W1, W2, the W4 clock-step artifact and W5's +2 h fix-up step (got ${JSON.stringify(inputs.readings?.gaps)})`);
  const boots = inputs.stats?.boots ?? [];
  assert.equal(boots.length, 2, `exactly the two reboots — jitter, the ±600 s steps and the interleaving −1037 s step ignored (got ${JSON.stringify(boots)})`);
  assert.ok(Math.abs(boots[0].at - REBOOT1) <= 2 && Math.abs(boots[1].at - (REBOOT2 - 437.25)) <= 2, "at the right moments (±2 s clock jitter)");
  assert.ok(inputs.stats!.firstTs! <= NOW - 8 * D + 60, "stats coverage reported from the range start");
  assert.ok((inputs.stats?.ambiguous ?? []).some((b) => Math.abs(b.at - (REBOOT2 - 437.25 + 1_800)) <= 5), `the fresh Pi's +30 min clock step is ambiguous (${JSON.stringify(inputs.stats?.ambiguous)})`);
  assert.ok(inputs.phaseB.every((r) => r.result === "sent" || /no Pi connected/.test(r.result)), "only rows that speak about the Pi");

  // the hub measures the Pi clock aligned now (offset 0) — without that anchor, clock steps in range void every window:
  const unanch = piHealth(inputs, NOW * 1000, null);
  assert.equal(unanch.pi_clock.anchored, false, "no fresh hub frame and the newest reading is old → not anchored (codex passes 16–17)");
  assert.ok(unanch.dropouts_7d.every((w) => w.verdict === "unknown"), "…and every window is unknown, a certain reboot's included");
  const h = piHealth(inputs, NOW * 1000, 0);
  assert.equal(h.pi_clock.anchored, true);
  // This synthetic week is a clock-CHAOS fixture: its stats clock ends ~23 min off its own past (W4 ends −437 s, the
  // fresh-boot +1800 s, never taken back), so relative to the aligned present every window's stamps were off — all
  // unknown (codex passes 15–16), a certain reboot (W1) included. The clean three-verdict proof is the next block.
  assert.deepEqual(h.dropouts_7d.map((w) => w.verdict), ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
    "every window of the clock-chaos week is unknown");
  assert.ok((inputs.stats?.ambiguous ?? []).some((b) => Math.abs(b.at - (REBOOT1 + 3_600)) <= 5),
    `the flick's displaced samples imply REBOOT1 (its track then) + 1 h — an ambiguous jump, not a reboot (${JSON.stringify(inputs.stats?.ambiguous)})`);
  assert.deepEqual(h.dropouts_7d.map((w) => w.minutes), [3 * 24 * 60, 120, 130, 125, 120, 60]);
  assert.equal(inputs.readings?.gaps.some((g) => g.start < W5[1] && g.end > W5[0]), false, "no readings gap survives inside W5 (the trap)");
  assert.ok((inputs.stats?.clockSteps ?? []).some((t) => Math.abs(t - (W4_FWD + 600)) <= 120), "the +600 s step is detected");
  assert.equal(Date.parse(h.dropouts_7d[0].start) / 1000, NOW - 9 * D, "a run open at the range start keeps its real start");
  assert.equal(h.dropouts_7d[3].reboot_at, null, "no reboot invented from the flick");
  assert.equal(h.reboots_24h, 1);
  assert.equal(h.reboots_7d, 2);
  assert.ok(h.last_reading_age_s != null && Math.abs(h.last_reading_age_s - (1_860 + 437)) <= 61, `newest reading: the series ends 30 min early, stamped −437 s (${h.last_reading_age_s})`);
  assert.ok(h.uptime_s != null && Math.abs(h.uptime_s - (6 * H - 1_860)) <= 2, `uptime since the power-cycle (${h.uptime_s})`);
  assert.deepEqual(h.summary, { count: 6, longest_min: 3 * 24 * 60, verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0, unknown: 6 } });
  // codex pass 7 on #193 — (a) a forward flick still in its catch-up: samples stamped 40 min AHEAD of now (uptime still
  // rising on the current track) are quarantined: no reboot, but a clock step marked at now; (b) a real reboot 5 min
  // ago has too little history to be certain yet → ambiguous until SETTLE_S of samples stay on its track
  const lastStat = (await pool.query(`SELECT ts::float8 AS ts, uptime_s::float8 AS up FROM system_stats WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`, [NOW])).rows[0];
  // the displaced samples were taken EARLIER in real time than the resumed ones (lower uptime) and span 20 min — sorted
  // by ts they follow the resumed samples, so without the quarantine they look like a settled reboot
  await pool.query(
    `INSERT INTO system_stats (ts, uptime_s) SELECT $1::float8 + k * 60, $2::float8 - 3000 + k * 60 FROM generate_series(0, 20) k
     ON CONFLICT (ts) DO NOTHING`, [NOW + 2_400, Number(lastStat.up)]);
  const flick = await store.piLinkInputs(NOW * 1000, OPTS);
  assert.equal(flick.stats?.boots.length, 2, "future-stamped samples never make a reboot");
  assert.ok(flick.stats?.clockSteps?.includes(NOW), "…but mark a clock discontinuity at now");
  assert.ok(flick.latestStat && flick.latestStat.ts <= NOW + FUTURE_S, "latest uptime comes from a sample not in the future");
  await pool.query(`DELETE FROM system_stats WHERE ts > $1`, [NOW]);
  await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ($1, 60), ($2, 120), ($3, 180)`, [NOW - 300, NOW - 240, NOW - 180]);
  const fresh = await store.piLinkInputs(NOW * 1000, OPTS);
  assert.equal(fresh.stats?.boots.length, 2, "a reboot 5 min ago is not yet certain");
  assert.ok((fresh.stats?.ambiguous ?? []).some((b) => Math.abs(b.at - (NOW - 360)) <= 2), "…it is ambiguous until it settles");
  await pool.query(`INSERT INTO system_stats (ts, uptime_s) SELECT t, t - $1 FROM generate_series($2::bigint, $3::bigint, 60) t`,
    [NOW - 360, NOW - 120, NOW + 15 * 60]);
  // the same pushes carry readings (arrival-order evidence must cover a reboot before it is certain)
  await pool.query(`INSERT INTO readings (ts, pump_id) SELECT t, 'pump1' FROM generate_series($1::bigint, $2::bigint, 60) t`,
    [NOW - 2_400, NOW + 15 * 60]);
  const settled = await store.piLinkInputs((NOW + 15 * 60 + 30) * 1000, OPTS);
  assert.ok(settled.stats?.boots.some((b) => Math.abs(b.at - (NOW - 360)) <= 2), "after 15 min on its track it is certain");
  await pool.query(`DELETE FROM system_stats WHERE ts > $1`, [NOW - 360]);
  await pool.query(`DELETE FROM readings WHERE ts >= $1 AND ts > $2`, [NOW - 2_400, NOW - 1_830 - 437]);

  // ── the CLEAN proof of all three verdicts on the real SQL: no clock steps, the hub says aligned (offset 0) ─────────
  {
    const C0 = NOW - 2 * D, Bc = C0 - 10 * D, RB = C0 + 6 * H + 2 * H - 4 * 60; // reboot ends the first outage's silence
    const A: [number, number] = [C0 + 6 * H, C0 + 8 * H];        // gap+reboot: both paths silent, the Pi reboots at RB
    const G: [number, number] = [C0 + 12 * H, C0 + 14 * H];      // gap_only: both silent, no reboot
    const K: [number, number] = [C0 + 18 * H, C0 + 20 * H];      // socket_only: readings never stop
    await pool.query(`TRUNCATE readings, system_stats, phase_b_log RESTART IDENTITY`);
    const r: string[] = [], st: string[] = [];
    for (let t = C0; t <= C0 + 22 * H; t += 60) {
      const quiet = (t > A[0] + 60 && t < A[1] - 60) || (t > G[0] + 60 && t < G[1] - 60);
      if (quiet) continue;
      r.push(`(${t}, 'pump1', true, 'heating')`);
      st.push(`(${t}, ${t >= RB ? t - RB : t - Bc})`);
    }
    for (let i = 0; i < r.length; i += 500) {
      await pool.query(`INSERT INTO readings (ts, pump_id, online, state) VALUES ${r.slice(i, i + 500).join(",")}`);
      await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${st.slice(i, i + 500).join(",")}`);
    }
    await pool.query(
      `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
       SELECT to_timestamp(t), 'pump1', 'active', 55,
              CASE WHEN (t >= $2 AND t < $3) OR (t >= $4 AND t < $5) OR (t >= $6 AND t < $7) THEN 'failed: no Pi connected' ELSE 'sent' END
       FROM generate_series($1::bigint, $8::bigint, 300) t`, [C0, A[0], A[1], G[0], G[1], K[0], K[1], C0 + 22 * H]);
    const at = (C0 + 22 * H) * 1000;
    const ci = await store.piLinkInputs(at, OPTS);
    assert.equal(ci.stats?.clockSteps?.length ?? 0, 0, "a clean clock");
    const ch = piHealth(ci, at, 0);
    assert.deepEqual(ch.dropouts_7d.map((w) => w.verdict), ["gap+reboot", "gap_only", "socket_only"], "all three verdicts, on the real SQL");
    assert.ok(Math.abs(Date.parse(ch.dropouts_7d[0].reboot_at ?? "") / 1000 - RB) <= 2, "the reboot that ended the silence is named");
    assert.equal(ch.reboots_24h, 1);
    assert.deepEqual(ch.pi_clock, { live_offset_s: 0, future_rows: false, anchored: true, anchor: "hub", last_clock_event_at: null });
  }

  // the newest-reading query is not bounded by the analysis range: delete everything newer than 9 d → age still honest
  await pool.query(`DELETE FROM readings WHERE ts > $1`, [NOW - 9 * D]);
  await pool.query(`INSERT INTO readings (ts, pump_id) VALUES ($1, 'pump1')`, [NOW - 20 * D]);
  const old = piHealth(await store.piLinkInputs(NOW * 1000, OPTS), NOW * 1000);
  assert.ok(old.last_reading_age_s != null && Math.abs(old.last_reading_age_s - 20 * D) <= 1, `a 20-day silence keeps an age (${old.last_reading_age_s})`);
  // ── codex pass 8 on #193: a 20-min +1 h clock FLICK, evaluated at planner times THROUGH its catch-up ───────────
  // Pi booted at T0−3 h; both paths keep exporting; from real T0 to T0+20 min the clock reads +1 h, then it is right
  // again. system_stats keeps the displaced rows on ts conflicts (ingest's ON CONFLICT DO NOTHING) — at catch-up
  // they supply their own "settled" history; readings (ingestion-ordered ids) show the backward step at T0+20 min.
  // A socket outage T0..T0+25 min must read unknown, with no reboot, at every evaluation time.
  await pool.query(`TRUNCATE readings, system_stats, phase_b_log RESTART IDENTITY`);
  const T0 = NOW - 2 * D, B = T0 - 3 * H, F1 = T0 + 20 * 60;
  const stamp = (t: number) => (t >= T0 && t < F1 ? t + H : t);
  const sys: string[] = [];
  for (let t = T0 - 3 * H + 60; t <= T0 + 3 * H; t += 60) sys.push(`(${stamp(t)}, ${t - B})`);   // real-time order
  for (let i = 0; i < sys.length; i += 500) {
    await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${sys.slice(i, i + 500).join(",")} ON CONFLICT (ts) DO NOTHING`);
  }
  // readings in REAL-time (= ingestion, = id) order — one VALUES list per batch, so ids follow arrival
  const rd: string[] = [];
  for (let t = T0 - 3 * H + 60; t <= T0 + 3 * H; t += 60) for (const p of ["pump1", "pump2"]) rd.push(`(${stamp(t)}, '${p}', true, 'heating')`);
  for (let i = 0; i < rd.length; i += 500) {
    await pool.query(`INSERT INTO readings (ts, pump_id, online, state) VALUES ${rd.slice(i, i + 500).join(",")}`);
  }
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 AND t < $3 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $4::bigint, 300) t`, [T0 - 3 * H, T0, T0 + 25 * 60, T0 + 3 * H]);
  for (const evalS of [T0 + H + 5 * 60, T0 + H + 15 * 60, T0 + H + 19 * 60, T0 + H + 30 * 60, T0 + 3 * H]) {
    const fin = await store.piLinkInputs(evalS * 1000, OPTS);
    const fh = piHealth(fin, evalS * 1000);
    const w6 = fh.dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - T0) <= 60);
    const at = `at T0+${Math.round((evalS - T0) / 60)} min`;
    assert.equal(fin.stats?.boots.length, 0, `${at}: the flick never makes a certain reboot (${JSON.stringify(fin.stats?.boots)})`);
    assert.equal(fh.reboots_24h, 0, `${at}: and is never counted`);
    assert.equal(w6?.verdict, "unknown", `${at}: the outage during the flick is unknown (got ${w6?.verdict})`);
    assert.ok((fin.readings?.clockIntervals ?? []).some((c) => c.start <= F1 + 60 && c.end >= F1 + H - 120), `${at}: the re-stamped span is known from readings' ingestion order`);
  }
  // codex pass 12 on #193 — a SHORT socket outage at the flick's start, ending > 10 min before the correction: the
  // forward jump's skipped stretch is contaminated too, so it stays unknown (exports continued throughout)
  await pool.query(`TRUNCATE phase_b_log RESTART IDENTITY`);
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 AND t < $3 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $4::bigint, 60) t`, [T0 - 3 * H, T0, T0 + 5 * 60, T0 + 3 * H]);
  for (const evalS of [T0 + H + 25 * 60, T0 + 3 * H]) {
    const fin = await store.piLinkInputs(evalS * 1000, OPTS);
    const w7 = piHealth(fin, evalS * 1000).dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - T0) <= 60);
    assert.equal(w7?.minutes, 5);
    assert.equal(w7?.verdict, "unknown", `T0..T0+5 outage, at T0+${Math.round((evalS - T0) / 60)} min: unknown, never gap_only (got ${w7?.verdict})`);
    assert.ok((fin.readings?.clockIntervals ?? []).some((c) => c.start <= T0 && c.end >= F1 + H - 120), "the span runs from the forward jump to the end of the displaced rows");
  }
  await pool.query(`TRUNCATE phase_b_log RESTART IDENTITY`);
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 AND t < $3 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $4::bigint, 300) t`, [T0 - 3 * H, T0, T0 + 25 * 60, T0 + 3 * H]);
  // codex pass 13 on #193 — readings that only BEGIN after the flick (T0+30 min): the origin is inside the analysis
  // range but before readings coverage → no evidence → nothing certain through the catch-up
  {
    const kept = (await pool.query(`SELECT count(*)::int AS n FROM readings`)).rows[0].n;
    await pool.query(`CREATE TABLE readings_full AS SELECT * FROM readings`);
    // keep everything from T0+30 min on EXCEPT the displaced rows (they were ingested before the return, so their ids
    // precede the first row stamped at the return time)
    await pool.query(
      `DELETE FROM readings WHERE ts < $1
          OR (ts >= $2 AND ts < $3 AND id < (SELECT min(id) FROM readings_full WHERE ts >= $4 AND ts < $4 + 120))`,
      [T0 + 30 * 60, T0 + H, F1 + H, F1]);
    // (T0+75: every visible stats row past T0+60 is displaced — the moment the displaced rows fake a settled boot)
    for (const evalS of [T0 + H + 15 * 60, T0 + 3 * H]) {
      const fin = await store.piLinkInputs(evalS * 1000, OPTS);
      assert.ok(fin.readings?.firstTs != null && fin.readings.firstTs >= T0 + 30 * 60 - 60, "readings begin after the flick");
      assert.equal(fin.stats?.boots.length, 0, `late-starting readings, at T0+${Math.round((evalS - T0) / 60)} min: nothing certain (${JSON.stringify(fin.stats?.boots)})`);
    }
    await pool.query(`TRUNCATE readings; INSERT INTO readings SELECT * FROM readings_full; DROP TABLE readings_full`);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM readings`)).rows[0].n, kept);
  }
  // codex pass 9 on #193 — the same flick with ONE mirror table missing at a time:
  // (a) readings absent: no arrival-order evidence → no reboot is ever certain during the catch-up
  await pool.query(`ALTER TABLE readings RENAME TO readings_hidden`);
  for (const evalS of [T0 + H + 15 * 60, T0 + H + 19 * 60, T0 + 3 * H]) {
    const fin = await store.piLinkInputs(evalS * 1000, OPTS);
    assert.equal(fin.readings, null);
    assert.equal(fin.stats?.boots.length, 0, `readings absent, at T0+${Math.round((evalS - T0) / 60)} min: nothing certain`);
  }
  await pool.query(`ALTER TABLE readings_hidden RENAME TO readings`);
  // (b) system_stats absent: the readings-derived contamination still keeps the outage unknown, never socket_only
  await pool.query(`ALTER TABLE system_stats RENAME TO system_stats_hidden`);
  for (const evalS of [T0 + H + 15 * 60, T0 + 3 * H]) {
    const fin = await store.piLinkInputs(evalS * 1000, OPTS);
    assert.equal(fin.stats, null);
    const w6 = piHealth(fin, evalS * 1000).dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - T0) <= 60);
    assert.equal(w6?.verdict, "unknown", `stats absent, at T0+${Math.round((evalS - T0) / 60)} min: unknown (got ${w6?.verdict})`);
  }
  await pool.query(`ALTER TABLE system_stats_hidden RENAME TO system_stats`);
  // codex pass 10 on #193 — readings missing ONLY during the flick (an internal hole: no backward step in readings,
  // and readings still bracket the candidate): the displaced stats must stay ambiguous through the catch-up
  await pool.query(`TRUNCATE readings RESTART IDENTITY`);
  const holed: string[] = [];
  for (let t = T0 - 3 * H + 60; t <= T0 + 3 * H; t += 60) {
    if (t >= T0 && t < F1) continue; // no readings at all while the clock was wrong
    for (const p of ["pump1", "pump2"]) holed.push(`(${t}, '${p}', true, 'heating')`);
  }
  for (let i = 0; i < holed.length; i += 500) {
    await pool.query(`INSERT INTO readings (ts, pump_id, online, state) VALUES ${holed.slice(i, i + 500).join(",")}`);
  }
  for (const evalS of [T0 + H + 15 * 60, T0 + H + 19 * 60]) {
    const rows = (await pool.query(`SELECT count(*)::int AS n FROM readings WHERE ts > $1 AND ts <= $2`, [F1, evalS])).rows[0].n;
    assert.ok(rows > 0, "readings resume after the hole (they bracket the candidate)");
    const fin = await store.piLinkInputs(evalS * 1000, OPTS);
    assert.equal(fin.readings?.clockIntervals?.length ?? 0, 0, "no backward step is visible in readings");
    assert.equal(fin.stats?.boots.length, 0, `readings hole at the flick, at T0+${Math.round((evalS - T0) / 60)} min: nothing certain (${JSON.stringify(fin.stats?.boots)})`);
  }

  // ── codex pass 14 on #193: a PERSISTENT forward offset. The Pi clock jumps +1 h at P (no return); a real outage of
  // both paths at P+10 h..P+10 h 20 m (planner time) leaves a readings gap stamped an hour late. At the P+13 h refresh
  // the gap misses the window — without the misalignment rule that reads socket_only. Now: unknown, and /health.pi
  // says since when; also via the LIVE offset alone (no future rows: the evaluation is made after the data ends).
  await pool.query(`TRUNCATE readings, system_stats, phase_b_log RESTART IDENTITY`);
  const P = NOW - 3 * D, Bp = P - 5 * D;
  const fast = (t: number) => (t >= P ? t + H : t);
  const silentP = (t: number) => t >= P + 10 * H && t < P + 10 * H + 20 * 60;
  const rdP: string[] = [], ssP: string[] = [];
  for (let t = P - 6 * H; t <= P + 13 * H; t += 60) {
    if (silentP(t)) continue;
    rdP.push(`(${fast(t)}, 'pump1', true, 'heating')`);
    ssP.push(`(${fast(t)}, ${t - Bp})`);
  }
  for (let i = 0; i < rdP.length; i += 500) {
    await pool.query(`INSERT INTO readings (ts, pump_id, online, state) VALUES ${rdP.slice(i, i + 500).join(",")}`);
    await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${ssP.slice(i, i + 500).join(",")} ON CONFLICT (ts) DO NOTHING`);
  }
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 AND t < $3 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $4::bigint, 300) t`, [P - 6 * H, P + 10 * H, P + 10 * H + 20 * 60, P + 13 * H]);
  const atP = (P + 13 * H) * 1000;
  const inP = await store.piLinkInputs(atP, OPTS);
  assert.equal(inP.futureRows, true, "rows stamped an hour ahead of the planner clock");
  const hP = piHealth(inP, atP);
  const wP = hP.dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - (P + 10 * H)) <= 60);
  assert.equal(wP?.verdict, "unknown", `a persistently fast clock voids the verdict (got ${wP?.verdict})`);
  assert.equal(hP.pi_clock.anchored, false, "future rows: the present is not anchored");
  assert.equal(hP.pi_clock.future_rows, true);
  // the live offset alone (the future rows gone, e.g. evaluated once the data has caught up) does the same
  const late = (P + 15 * H) * 1000;
  const inL = await store.piLinkInputs(late, OPTS);
  assert.equal(inL.futureRows, false);
  assert.equal(piHealth(inL, late, 0).dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - (P + 10 * H)) <= 60)?.verdict,
    "socket_only", "if the hub CLAIMED alignment (offset 0) after the step, the stamps are taken at face value — so an honest offset matters:");
  const hL = piHealth(inL, late, -3_600);
  assert.equal(hL.dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - (P + 10 * H)) <= 60)?.verdict, "unknown",
    "the hub measures the Pi an hour fast → unknown");
  assert.equal(hL.pi_clock.live_offset_s, -3_600);

  // ── codex pass 15 on #193: an hour SLOW for two days, then corrected; a real outage of both paths inside the slow
  // span; evaluated AFTER the correction (no future rows, live offset 0) — must stay unknown ──────────────────────
  await pool.query(`TRUNCATE readings, system_stats, phase_b_log RESTART IDENTITY`);
  const Q0 = NOW - 4 * D, Q1 = Q0 + 2 * D, Bq = Q0 - 3 * D;               // slow from Q0, corrected at Q1
  const slow = (t: number) => (t >= Q0 && t < Q1 ? t - H : t);
  const out0 = Q0 + D + 10 * H;                                            // the outage, planner time
  const silentQ = (t: number) => t >= out0 && t < out0 + 20 * 60;
  const rdQ: string[] = [], ssQ: string[] = [];
  for (let t = Q0 - 6 * H; t <= Q1 + 6 * H; t += 60) {
    if (silentQ(t)) continue;
    rdQ.push(`(${slow(t)}, 'pump1', true, 'heating')`);
    ssQ.push(`(${slow(t)}, ${t - Bq})`);
  }
  for (let i = 0; i < rdQ.length; i += 500) {
    await pool.query(`INSERT INTO readings (ts, pump_id, online, state) VALUES ${rdQ.slice(i, i + 500).join(",")}`);
    await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${ssQ.slice(i, i + 500).join(",")} ON CONFLICT (ts) DO NOTHING`);
  }
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), 'pump1', 'active', 55, CASE WHEN t >= $2 AND t < $3 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $4::bigint, 300) t`, [Q0 - 6 * H, out0, out0 + 20 * 60, Q1 + 6 * H]);
  const atQ = (Q1 + 6 * H) * 1000;
  const inQ = await store.piLinkInputs(atQ, OPTS);
  assert.equal(inQ.futureRows, false, "aligned now: nothing stamped ahead");
  const hQ = piHealth(inQ, atQ, 0);
  const wQ = hQ.dropouts_7d.find((w) => Math.abs(Date.parse(w.start) / 1000 - out0) <= 60);
  assert.equal(wQ?.verdict, "unknown", `an outage inside a corrected slow span stays unknown (got ${wQ?.verdict})`);
  assert.ok(hQ.pi_clock.last_clock_event_at && Math.abs(Date.parse(hQ.pi_clock.last_clock_event_at) / 1000 - Q1) <= 180,
    `the correcting step is the last clock event (${hQ.pi_clock.last_clock_event_at}) — every window before it is unknown`);

  console.log(`pi-health-local-check: all assertions passed (${rows.length} system_stats rows, ${inputs.phaseB.length} phase_b rows)`);
}

main().then(() => store.close(), (e) => { console.error(e); process.exitCode = 1; return store.close(); });
