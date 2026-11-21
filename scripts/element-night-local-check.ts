/**
 * @purpose Analyse the element-calibration night (Sun Nov 22 → Mon Nov 23 2026, America/New_York) on a LOCAL restore
 * (scripts/analyze-local.sh), never production. Both heat pumps' SPAN circuits are off, the planner boosts the HBX to
 * 135 °F, and the owner closes the "Buffer Tank" SPAN circuit: a 16.5 kW resistance element inside the buffer, COP = 1.
 * Prints, with their working:
 *   1. C_eff, the tank's effective heat capacity (BTU/°F and gallons-equivalent), from the element's metered kWh and
 *      the standby-corrected tank rise, against the planner's C_EFF_BTU_PER_F (110 gal, plausible 90–125);
 *   2. each heat pump's loop flow (L/min, water basis and 50/50 propylene-glycol basis) from the measured C_eff applied
 *      to the last --flow-days of single-pump deep charges, against the 35.3 L/min rating.
 * Contamination checks print as WARN lines; nothing is dropped silently. The math and its method notes live in
 * scripts/element-calibration.ts (tested by scripts/element-calibration.test.ts).
 *
 * Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/element-night-local-check.ts \
 *       [--from "2026-11-22 22:30"] [--to "2026-11-23 03:30"] [--flow-days 14] [--pump-power readings|span]
 * --from / --to are local ET wall-clock times; the flow window is the --flow-days before --from. --pump-power picks
 * where a pump's "real power" comes from for the segment finder (default: readings.power_w if it reads like watts,
 * else the pump's SPAN circuit — see the note in the flow section).
 */
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { detectDrawTimes } from "../planner/src/dhw";
import { C_EFF_BTU_PER_F, DEFAULT_TANK_UA } from "../planner/src/winterdp";
import {
  BTU_PER_KWH, LB_PER_GAL, PG50_KJ_PER_L_K, WATER_KJ_PER_L_K, RATED_FLOW_L_MIN, TANK_AMBIENT_F, BURST_THRESHOLD_W,
  PRE_WINDOW_MIN, POST_WINDOW_MIN, SEGMENT, findBurst, deltaT, cEffBtuPerF, findSinglePumpSegments, segmentFlow,
  cleanest, quantile, type PowerSample, type TankSample, type PumpSample,
} from "./element-calibration";

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local restore only): ${(e as Error).message}`);
  process.exit(2);
}

// ---- arguments ------------------------------------------------------------------------------------------------
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
  else args.set(a.slice(2), process.argv[++i] ?? "");
}
const FROM_ARG = args.get("from") ?? "2026-11-22 22:30";
const TO_ARG = args.get("to") ?? "2026-11-23 03:30";
const FLOW_DAYS = Number(args.get("flow-days") ?? "14");
if (!(FLOW_DAYS > 0)) { console.error(`--flow-days must be a positive number, got ${args.get("flow-days")}`); process.exit(2); }

const TZ = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(d: Date): { day: string; hour: number; minute: number } {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
/** Epoch seconds at which America/New_York reads "YYYY-MM-DD HH:MM" (EST or EDT, whichever applies that day). */
function parseEt(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`expected "YYYY-MM-DD HH:MM" (local ET), got "${s}"`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h + off, mi));
    const p = etParts(t);
    if (p.day === `${m[1]}-${m[2]}-${m[3]}` && p.hour === h && p.minute === mi) return t.getTime() / 1000;
  }
  throw new Error(`no ET instant for ${s}`);
}
const et = (ts: number) => { const p = etParts(new Date(ts * 1000)); return `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET`; };
const hm = (ts: number) => et(ts).slice(11, 16);
const f1 = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const warn = (s: string) => console.log(`WARN  ${s}`);

const PUMPS: { id: string; span: string }[] = [{ id: "pump1", span: "Air-Water 1" }, { id: "pump2", span: "Air-Water 2" }];
const ELEMENT = "Buffer Tank";

interface SlxRow { ts: number; tank_f: number | null; tank_target_f: number | null; outdoor_f: number | null; hd_active: boolean | null; stages_called: boolean[] | null; backup_called: boolean | null }

async function main(): Promise<void> {
  const from = parseEt(FROM_ARG), to = parseEt(TO_ARG);
  if (!(to > from)) throw new Error(`--to must be after --from (${FROM_ARG} → ${TO_ARG})`);
  const store = new Store(url);
  const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;
  try {
    console.log(`element-night-local-check: window ${et(from)} → ${et(to)} (${new Date(from * 1000).toISOString()} → ${new Date(to * 1000).toISOString()}); flow window = ${FLOW_DAYS} d before --from`);
    const newest = Number((await pool.query(`SELECT extract(epoch FROM max(ts))::float8 AS t FROM slx_readings`)).rows[0]?.t ?? NaN);
    console.log(`restore's newest slx_readings row: ${Number.isFinite(newest) ? et(newest) : "none"}`);
    if (!Number.isFinite(newest) || newest < to) warn(`the restore ends ${Number.isFinite(newest) ? et(newest) : "nowhere"}, before --to — restore a newer backup (scripts/analyze-local.sh) if the night is missing`);

    // ---- night data ------------------------------------------------------------------------------------------
    // SPAN reports consumption as NEGATIVE power_w on this panel (pumphealth.ts, planner index.ts element_w): magnitude everywhere
    const span = async (name: string, a: number, b: number): Promise<PowerSample[]> =>
      (await pool.query(`SELECT ts::float8 ts, power_w FROM span_readings WHERE name = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`, [name, a, b]))
        .rows.map((x) => ({ ts: Number(x.ts), power_w: x.power_w == null ? null : Math.abs(Number(x.power_w)) }));
    const slx = async (a: number, b: number): Promise<SlxRow[]> =>
      (await pool.query(`SELECT extract(epoch FROM ts)::float8 ts, tank_f, tank_target_f, outdoor_f, hd_active, stages_called, backup_called
                         FROM slx_readings WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2) ORDER BY ts`, [a, b]))
        .rows.map((x) => ({ ts: Number(x.ts), tank_f: x.tank_f == null ? null : Number(x.tank_f), tank_target_f: x.tank_target_f == null ? null : Number(x.tank_target_f),
          outdoor_f: x.outdoor_f == null ? null : Number(x.outdoor_f), hd_active: x.hd_active ?? null,
          stages_called: Array.isArray(x.stages_called) ? x.stages_called.map((b: unknown) => b === true) : null, backup_called: x.backup_called ?? null }));
    const pumps = async (id: string, a: number, b: number): Promise<PumpSample[]> =>
      (await pool.query(`SELECT ts::float8 ts, state, inlet_c, outlet_c, power_w FROM readings WHERE pump_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`, [id, a, b]))
        .rows.map((x) => ({ ts: Number(x.ts), state: x.state ?? null, inlet_c: x.inlet_c == null ? null : Number(x.inlet_c),
          outlet_c: x.outlet_c == null ? null : Number(x.outlet_c), power_w: x.power_w == null ? null : Number(x.power_w) }));

    const element = await span(ELEMENT, from, to);
    const pumpSpan: Record<string, PowerSample[]> = {};
    for (const p of PUMPS) pumpSpan[p.id] = await span(p.span, from, to);
    const night = await slx(from, to);
    const tank: TankSample[] = night.filter((r) => r.tank_f != null).map((r) => ({ ts: r.ts, tank_f: r.tank_f as number }));
    console.log(`rows: "${ELEMENT}" ${element.length}, ${PUMPS.map((p) => `"${p.span}" ${pumpSpan[p.id].length}`).join(", ")}, slx_readings ${night.length} (${tank.length} with tank_f)`);
    const out = night.map((r) => r.outdoor_f).filter((x): x is number => x != null);
    if (out.length) console.log(`outdoor ${f1(Math.min(...out))}–${f1(Math.max(...out))} °F; tank_target_f seen: ${[...new Set(night.map((r) => r.tank_target_f).filter((x) => x != null))].join(", ") || "none"}`);
    for (const p of PUMPS) {
      const s = pumpSpan[p.id];
      const offAt = s.find((x, i) => i > 0 && (s[i - 1].power_w ?? 0) > 100 && (x.power_w ?? 0) <= 100);
      const onAt = [...s].reverse().find((x, i, arr) => i > 0 && (arr[i - 1].power_w ?? 0) > 100 && (x.power_w ?? 0) <= 100);
      console.log(`"${p.span}" SPAN: first drop to ≤100 W at ${offAt ? hm(offAt.ts) : "never"}, last ≤100 W before coming back at ${onAt ? hm(onAt.ts) : "n/a"}`);
    }

    // ---- 1. C_eff ------------------------------------------------------------------------------------------------
    console.log(`\n== 1. C_eff from the "${ELEMENT}" burst (> ${BURST_THRESHOLD_W} W) ==`);
    let cEff: number | null = null;
    const burst = findBurst(element);
    if (!burst) {
      warn(`no "${ELEMENT}" burst above ${BURST_THRESHOLD_W} W between ${et(from)} and ${et(to)} — was the Buffer Tank circuit closed? widen --from/--to if the schedule slipped`);
    } else {
      if (burst.runsFound > 1) warn(`${burst.runsFound} separate runs above ${BURST_THRESHOLD_W} W in the window; using the highest-energy one (element cycling or a second closing?)`);
      if (burst.maxGapS > 120) warn(`largest gap between element samples inside the burst is ${burst.maxGapS.toFixed(0)} s (cadence is ~30 s) — the trapezoid bridges it`);
      if (!burst.bracketed[0] || !burst.bracketed[1]) warn(`no below-threshold sample within 120 s ${!burst.bracketed[0] ? "before" : "after"} the burst edge — the switch ramp on that side is not in the integral`);
      const mins = (burst.end - burst.start) / 60;
      console.log(`burst ${hm(burst.start)} → ${hm(burst.end)} (${mins.toFixed(1)} min between first and last sample above threshold, ${burst.nAbove} samples; brackets ${burst.bracketed.map((b) => (b ? "yes" : "no")).join("/")})`);
      console.log(`power peak ${burst.peakW.toFixed(0)} W, mean ${burst.meanW.toFixed(0)} W (nameplate 16 500 W); E = ${burst.kwh.toFixed(3)} kWh = ${(burst.kwh * BTU_PER_KWH).toFixed(0)} BTU (trapezoid, brackets included)`);

      const d = deltaT(tank, burst);
      console.log(`pre fit  [${hm(d.preWindow[0])}, ${hm(d.preWindow[1])}]: n=${d.nPre} slope ${f1(d.pre?.slopePerHr, 2)} °F/h rms ${f1(d.pre?.rms, 2)} °F → at midpoint ${hm(d.mid)}: ${f1(d.preAtMid, 2)} °F`);
      console.log(`post fit [${hm(d.postWindow[0])}, ${hm(d.postWindow[1])}]: n=${d.nPost} slope ${f1(d.post?.slopePerHr, 2)} °F/h rms ${f1(d.post?.rms, 2)} °F → at midpoint: ${f1(d.postAtMid, 2)} °F`);
      console.log(`tank raw: ${f1(d.rawStartF)} °F (last sample before) → ${f1(d.rawEndF)} °F (first sample after), peak ${f1(d.peakF)} °F within ${POST_WINDOW_MIN[1]} min; raw ΔT = ${f1(d.rawF, 2)} °F`);
      console.log(`ΔT corrected (post line − pre line at the burst midpoint) = ${f1(d.correctedF, 2)} °F`);
      if (d.nPre < 3) warn(`only ${d.nPre} tank samples in the pre window (need ≥ 3 at the ~5 min slx cadence) — the pre baseline is weak`);
      if (d.nPost < 3) warn(`only ${d.nPost} tank samples in the post window (need ≥ 3) — the post baseline is weak`);
      if (d.pre && d.pre.slopePerHr > 0.5) warn(`tank was RISING ${d.pre.slopePerHr.toFixed(2)} °F/h before the burst — something else was heating it (a pump still on?)`);
      if (d.post && d.post.slopePerHr < -6) warn(`tank fell ${(-d.post.slopePerHr).toFixed(1)} °F/h after the burst, far above standby — a zone call or draw was pulling heat; the post baseline over-corrects`);
      if (d.pre && d.post && d.post.slopePerHr > d.pre.slopePerHr + 1) warn(`post slope (${d.post.slopePerHr.toFixed(2)} °F/h) is less negative than pre (${d.pre.slopePerHr.toFixed(2)}): a hotter tank should lose heat faster — the sensor may not have settled by +${POST_WINDOW_MIN[0]} min`);

      // contamination
      const drawTs = detectDrawTimes(tank.map((t) => ({ ts: new Date(t.ts * 1000), tankF: t.tank_f }))).map((x) => x.getTime() / 1000);
      const nearDraws = drawTs.filter((x) => x >= burst.start - 1800 && x <= burst.end + 1800);
      if (nearDraws.length) warn(`${nearDraws.length} detected draw(s) within ±30 min of the burst: ${nearDraws.map(hm).join(", ")} (detectDrawTimes; in winter these are draws OR zone calls)`);
      else console.log(`ok    no detected draw within ±30 min of the burst (${drawTs.length} in the whole window${drawTs.length ? ": " + drawTs.map(hm).join(", ") : ""})`);
      const during = night.filter((r) => r.ts >= burst.start && r.ts <= burst.end);
      const staged = during.filter((r) => r.stages_called?.some(Boolean));
      const backup = during.filter((r) => r.backup_called === true);
      if (staged.length) warn(`stages_called true in ${staged.length}/${during.length} slx rows during the burst (${staged.map((r) => `${hm(r.ts)} [${r.stages_called?.map((b) => (b ? 1 : 0)).join("")}]`).join(", ")}) — the HBX was calling a stage; with the pumps' circuits off nothing should answer, check the pump SPAN lines below`);
      else console.log(`ok    stages_called never true during the burst (${during.length} slx rows)`);
      if (backup.length) warn(`backup_called true in ${backup.length}/${during.length} slx rows during the burst (${backup.map((r) => hm(r.ts)).join(", ")}) — the HBX itself was calling the element; fine for COP = 1, but note it in the record`);
      else console.log(`ok    backup_called never true during the burst`);
      for (const p of PUMPS) {
        const ws = pumpSpan[p.id].filter((s) => s.ts >= burst.start && s.ts <= burst.end && s.power_w != null).map((s) => s.power_w as number);
        if (!ws.length) warn(`no "${p.span}" SPAN samples during the burst — cannot confirm that pump was off`);
        else if (Math.max(...ws) > 100) warn(`"${p.span}" drew up to ${Math.max(...ws).toFixed(0)} W during the burst (standby is ~50 W; expected the circuit OFF) — some of the tank rise is heat-pump heat and C_eff reads HIGH`);
        else console.log(`ok    "${p.span}" ≤ ${Math.max(...ws).toFixed(0)} W during the burst`);
      }
      const hd = during.filter((r) => r.hd_active === true).length;
      if (hd) console.log(`note  hd_active true in ${hd}/${during.length} slx rows during the burst (heating demand present; zone calls pull from the buffer and would make C_eff read HIGH)`);

      if (d.correctedF != null && d.correctedF > 0) {
        cEff = cEffBtuPerF(burst.kwh, d.correctedF);
        const gal = cEff / LB_PER_GAL;
        const rawC = d.rawF && d.rawF > 0 ? cEffBtuPerF(burst.kwh, d.rawF) : null;
        console.log(`\nC_eff = ${burst.kwh.toFixed(3)} kWh × ${BTU_PER_KWH} / ${d.correctedF.toFixed(2)} °F = ${cEff.toFixed(0)} BTU/°F  (${gal.toFixed(1)} gal-equivalent)`);
        if (rawC) console.log(`      (uncorrected, for scale: ${rawC.toFixed(0)} BTU/°F = ${(rawC / LB_PER_GAL).toFixed(1)} gal)`);
        const band = gal >= 90 && gal <= 125 ? "inside" : "OUTSIDE";
        console.log(`planner: C_EFF_BTU_PER_F = ${C_EFF_BTU_PER_F.toFixed(1)} BTU/°F (110 gal, plausible 90–125); measured is ${((cEff / C_EFF_BTU_PER_F - 1) * 100).toFixed(1)} % off and ${band} the band`);
        if (band === "OUTSIDE") warn(`measured C_eff ${gal.toFixed(1)} gal is outside the planner's 90–125 gal band — re-read the WARN lines above before believing it`);
      } else {
        warn(`corrected ΔT is ${f1(d.correctedF, 2)} °F — C_eff cannot be computed from this burst`);
      }
    }

    // ---- 2. flow -------------------------------------------------------------------------------------------------
    const cUsed = cEff ?? C_EFF_BTU_PER_F;
    console.log(`\n== 2. loop flow from single-pump deep charges, ${FLOW_DAYS} d before ${et(from)} ==`);
    if (cEff == null) warn(`no measured C_eff tonight — flows below use the planner's ${C_EFF_BTU_PER_F.toFixed(0)} BTU/°F and scale 1:1 with C_eff`);
    console.log(`C_eff ${cUsed.toFixed(0)} BTU/°F; standby UA ${DEFAULT_TANK_UA} °F/h per °F above ${TANK_AMBIENT_F} °F (DEFAULT_TANK_UA); ρc water ${WATER_KJ_PER_L_K}, PG50 ${PG50_KJ_PER_L_K.toFixed(3)} kJ/(L·K); rated ${RATED_FLOW_L_MIN.toFixed(1)} L/min per pump`);
    console.log(`segment: power_w > ${SEGMENT.minPowerW} W and outlet > inlet, other pump ≤ ${SEGMENT.otherIdleW} W, no draw within ${SEGMENT.drawMarginS / 60} min, ≥ ${SEGMENT.minMinutes} min, ≥ ${SEGMENT.minTankSamples} tank samples, sample gap ≤ ${SEGMENT.maxGapS} s`);
    const fFrom = from - FLOW_DAYS * 86400;
    const hist: Record<string, PumpSample[]> = {};
    for (const p of PUMPS) hist[p.id] = await pumps(p.id, fFrom, from);
    const histTank: TankSample[] = (await slx(fFrom, from)).filter((r) => r.tank_f != null).map((r) => ({ ts: r.ts, tank_f: r.tank_f as number }));
    const histDraws = detectDrawTimes(histTank.map((t) => ({ ts: new Date(t.ts * 1000), tankF: t.tank_f }))).map((x) => x.getTime() / 1000);
    console.log(`rows: ${PUMPS.map((p) => `${p.id} ${hist[p.id].length}`).join(", ")}, tank ${histTank.length}, detected draws ${histDraws.length}`);
    if (!histTank.length) warn(`no slx_readings in the flow window — the restore does not cover it`);

    // readings.power_w is the pump's own Modbus power (registers 2063 + 2088, POWER_SCALE = 1.0, "units unconfirmed" in
    // heatpump-bridge/bridge/registers.py). If it does not read like watts while the pump says "heating", the SPAN circuit
    // (which is metered in W) stands in for it, sample by sample. --pump-power readings|span forces one or the other.
    const forced = args.get("pump-power");
    for (const p of PUMPS) {
      const rd = hist[p.id];
      const heatingRows = rd.filter((r) => r.state === "heating");
      const pw = heatingRows.map((r) => (r.power_w == null ? null : Math.abs(r.power_w))).filter((w): w is number => w != null);
      const share = pw.length ? pw.filter((w) => w > SEGMENT.minPowerW).length / heatingRows.length : 0;
      console.log(`${p.id} readings.power_w while state=heating: n=${heatingRows.length}, non-null ${pw.length}, median ${f1(quantile(pw, 0.5), 0)}, share > ${SEGMENT.minPowerW} W = ${(share * 100).toFixed(0)} %`);
      const useSpan = forced === "span" || (forced !== "readings" && share < 0.5);
      if (!useSpan) continue;
      warn(`${p.id}: ${forced === "span" ? "--pump-power span" : `only ${(share * 100).toFixed(0)} % of heating rows exceed ${SEGMENT.minPowerW} W — the Modbus power unit is unconfirmed`}; using the "${p.span}" SPAN circuit magnitude (nearest sample ≤ 90 s) as the pump's power instead`);
      const sp = await span(p.span, fFrom, from);
      let k = 0, filled = 0;
      hist[p.id] = rd.map((r) => {
        while (k + 1 < sp.length && sp[k + 1].ts <= r.ts) k++;
        const cands = [sp[k], sp[k + 1]].filter((s): s is PowerSample => !!s && Math.abs(s.ts - r.ts) <= 90 && s.power_w != null);
        if (!cands.length) return { ...r, power_w: null };
        filled++;
        return { ...r, power_w: cands.reduce((a, b) => (Math.abs(a.ts - r.ts) <= Math.abs(b.ts - r.ts) ? a : b)).power_w };
      });
      console.log(`${p.id}: ${filled}/${rd.length} readings matched to a SPAN sample (${sp.length} "${p.span}" rows)`);
    }

    for (const p of PUMPS) {
      const other = PUMPS.find((q) => q.id !== p.id) as { id: string };
      const { segments, rejected } = findSinglePumpSegments(hist[p.id], hist[other.id], histTank, histDraws);
      const flows = segments.map((s) => ({ s, f: segmentFlow(s, cUsed, DEFAULT_TANK_UA, TANK_AMBIENT_F) }));
      console.log(`\n-- ${p.id} ("${p.span}"): ${segments.length} segments (rejected: ${rejected.shortRun} short, ${rejected.otherBusy} other pump busy, ${rejected.draw} draw nearby, ${rejected.fewTank} too few tank samples)`);
      if (!segments.length) { warn(`${p.id}: no single-pump deep-charge segment in the window — widen --flow-days`); continue; }
      if (segments.length < 3) warn(`${p.id}: only ${segments.length} segment(s) — the median below is not robust`);
      const pg = flows.map((x) => x.f.flowPg50LMin), wa = flows.map((x) => x.f.flowWaterLMin);
      const iqr = (xs: number[]) => `median ${quantile(xs, 0.5).toFixed(1)}  IQR ${quantile(xs, 0.25).toFixed(1)}–${quantile(xs, 0.75).toFixed(1)}`;
      console.log(`   flow PG50  basis: ${iqr(pg)} L/min  (${((quantile(pg, 0.5) / RATED_FLOW_L_MIN) * 100).toFixed(0)} % of rated ${RATED_FLOW_L_MIN.toFixed(1)})`);
      console.log(`   flow water basis: ${iqr(wa)} L/min  (${((quantile(wa, 0.5) / RATED_FLOW_L_MIN) * 100).toFixed(0)} % of rated)`);
      console.log(`   pump ΔT median ${quantile(segments.map((s) => s.meanDtC), 0.5).toFixed(2)} °C; tank slope median ${quantile(segments.map((s) => s.tank.slopePerHr), 0.5).toFixed(1)} °F/h; Q median ${quantile(flows.map((x) => x.f.qKw), 0.5).toFixed(1)} kW; segment length median ${quantile(segments.map((s) => s.minutes), 0.5).toFixed(0)} min`);
      const neg = flows.filter((x) => x.f.qKw <= 0).length;
      if (neg) warn(`${p.id}: ${neg} segment(s) with Q ≤ 0 (the tank fell while the pump heated: a zone was drawing) — they drag the median down; flow is a LOWER bound while zones call`);
      const noOther = segments.filter((s) => s.nOther === 0).length;
      if (noOther) warn(`${p.id}: ${noOther} segment(s) had no ${other.id} readings at all — "other pump idle" is unverified there`);
      console.log(`   5 cleanest (lowest tank-fit rms):`);
      for (const s of cleanest(segments).slice(0, 5)) {
        const f = segmentFlow(s, cUsed, DEFAULT_TANK_UA, TANK_AMBIENT_F);
        console.log(`     ${et(s.start)} → ${hm(s.end)}  ${s.minutes.toFixed(0)} min  tank ${s.tankStartF.toFixed(1)}→${s.tankEndF.toFixed(1)} °F (slope ${f.tankSlopeFPerHr.toFixed(1)} °F/h, rms ${s.tank.rms.toFixed(2)}, standby ${f.standbyFPerHr.toFixed(2)} °F/h)  ΔT ${s.meanDtC.toFixed(2)}±${s.sdDtC.toFixed(2)} °C  ${s.meanPowerW.toFixed(0)} W  Q ${f.qKw.toFixed(1)} kW  flow PG50 ${f.flowPg50LMin.toFixed(1)} / water ${f.flowWaterLMin.toFixed(1)} L/min`);
      }
    }
  } finally {
    await store.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
