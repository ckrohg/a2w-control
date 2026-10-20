/**
 * @purpose Measure called_tank_flat on a LOCAL restore (scripts/analyze-local.sh), never production: replay the
 * planner's own evaluateTankFlat (single window, and with its persistence rule) every 5 min over the restored history — mirror readings + SPAN + slx_readings, exactly
 * the inputs index.ts feeds it — and print the distribution of the net tank response (rise + standby credit) over the
 * windows it would judge (stage called all 45 min, its pump heating ≥ 90 %), split by whether the other stage was
 * called and by outdoor temperature, plus the lowest windows with their pump ΔT / draw. Also checks STAGE_PUMP_MAP
 * against the data (which pump heats when only one stage is called). Feeds knowledge/reference/pump-health-baseline-20261019.md §5.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/pump-health-tank-measure.ts [days]
 */
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { evaluateTankFlat, PH, type PumpReading, type SpanSample, type TankReading } from "../planner/src/pumphealth";
import { DEFAULT_TANK_UA } from "../planner/src/winterdp";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) { console.error(`refusing: ${(e as Error).message}`); process.exit(2); }
const DAYS = Number(process.argv[2] ?? "97");
const MAP: Record<string, [string, string]> = { "1": ["pump1", "Air-Water 1"], "2": ["pump2", "Air-Water 2"] };

function lo<T extends { ts: number }>(a: T[], t: number): number { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m].ts < t) l = m + 1; else h = m; } return l; }
const slice = <T extends { ts: number }>(a: T[], from: number, to: number) => a.slice(lo(a, from), lo(a, to + 1e-6));
const pct = (xs: number[], ps = [0, 1, 5, 10, 25, 50, 75, 90]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? `n=${s.length} ` + ps.map((p) => `p${p}=${s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))].toFixed(1)}`).join(" ") : "n=0";
};

async function main(): Promise<void> {
  const store = new Store(url);
  const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;
  const end = Number((await pool.query(`SELECT extract(epoch FROM max(ts))::float8 AS t FROM slx_readings`)).rows[0].t);
  const start = end - DAYS * 86400;
  const rd: Record<string, PumpReading[]> = {}, sp: Record<string, SpanSample[]> = {};
  for (const [, [p, n]] of Object.entries(MAP)) {
    rd[p] = (await pool.query(`SELECT ts::float8 ts, online, state, inlet_c, outlet_c, ambient_c FROM readings WHERE pump_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`, [p, start - 3600, end]))
      .rows.map((x) => ({ ts: Number(x.ts), online: x.online === true, state: x.state, inlet_c: x.inlet_c, outlet_c: x.outlet_c, ambient_c: x.ambient_c }));
    sp[n] = (await pool.query(`SELECT ts::float8 ts, power_w FROM span_readings WHERE name = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`, [n, start - 3600, end]))
      .rows.map((x) => ({ ts: Number(x.ts), power_w: x.power_w }));
  }
  const tank: TankReading[] = (await pool.query(`SELECT extract(epoch FROM ts)::float8 ts, tank_f, stages_called FROM slx_readings WHERE ts >= to_timestamp($1) ORDER BY ts`, [start - 3600]))
    .rows.map((x) => ({ ts: Number(x.ts), tank_f: x.tank_f, stages_called: Array.isArray(x.stages_called) ? x.stages_called.map((b: unknown) => b === true) : null }));
  const outdoor = (await pool.query(`SELECT extract(epoch FROM ts)::float8 ts, outdoor_f FROM slx_readings WHERE ts >= to_timestamp($1) ORDER BY ts`, [start])).rows
    .map((x) => ({ ts: Number(x.ts), f: x.outdoor_f == null ? null : Number(x.outdoor_f) }));
  console.log(`window ${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}; readings ${Object.values(rd).map((a) => a.length)}, span ${Object.values(sp).map((a) => a.length)}, slx ${tank.length}`);

  // STAGE_PUMP_MAP check: slx readings with exactly one stage called — which pump is heating then?
  const solo: Record<string, Record<string, number>> = { "1": { pump1: 0, pump2: 0, n: 0 }, "2": { pump1: 0, pump2: 0, n: 0 } };
  for (const t of tank) {
    const c = t.stages_called; if (!c || c.length < 2 || c[0] === c[1]) continue;
    const st = c[0] ? "1" : "2"; solo[st].n++;
    for (const p of ["pump1", "pump2"]) {
      const a = rd[p], i = lo(a, t.ts) - 1;
      if (i >= 0 && t.ts - a[i].ts < 150 && a[i].state === "heating") solo[st][p]++;
    }
  }
  console.log("only one stage called → share of those readings each pump is heating:",
    Object.fromEntries(Object.entries(solo).map(([s, v]) => [`stage ${s}`, { readings: v.n, pump1: (v.pump1 / Math.max(1, v.n)).toFixed(2), pump2: (v.pump2 / Math.max(1, v.n)).toFixed(2) }])));

  const judged: { stage: string; at: number; net: number; rise: number; other: boolean; outdoor: number | null; dT: number | null; draw: number | null; tank: number | null; tripped: boolean; dfr: number; edt: number | null }[] = [];
  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const persistedTrips: string[] = [];
  for (let now = Math.ceil((start + PH.LOOKBACK_S) / 300) * 300; now <= end; now += 300) {
    const t = slice(tank, now - PH.LOOKBACK_S, now);
    if (!t.some((x) => x.stages_called?.some(Boolean))) continue;
    for (const [stage, [p, n]] of Object.entries(MAP)) {
      const v = evaluateTankFlat(stage, p, slice(rd[p], now - PH.LOOKBACK_S, now), slice(sp[n], now - PH.LOOKBACK_S, now), t, now, DEFAULT_TANK_UA, 0);
      const vp = evaluateTankFlat(stage, p, slice(rd[p], now - PH.LOOKBACK_S, now), slice(sp[n], now - PH.LOOKBACK_S, now), t, now, DEFAULT_TANK_UA);
      if (vp.state === "tripped") persistedTrips.push(`${new Date(now * 1000).toISOString().slice(0, 16)}Z stage ${stage}: ${vp.reason}`);
      counts[`${v.state}`] = (counts[v.state] ?? 0) + 1;
      const why = `${v.state}: ${v.reason.replace(/[\d.-]+/g, "#")}`; reasons[why] = (reasons[why] ?? 0) + 1;
      if (v.metrics.tank_rise_f == null) continue;
      const o = outdoor[Math.max(0, lo(outdoor, now) - 1)]?.f ?? null;
      judged.push({ stage, at: now, net: (v.metrics.tank_rise_f as number) + (v.metrics.standby_credit_f as number), rise: v.metrics.tank_rise_f as number,
        other: v.metrics.other_stage_called === 1, outdoor: o, dT: v.metrics.pump_mean_dt_c as number | null, draw: v.metrics.pump_draw_w as number | null,
        tank: v.metrics.tank_f as number | null, tripped: v.state === "tripped", dfr: v.metrics.defrost_pct as number, edt: v.metrics.engaged_dt_c as number | null });
    }
  }
  console.log("verdict counts over called windows:", counts);
  console.log("reasons:", Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10));
  // distinct episodes: consecutive tripped windows of one stage merge
  const nets = judged.map((j) => j.net);
  console.log(`net 45-min tank response (rise + standby credit, °F) where judged: ${pct(nets)}`);
  console.log(`   only this stage called: ${pct(judged.filter((j) => !j.other).map((j) => j.net))}`);
  console.log(`   both stages called:     ${pct(judged.filter((j) => j.other).map((j) => j.net))}`);
  for (const [lo_, hi] of [[-50, 32], [32, 45], [45, 60], [60, 200]]) {
    console.log(`   outdoor ${lo_}–${hi} °F: ${pct(judged.filter((j) => j.outdoor != null && j.outdoor >= lo_ && j.outdoor < hi).map((j) => j.net))}`);
  }
  const days = new Set(judged.map((j) => new Date(j.at * 1000).toISOString().slice(0, 10)));
  console.log(`judged windows span ${days.size} days`);
  for (const thr of [-5, -2, 0, 2, 5, 10]) {
    const hits = judged.filter((j) => j.net <= thr);
    const eps = new Set(hits.map((j) => `${j.stage}:${Math.floor(j.at / 3600)}`));
    console.log(`   net ≤ ${thr} °F: ${hits.length} windows (${eps.size} stage-hours, ${new Set(hits.map((j) => new Date(j.at * 1000).toISOString().slice(0, 10))).size} days)`);
  }
  console.log(`   windows with defrost in them: ${pct(judged.filter((j) => j.dfr > 0).map((j) => j.net))}`);
  console.log(`WITH the ${PH.TANK_FLAT_PERSIST_S / 60}-min persistence rule (net ≤ ${PH.TANK_FLAT_RISE_F} °F): ${persistedTrips.length} tripped evaluations`, persistedTrips.slice(0, 10));
  const edt = (f: (j: (typeof judged)[number]) => boolean) => pct(judged.filter((j) => f(j) && j.edt != null).map((j) => j.edt as number));
  console.log(`engaged ΔT (heating + defrost samples, °C), all judged windows: ${edt(() => true)}`);
  console.log(`   judged windows with net ≤ ${PH.TANK_FLAT_RISE_F} °F: ${edt((j) => j.net <= PH.TANK_FLAT_RISE_F)}`);
  console.log(`   by defrost share > 50 %: ${edt((j) => j.dfr > 50)}; ≤ 50 %: ${edt((j) => j.dfr <= 50)}`);
  console.log("lowest 15 windows:");
  for (const j of [...judged].sort((a, b) => a.net - b.net).slice(0, 15)) {
    console.log(`   ${new Date(j.at * 1000).toISOString().slice(0, 16)}Z stage ${j.stage} net ${j.net.toFixed(1)} rise ${j.rise.toFixed(1)} tank ${j.tank} °F outdoor ${j.outdoor} °F other=${j.other} defrost ${j.dfr}% pumpΔT ${j.dT} engagedΔT ${j.edt} °C draw ${j.draw} W`);
  }
  await store.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
