/**
 * @purpose Replay the backup-element gate (planner/src/backupgate.ts) over a LOCAL restore (scripts/analyze-local.sh),
 * never production. Every slx_readings row is one planner poll: the HBX tank / target / stage calls from that row, the
 * pump states from the mirror's `readings` at that instant (the hub frame the planner would have seen; no reading
 * within 150 s = blind, like a disconnected Pi), and the per-stage episodes from a StageWatch stepped on the same data —
 * exactly what index.ts feeds the gate. Prints every would-close / would-open with its context, and for each rule the
 * longest clock reached on data with no failed pump (the false-positive margin). Feeds
 * knowledge/reference/backup-gate-thresholds.md. Optional --dump <from> <to> writes the window as a test fixture.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/backup-gate-replay.ts
 *   env BACKUP_GATE_FLOOR_F / _FLOOR_MIN / _DEFICIT_F / _FAIL_HOLD_MIN override the thresholds (same parser as index.ts)
 */
import { writeFileSync } from "node:fs";
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { BackupGate, parseGateConfig, failedReason, type GatePump } from "../planner/src/backupgate";
import { StageWatch, DEFAULT_STAGE_PUMP_MAP } from "../planner/src/stagewatch";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) { console.error(`refusing: ${(e as Error).message}`); process.exit(2); }

interface Row { ts: number; tank: number | null; tgt: number | null; od: number | null; stages: boolean[] | null }
interface Rd { ts: number; online: boolean; state: string }
const et = (s: number) => new Date(s * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function lo<T extends { ts: number }>(a: T[], t: number): number { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m].ts < t) l = m + 1; else h = m; } return l; }

async function main(): Promise<void> {
  const store = new Store(url);
  const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;
  const slx: Row[] = (await pool.query(`SELECT extract(epoch FROM ts)::float8 ts, tank_f, tank_target_f, outdoor_f, stages_called FROM slx_readings ORDER BY ts`))
    .rows.map((x) => ({ ts: Number(x.ts), tank: x.tank_f, tgt: x.tank_target_f, od: x.outdoor_f, stages: Array.isArray(x.stages_called) ? x.stages_called.map((b: unknown) => b === true) : null }));
  const rd: Record<string, Rd[]> = {};
  for (const p of ["pump1", "pump2"]) {
    rd[p] = (await pool.query(`SELECT ts::float8 ts, online, state FROM readings WHERE pump_id = $1 ORDER BY ts`, [p]))
      .rows.map((x) => ({ ts: Number(x.ts), online: x.online === true, state: String(x.state) }));
  }
  const pumpsAt = (ts: number): GatePump[] | null => {
    const out: GatePump[] = [];
    for (const p of ["pump1", "pump2"]) {
      const a = rd[p], i = lo(a, ts + 1e-6) - 1;
      if (i < 0 || ts - a[i].ts > 150) return null; // no live frame → blind
      out.push({ id: p, online: a[i].online, state: a[i].online ? a[i].state : "offline" });
    }
    return out;
  };

  const dumpAt = process.argv.indexOf("--dump");
  if (dumpAt > 0) {
    const from = Date.parse(process.argv[dumpAt + 1]) / 1000, to = Date.parse(process.argv[dumpAt + 2]) / 1000, file = process.argv[dumpAt + 3];
    const rows = slx.filter((r) => r.ts >= from && r.ts <= to).map((r) => {
      const ps = pumpsAt(r.ts);
      return [Math.round(r.ts), r.tank, r.tgt, r.stages ? r.stages.map((b) => (b ? 1 : 0)).join("") : null,
        ps ? ps.map((p) => (p.online ? p.state : "offline")) : null];
    });
    writeFileSync(file, JSON.stringify({ source: "a2w restore, slx_readings + mirror readings", from: process.argv[dumpAt + 1], to: process.argv[dumpAt + 2],
      columns: ["ts", "tank_f", "target_f", "stages(1=called)", "[pump1,pump2] state | null=blind"], rows }) + "\n");
    console.log(`wrote ${rows.length} rows to ${file}`);
    return;
  }

  const cfg = parseGateConfig(process.env);
  for (const e of cfg.errors) console.warn(e);
  const gate = new BackupGate("shadow", true, cfg.t);
  const sw = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const healthyMax: Record<string, { min: number; at: string }> = { failed_not_recovering: { min: 0, at: "" }, floor: { min: 0, at: "" } };
  const anyMax: Record<string, { min: number; at: string }> = { failed_not_recovering: { min: 0, at: "" }, floor: { min: 0, at: "" } };
  // what-if gates (diagnostics only): the tank half of each rule on its own, so its length on HEALTHY data is the margin
  // the pump half buys — failed_not_recovering as if a pump were always failed, floor as if every pump were running
  const wiA = new BackupGate("shadow", true, cfg.t), wiB = new BackupGate("shadow", true, cfg.t);
  const wiMax: Record<string, { min: number; at: string }[]> = { tank_not_recovering: [], tank_below_floor: [] };
  const peak = { a: 0, b: 0, aAt: 0, bAt: 0, failedSeen: false };
  const callMaxA: { min: number; at: string; failed: boolean }[] = [];
  let inCall = false, callA = 0, callAt = 0, callFailed = false;
  let closes = 0, opens = 0;
  for (const r of slx) {
    const nowMs = r.ts * 1000;
    const pumps = pumpsAt(r.ts);
    const anyCall = r.stages?.some(Boolean) === true;
    sw.step({ nowMs, stagesCalled: r.stages, pumps: !anyCall ? [] : pumps, lagTMin: null });
    const st = sw.status();
    const withEp = pumps?.map((p) => ({ ...p, stageEpisode: Object.values(st).some((s) => s.pump === p.id && (s.unserved_open || s.fault_open)) })) ?? null;
    const evs = gate.step({ nowMs, tankF: r.tank, tankTargetF: r.tgt, stagesCalled: r.stages, pumps: withEp });
    const s = gate.status(nowMs) as { clocks: { failed_not_recovering_min: number; floor_min: number } };
    const failedNow = withEp ? withEp.some((p) => failedReason(p) != null) : true;
    for (const [k, v] of [["failed_not_recovering", s.clocks.failed_not_recovering_min], ["floor", s.clocks.floor_min]] as const) {
      if (v > anyMax[k].min) anyMax[k] = { min: v, at: et(r.ts) };
      if (!failedNow && v > healthyMax[k].min) healthyMax[k] = { min: v, at: et(r.ts) };
    }
    {
      const p2 = (pumps ?? [{ id: "pump1", online: true, state: "idle" }, { id: "pump2", online: true, state: "idle" }]);
      // a failed (or unknown) pump resets the what-if clocks: they measure HEALTHY spells only
      const stagesWi = failedNow ? [false, false] : r.stages;
      wiA.step({ nowMs, tankF: r.tank, tankTargetF: r.tgt, stagesCalled: stagesWi, pumps: p2.map((p) => ({ ...p, stageEpisode: true })) });
      wiB.step({ nowMs, tankF: r.tank, tankTargetF: r.tgt, stagesCalled: stagesWi, pumps: p2.map((p) => ({ ...p, online: true, state: "heating" })) });
      const ca = (wiA.status(nowMs) as { clocks: { failed_not_recovering_min: number } }).clocks.failed_not_recovering_min;
      const cb = (wiB.status(nowMs) as { clocks: { floor_min: number } }).clocks.floor_min;
      if (!failedNow) {
        if (ca > peak.a) { peak.a = ca; peak.aAt = r.ts; }
        if (cb > peak.b) { peak.b = cb; peak.bAt = r.ts; }
      }
      // per call: the longest REAL failed_not_recovering clock, and whether a pump was failed during it
      if (anyCall) { if (!inCall) { inCall = true; callA = 0; callAt = r.ts; callFailed = false; } callA = Math.max(callA, s.clocks.failed_not_recovering_min); callFailed ||= failedNow && pumps != null; }
      else if (inCall) { inCall = false; if (callFailed) callMaxA.push({ min: callA, at: et(callAt), failed: true }); }
    }
    for (const e of evs) {
      if (e.kind === "close") closes++; else if (e.kind === "open") opens++;
      console.log(`${et(r.ts)}  ${e.kind.toUpperCase()} (${e.rule})  ${e.body}`);
    }
  }
  console.log(`\nthresholds ${JSON.stringify(cfg.t)}  rows ${slx.length}  ${et(slx[0].ts)} → ${et(slx[slx.length - 1].ts)}`);
  console.log(`would-close ${closes}, would-open ${opens}`);
  console.log("longest clock with NO failed pump (false-positive margin):", JSON.stringify(healthyMax));
  console.log("longest clock overall:", JSON.stringify(anyMax));
  console.log(`what-if, HEALTHY data (no failed pump): tank ≥ ${cfg.t.deficitF} °F below target & not rising, while called — longest ${peak.a} min (${et(peak.aAt)}); ` +
    `tank < ${cfg.t.floorF} °F & not rising while called — longest ${peak.b} min${peak.b ? ` (${et(peak.bAt)})` : ""}`);
  callMaxA.sort((a, b) => b.min - a.min);
  console.log(`calls with a failed pump: ${callMaxA.length}; longest failed_not_recovering clock per call:`, callMaxA.slice(0, 14).map((c) => `${c.min}m@${c.at}`).join(", "));
  await (store as unknown as { pool: { end: () => Promise<void> } }).pool.end().catch(() => {});
  await (store as unknown as { locked?: { end: () => Promise<void> } }).locked?.end().catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
