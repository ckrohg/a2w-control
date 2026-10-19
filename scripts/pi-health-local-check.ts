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
 * plus a reboot −6 h with no dropout (an owner power-cycle) → reboots_24h = 1, reboots_7d = 2.
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { piHealth, READING_GAP_MIN_S, BOOT_JUMP_S } from "../planner/src/pilink";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: LOCAL_DATABASE_URL must point at localhost (this check is for a local database only)");
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
const REBOOT1 = NOW - 4 * D + 4 * H + 360;   // 04:06, inside W1's slack
const REBOOT2 = NOW - 6 * H;                 // the power-cycle
const silent = (t: number, w: [number, number]) => t > w[0] + 60 && t < w[1] - 60;

async function main() {
  await store.ensureSchema();
  // ── 1. mirror tables ABSENT (the rehearsal's fresh DB): mirror-derived fields null, no throw ──────────────────
  await pool.query(`DROP TABLE IF EXISTS readings; DROP TABLE IF EXISTS system_stats; TRUNCATE phase_b_log RESTART IDENTITY`);
  const bare = await store.piLinkInputs(NOW * 1000, { gapS: READING_GAP_MIN_S, bootJumpS: BOOT_JUMP_S });
  assert.equal(bare.lastByPump, null);
  assert.equal(bare.readings, null);
  assert.equal(bare.boots, null);
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
     SELECT t, p, true, 'heating' FROM generate_series($1::bigint, $2::bigint, 60) t, unnest(ARRAY['pump1','pump2']) p
     WHERE NOT (t > $3 + 60 AND t < $4 - 60) AND NOT (t > $5 + 60 AND t < $6 - 60)`,
    [NOW - 8 * D, NOW - 30, W1[0], W1[1], W2[0], W2[1]]);
  // system_stats: every 60 s, silent inside W1; boot time jumps at REBOOT1 and REBOOT2 (and the Pi's own clock jitters ±2 s)
  const boot0 = NOW - 30 * D;
  const rows: string[] = [];
  for (let t = NOW - 8 * D; t <= NOW - 30; t += 60) {
    if (silent(t, W1)) continue;
    const boot = t >= REBOOT2 ? REBOOT2 : t >= REBOOT1 ? REBOOT1 : boot0;
    const jitter = (t / 60) % 3 - 1; // −1, 0, +1 s
    rows.push(`(${t}, ${t - boot + jitter})`);
  }
  for (let i = 0; i < rows.length; i += 2000) {
    await pool.query(`INSERT INTO system_stats (ts, uptime_s) VALUES ${rows.slice(i, i + 2000).join(",")}`);
  }
  // phase_b_log: both pumps every 5 min, active; "no Pi connected" inside each window, "sent" otherwise; plus noise
  await pool.query(
    `INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result)
     SELECT to_timestamp(t), p, 'active', 55,
            CASE WHEN (t >= $2 AND t < $3) OR (t >= $4 AND t < $5) OR (t >= $6 AND t < $7)
                 THEN 'failed: no Pi connected' ELSE 'sent' END
     FROM generate_series($1::bigint, $8::bigint, 300) t, unnest(ARRAY['pump1','pump2']) p`,
    [NOW - 7 * D + 600, W1[0], W1[1], W2[0], W2[1], W3[0], W3[1], NOW - 300]);
  await pool.query(`INSERT INTO phase_b_log (ts, pump_id, mode, value_c, result) VALUES
    (to_timestamp($1), 'pump1', 'active', 55, 'skipped: no writer lease'),
    (to_timestamp($1), 'pump1', 'dry-run', 55, 'would-send')`, [W2[0] + 900]);

  const inputs = await store.piLinkInputs(NOW * 1000, { gapS: READING_GAP_MIN_S, bootJumpS: BOOT_JUMP_S });
  assert.deepEqual(Object.keys(inputs.lastByPump ?? {}).sort(), ["pump1", "pump2"]);
  assert.equal(inputs.readings?.gaps.length, 2, `two readings gaps (got ${JSON.stringify(inputs.readings?.gaps)})`);
  assert.equal(inputs.boots?.length, 2, `exactly the two reboots, jitter ignored (got ${JSON.stringify(inputs.boots)})`);
  assert.ok(Math.abs(inputs.boots![0].at - REBOOT1) <= 2 && Math.abs(inputs.boots![1].at - REBOOT2) <= 2, "at the right moments (±2 s clock jitter)");
  assert.ok(inputs.phaseB.every((r) => r.result === "sent" || /no Pi connected/.test(r.result)), "only rows that speak about the Pi");

  const h = piHealth(inputs, NOW * 1000);
  assert.deepEqual(h.dropouts_7d.map((w) => w.verdict), ["gap+reboot", "gap_only", "socket_only"]);
  assert.deepEqual(h.dropouts_7d.map((w) => w.minutes), [130, 125, 120]);
  assert.ok(Math.abs(Date.parse(h.dropouts_7d[0].reboot_at ?? "") / 1000 - REBOOT1) <= 2, "W1 names its reboot");
  assert.equal(h.dropouts_7d[1].reboot_at, null);
  assert.equal(h.reboots_24h, 1);
  assert.equal(h.reboots_7d, 2);
  assert.equal(h.last_reading_age_s, 60, "the newest 60-s sample sits at now − 60");
  assert.ok(h.uptime_s != null && Math.abs(h.uptime_s - (6 * H - 60)) <= 2, `uptime since the power-cycle (${h.uptime_s})`);
  assert.deepEqual(h.summary, { count: 3, longest_min: 130, verdicts: { "gap+reboot": 1, gap_only: 1, socket_only: 1, unknown: 0 } });
  console.log(`pi-health-local-check: all assertions passed (${rows.length} system_stats rows, ${inputs.phaseB.length} phase_b rows)`);
}

main().then(() => store.close(), (e) => { console.error(e); process.exitCode = 1; return store.close(); });
