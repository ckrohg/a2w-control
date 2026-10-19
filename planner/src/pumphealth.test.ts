/**
 * @purpose Assertions for pumphealth.ts on REAL-shaped data: fixtures/pumphealth-20261018.json is 18 h of the Pi's own
 * samples (2026-10-17 20:00Z → 10-18 14:00Z, the first cold night, −3…7 °C) at the mirror's ~60 s cadence, with SPAN
 * samples RAW — consumption NEGATIVE, as the panel reports it. It holds pump1's 83-min stuck "defrost" while the HBX
 * called (02:07–03:29Z), seven normal 4–9 min defrosts, and pump2's real Modbus dropouts. Pins: the replay opens exactly
 * one episode (defrost_overlong, pump1) and nothing else; perturbing the real data trips each check; the sign of SPAN
 * watts does not matter; stale / gappy windows are "unknown" and move nothing; called_tank_flat; the daily rollup; the
 * 7-d vs 14-d trend; digest; DST day bounds. Run with: npx tsx planner/src/pumphealth.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PH, TREND, evaluatePump, evaluateTankFlat, PumpHealthWatch, parseLiveChecks, episodeKind, parseEpisodeKind, rollupDay, trend,
  digest, etDay, etDayStart, covered, type PumpReading, type SpanSample, type TankReading, type Verdict, type DayRow, type DayMetrics,
} from "./pumphealth";

const fx = JSON.parse(readFileSync(new URL("../fixtures/pumphealth-20261018.json", import.meta.url), "utf8"));
const R = (p: string): PumpReading[] => fx.readings[p].map(([ts, state, i, o, a]: [number, string, number, number, number]) =>
  ({ ts, online: true, state, inlet_c: i, outlet_c: o, ambient_c: a }));
const S = (n: string): SpanSample[] => fx.span[n].map(([ts, w]: [number, number]) => ({ ts, power_w: w }));
const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16);
const at = (hhmm: string) => Date.parse(`2026-10-18T${hhmm}:00Z`) / 1000;

/** Replay like index.ts: every 5 min, the data the planner would have seen at `now`. */
function replay(p: string, rd: PumpReading[], sp: SpanSample[]): { opens: { at: string; check: string; body: string }[]; closes: { at: string; check: string }[]; states: Record<string, number> } {
  const w = new PumpHealthWatch({ [p]: p });
  const opens: { at: string; check: string; body: string }[] = [], closes: { at: string; check: string }[] = [];
  const states: Record<string, number> = {};
  const t0 = rd[0].ts, t1 = rd[rd.length - 1].ts;
  for (let now = Math.ceil((t0 + PH.LOOKBACK_S) / 300) * 300; now <= t1; now += 300) {
    const v = evaluatePump(p, rd.filter((r) => r.ts <= now), sp.filter((s) => s.ts <= now), now);
    for (const x of v) states[`${x.kind}:${x.state}`] = (states[`${x.kind}:${x.state}`] ?? 0) + 1;
    for (const e of w.step(v)) (e.kind === "open" ? opens : closes).push({ at: iso(now), check: e.check, body: e.body } as never);
  }
  return { opens, closes, states };
}

// ── 1. REAL replay: exactly one episode — pump1's 83-min stuck defrost — and no false positive anywhere ─────────────────
{
  const p1 = replay("pump1", R("pump1"), S("Air-Water 1"));
  assert.deepEqual(p1.opens.map((o) => [o.at, o.check]), [["2026-10-18T02:30", "defrost_overlong"]], "pump1: only the stuck defrost opens");
  assert.match(p1.opens[0].body, /reports defrost continuously for 2[0-9] min/);
  assert.deepEqual(p1.closes.map((c) => [c.at, c.check]), [["2026-10-18T03:30", "defrost_overlong"]], "…and it closes when the unit leaves defrost (03:29Z)");
  for (const k of ["running_no_lift", "heating_no_draw", "idle_draw"]) assert.equal(p1.states[`${k}:tripped`] ?? 0, 0, `pump1 ${k} never trips on real data`);
  const p2 = replay("pump2", R("pump2"), S("Air-Water 2"));
  assert.deepEqual(p2.opens, [], "pump2: four normal defrosts at −3…1 °C, real Modbus dropouts — nothing opens");
  assert.ok((p2.states["defrost_overlong:unknown"] ?? 0) > 0, "pump2's real Modbus dropouts (02:11, 02:28Z) read as unknown, not ok");
}

// ── 2. Each check trips when the REAL data is perturbed the way the failure would look ─────────────────────────────────
const p1 = R("pump1"), s1 = S("Air-Water 1");
const steady = [at("06:50"), at("07:10")]; // pump1 heats 06:29–07:13Z at −2…0 °C, between two real defrosts
assert.ok(p1.filter((r) => r.ts >= steady[0] && r.ts <= steady[1]).every((r) => r.state === "heating"), "fixture premise: 06:50–07:10 all heating");
const verdict = (v: Verdict[], k: string) => v.find((x) => x.kind === k)!;
{
  // no lift: outlet = inlet + 0.5 °C while the compressor still draws its 5 kW (lost refrigerant, failed reversing valve)
  const rd = p1.map((r) => (r.ts >= steady[0] && r.ts <= steady[1] ? { ...r, outlet_c: (r.inlet_c as number) + 0.5 } : r));
  const v = evaluatePump("pump1", rd.filter((r) => r.ts <= steady[1]), s1.filter((s) => s.ts <= steady[1]), steady[1]);
  const x = verdict(v, "running_no_lift");
  assert.equal(x.state, "tripped", x.reason);
  assert.match(x.reason, /mean ΔT 0\.5 °C over 15 min of steady heating at [3-6]\d{3} W/);
  assert.equal(verdict(v, "heating_no_draw").state, "ok", "the compressor still draws — not a no-draw case");
  // the same pump unperturbed is fine (real ΔT ≈ 3–4 °C at −2 °C outdoor)
  const ok = verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= steady[1]), s1.filter((s) => s.ts <= steady[1]), steady[1]), "running_no_lift");
  assert.equal(ok.state, "ok"); assert.ok((ok.metrics.mean_dt_c as number) >= 3, `real steady ΔT ${ok.metrics.mean_dt_c}`);
}
{
  // heating, no draw: the circuit reads ~40 W (breaker tripped / contactor open) while the pump reports heating
  const sp = s1.map((s) => (s.ts >= steady[1] - 600 ? { ...s, power_w: -40 } : s));
  const x = verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= steady[1]), sp.filter((s) => s.ts <= steady[1]), steady[1]), "heating_no_draw");
  assert.equal(x.state, "tripped", x.reason);
  assert.equal(x.metrics.draw_w, 40, "magnitude of the NEGATIVE consumption");
  const nl = verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= steady[1]), sp.filter((s) => s.ts <= steady[1]), steady[1]), "running_no_lift");
  assert.notEqual(nl.state, "tripped", "no draw is heating_no_draw's case, never also no-lift");
}
{
  // idle draw: 3 kW on the circuit while the pump reports idle (stuck contactor / internal electric heater)
  const idleAt = at("13:50"); // pump1 idle since ~09:00Z
  assert.ok(p1.filter((r) => r.ts >= idleAt - 700 && r.ts <= idleAt).every((r) => r.state === "idle"), "fixture premise: pump1 idle at 13:40");
  const sp = s1.map((s) => (s.ts >= idleAt - 900 ? { ...s, power_w: -3000 } : s));
  const x = verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= idleAt), sp.filter((s) => s.ts <= idleAt), idleAt), "idle_draw");
  assert.equal(x.state, "tripped", x.reason);
  const real = verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= idleAt), s1.filter((s) => s.ts <= idleAt), idleAt), "idle_draw");
  assert.equal(real.state, "ok"); assert.ok((real.metrics.draw_w as number) < 100, `real idle draw ${real.metrics.draw_w} W`);
  // a single >1 kW idle sample (start/stop misalignment, measured ≤ 0.8 min) does not trip: the 9-min mean stays low
  const one = s1.map((s, i, a) => (s.ts <= idleAt && a[i + 1] && a[i + 1].ts > idleAt ? { ...s, power_w: -3800 } : s));
  assert.equal(verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= idleAt), one.filter((s) => s.ts <= idleAt), idleAt), "idle_draw").state, "ok");
}
{
  // SPAN sign does not matter: the same windows with POSITIVE watts give the same verdicts
  const flip = s1.map((s) => ({ ...s, power_w: s.power_w == null ? null : -s.power_w }));
  for (const now of [steady[1], at("02:40"), at("13:50")]) {
    const a = evaluatePump("pump1", p1.filter((r) => r.ts <= now), s1.filter((s) => s.ts <= now), now);
    const b = evaluatePump("pump1", p1.filter((r) => r.ts <= now), flip.filter((s) => s.ts <= now), now);
    assert.deepEqual(a.map((x) => [x.kind, x.state, x.metrics.draw_w ?? null]), b.map((x) => [x.kind, x.state, x.metrics.draw_w ?? null]), `sign-invariant at ${iso(now)}`);
  }
}
{
  // defrost suspends no-lift: the windows right after a real defrost (07:13–07:21Z) never count as steady
  for (const now of [at("07:25"), at("07:30"), at("07:35")]) {
    const rd = p1.map((r) => (r.ts > at("07:21") && r.ts <= now ? { ...r, outlet_c: r.inlet_c } : r));
    const x = verdict(evaluatePump("pump1", rd.filter((r) => r.ts <= now), s1.filter((s) => s.ts <= now), now), "running_no_lift");
    assert.equal(x.state, "ok", `${iso(now)}: within 20 min of a defrost the no-lift window is not steady (${x.reason})`);
  }
}

// ── 3. Stale-data gating (stagewatch's rule): unknown never opens or closes ────────────────────────────────────────────
{
  const now = steady[1];
  const stale = evaluatePump("pump1", p1.filter((r) => r.ts <= now - 240), s1.filter((s) => s.ts <= now), now);
  assert.ok(stale.every((x) => x.state === "unknown"), "newest reading 4 min old → every check unknown");
  assert.match(stale[0].reason, /newest mirror reading \d+ s old/);
  const gap = p1.filter((r) => r.ts <= now && !(r.ts > now - 600 && r.ts < now - 400)); // a 3-min hole mid-window
  assert.equal(verdict(evaluatePump("pump1", gap, s1.filter((s) => s.ts <= now), now), "running_no_lift").state, "unknown");
  const spanGap = s1.filter((s) => s.ts <= now && !(s.ts > now - 250 && s.ts < now - 100)); // a 2.5-min hole inside the 5-min window
  assert.equal(verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= now), spanGap, now), "heating_no_draw").state, "unknown", "a SPAN hole is unknown, never 'no draw'");
  assert.equal(verdict(evaluatePump("pump1", p1.filter((r) => r.ts <= now), [], now), "heating_no_draw").state, "unknown", "SPAN absent → unknown");
  // offline pump in an idle window → unknown, not ok
  const off = p1.map((r) => (r.ts > at("13:45") ? { ...r, online: false, state: "offline" } : r));
  assert.equal(verdict(evaluatePump("pump1", off.filter((r) => r.ts <= at("13:50")), s1, at("13:50")), "idle_draw").state, "unknown");

  // the watch: open, then unknown (moves nothing), then ok closes; restore() re-adopts and closes without re-opening
  const w = new PumpHealthWatch({ pump1: "Heat Pump 1" });
  const tr: Verdict = { kind: "defrost_overlong", pumpId: "pump1", state: "tripped", reason: "reports defrost continuously for 25 min", metrics: {} };
  const e1 = w.step([tr]);
  assert.equal(e1.length, 1); assert.equal(e1[0].title, "Heat Pump 1: stuck in defrost");
  assert.deepEqual(w.step([tr]), [], "still tripped → no second episode");
  assert.deepEqual(w.step([{ ...tr, state: "unknown", reason: "stale" }]), [], "unknown never closes");
  assert.equal(w.isOpen("defrost_overlong", "pump1"), true);
  assert.equal(w.step([{ ...tr, state: "ok", reason: "no defrost longer than 20 min" }])[0].kind, "close");
  const w2 = new PumpHealthWatch(); w2.restore([{ check: "idle_draw", pumpId: "pump2" }]);
  assert.deepEqual(w2.step([{ kind: "idle_draw", pumpId: "pump2", state: "tripped", reason: "x", metrics: {} }]), [], "a re-adopted episode does not re-open");
  assert.equal(w2.step([{ kind: "idle_draw", pumpId: "pump2", state: "ok", reason: "draws 8 W", metrics: {} }])[0].kind, "close");
  assert.deepEqual(w.status().pump1.defrost_overlong.state, "ok");
}

// ── 4. called_tank_flat (PROVISIONAL threshold) ────────────────────────────────────────────────────────────────────────
{
  const now = steady[1];
  const tankSeries = (f: (k: number) => number, called = [true, false]): TankReading[] =>
    Array.from({ length: 11 }, (_, k) => ({ ts: now - (10 - k) * 300 + 7, tank_f: f(k), stages_called: called }));
  const rd = p1.filter((r) => r.ts <= now), sp = s1.filter((s) => s.ts <= now);
  assert.ok(rd.filter((r) => r.ts >= now - 2700).filter((r) => r.state === "heating").length / rd.filter((r) => r.ts >= now - 2700).length >= 0.9, "fixture premise: ≥ 90 % heating 06:25–07:10 (the 06:21 defrost ends 06:29)");
  const flat = evaluateTankFlat("1", "pump1", rd, sp, tankSeries(() => 118), now, 0.017);
  assert.equal(flat.state, "tripped", flat.reason);
  assert.match(flat.reason, /pump ΔT 3\.\d °C at [3-6]\d{3} W/, "the detail carries the pump's own ΔT and draw (load vs pump)");
  assert.equal(evaluateTankFlat("1", "pump1", rd, sp, tankSeries((k) => 110 + k), now, 0.017).state, "ok", "rising 10 °F → ok");
  assert.equal(evaluateTankFlat("1", "pump1", rd, sp, tankSeries(() => 118, [false, true]), now, 0.017).state, "ok", "stage 1 not called → ok");
  const holey = tankSeries(() => 118).filter((_, k) => k < 3 || k > 5);
  assert.equal(evaluateTankFlat("1", "pump1", rd, sp, holey, now, 0.017).state, "unknown", "a 20-min HBX gap → unknown");
  // the pump idle most of the window (stage_unserved's case) → ok here
  const idleNow = at("13:50");
  assert.equal(evaluateTankFlat("1", "pump1", p1.filter((r) => r.ts <= idleNow), s1, tankSeries(() => 118).map((t) => ({ ...t, ts: t.ts - now + idleNow })), idleNow, 0.017).state, "ok");
  // a slowly falling tank still trips: standby credit (~0.8 °F) does not lift a −0.2 °F move past the 2 °F bar
  const fall = evaluateTankFlat("1", "pump1", rd, sp, tankSeries((k) => 120 - 0.02 * k), now, 0.017);
  assert.equal(fall.state, "tripped"); assert.ok((fall.metrics.standby_credit_f as number) > 0);
}

// ── 5. Daily rollup on the real 18 h ───────────────────────────────────────────────────────────────────────────────────
{
  const from = R("pump1")[0].ts, to = at("14:00") + 1;
  const m1 = rollupDay(R("pump1"), S("Air-Water 1"), from, to);
  const m2 = rollupDay(R("pump2"), S("Air-Water 2"), from, to);
  assert.ok(m1.kwh > 20 && m1.kwh < 40, `pump1 SPAN kWh ${m1.kwh} — positive from NEGATIVE watts`);
  assert.equal(m1.defrosts, 7, "pump1: 21:12, 22:50, 02:06 (the stuck one), 05:27, 06:20, 07:13, 08:49Z");
  assert.ok(m1.longest_defrost_min >= 80 && m1.longest_defrost_min <= 85, `longest ${m1.longest_defrost_min}`);
  assert.equal(m2.defrosts, 4);
  assert.ok(m2.longest_defrost_min <= 10);
  assert.ok(m1.kwh_heating <= m1.kwh && m1.kwh_heating > 0.8 * m1.kwh, "most energy is drawn while heating");
  assert.ok(m1.lift_index! > 0.6 && m1.lift_index! < 1.0, `pump1 lift index ${m1.lift_index} (doc: 0.78–0.81 at −5…5 °C)`);
  assert.ok(m2.lift_index! > m1.lift_index!, "pump2 sits above pump1 (the measured twin offset)");
  assert.ok(m1.max_starts_60min <= TREND.SHORT_CYCLE_STARTS_60);
  assert.equal(m1.span_coverage, 1); assert.ok(m2.reading_coverage < 1, "pump2's dropouts reduce reading coverage");
  const neg = rollupDay(R("pump1"), S("Air-Water 1").map((s) => ({ ...s, power_w: -(s.power_w as number) })), from, to);
  assert.equal(neg.kwh, m1.kwh, "kWh is sign-invariant");
}

// ── 6. Trend: own 14-d baseline and the twin ───────────────────────────────────────────────────────────────────────────
{
  const day = (d: number) => new Date(Date.parse("2026-11-01T12:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
  const m = (idx: number, runH = 1, starts = 2): DayMetrics => ({
    kwh: 5, kwh_heating: 5, span_coverage: 1, reading_coverage: 1, run_h: runH, starts, max_starts_60min: starts, defrosts: 0, defrost_min: 0,
    longest_defrost_min: 0, mean_dt_c: 4, mean_ambient_c: 2, lift_index: idx, bins: { "0": { deg_h: idx * 5, kwh: 5, run_h: runH } },
  });
  const rows = (f1: (d: number) => number, f2: (d: number) => number): DayRow[] => Array.from({ length: 21 }, (_, d) => [
    { day: day(d), pumpId: "pump1", m: m(f1(d)) }, { day: day(d), pumpId: "pump2", m: m(f2(d)) }]).flat();
  const stable = trend(rows(() => 0.8, () => 1.0), ["pump1", "pump2"], day(20));
  assert.deepEqual(stable.pumps.pump1.flags, []); assert.equal(stable.pumps.pump1.lift_drift!.pct, 0);
  assert.equal(stable.twin_flag, false, "the twins differ by ~20 % but STEADILY — no twin flag (learned ratio, not 1.0)");
  const sick = trend(rows((d) => (d >= 14 ? 0.6 : 0.8), () => 1.0), ["pump1", "pump2"], day(20));
  assert.deepEqual(sick.pumps.pump1.flags, ["lift_drift"]); assert.equal(sick.pumps.pump1.lift_drift!.pct, -25);
  assert.equal(sick.twin_flag, true); assert.equal(sick.twin!.pct, -25);
  assert.deepEqual(sick.pumps.pump2.flags, []);
  const both = trend(rows((d) => (d >= 14 ? 0.6 : 0.8), (d) => (d >= 14 ? 0.75 : 1.0)), ["pump1", "pump2"], day(20));
  assert.equal(both.twin_flag, false, "both fell together (weather/plumbing) — the twin ratio holds");
  const noisy = trend(rows((d) => (d >= 14 ? 0.72 : 0.8), () => 1.0), ["pump1", "pump2"], day(20));
  assert.deepEqual(noisy.pumps.pump1.flags, [], "−10 % is inside the measured noise (max 12.7 %)");
  const thin = trend(rows(() => 0.8, () => 1.0).map((r) => ({ ...r, m: { ...r.m, bins: { "0": { ...r.m.bins["0"], run_h: 0.1 } } } })), ["pump1", "pump2"], day(20));
  assert.equal(thin.pumps.pump1.lift_drift, null, "< 2 run-h per side → no comparison");
  const cyc = rows(() => 0.8, () => 1.0); cyc.find((r) => r.day === day(20) && r.pumpId === "pump2")!.m.max_starts_60min = 9;
  assert.deepEqual(trend(cyc, ["pump1", "pump2"], day(20)).pumps.pump2.flags, ["short_cycling"]);

  // digest
  const { title, body } = digest(day(20), rows((d) => (d >= 14 ? 0.6 : 0.8), () => 1.0), sick,
    [{ kind: "shadow_pump_defrost_overlong", pumpId: "pump1", title: "Heat Pump 1: stuck in defrost (shadow)", started_at: "2026-11-21T02:30:00.000Z", cleared_at: null }],
    {}, { pump1: "Heat Pump 1", pump2: "Heat Pump 2" }, new Set());
  assert.match(title, /^A2W pump health 2026-11-21: drift flagged$/);
  assert.match(body, /Heat Pump 1: 5\.0 kWh/); assert.match(body, /−?-25 % .*⚠ DRIFT/);
  assert.match(body, /stuck in defrost \(shadow\) — STILL OPEN \[shadow\]/);
  assert.match(body, /none live/);
  assert.match(digest(day(20), rows(() => 0.8, () => 1.0), stable, [], {}, {}, new Set()).title, /normal$/);
}

// ── 7. Config + episode kinds + day bounds ─────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual([...parseLiveChecks("idle_draw, defrost_overlong").live], ["idle_draw", "defrost_overlong"]);
  assert.equal(parseLiveChecks(undefined).live.size, 0, "default: everything shadow");
  assert.match(parseLiveChecks("idle_draw,bogus").error ?? "", /bogus/);
  assert.equal(episodeKind("idle_draw", false), "shadow_pump_idle_draw");
  assert.equal(episodeKind("idle_draw", true), "pump_idle_draw");
  assert.deepEqual(parseEpisodeKind("shadow_pump_running_no_lift"), { check: "running_no_lift", live: false });
  assert.deepEqual(parseEpisodeKind("pump_heating_no_draw"), { check: "heating_no_draw", live: true });
  assert.equal(parseEpisodeKind("stage_unserved"), null); assert.equal(parseEpisodeKind("pump_bogus"), null);
  assert.equal(etDayStart("2026-10-18"), Date.parse("2026-10-18T04:00:00Z") / 1000, "EDT midnight");
  assert.equal(etDayStart("2026-11-02"), Date.parse("2026-11-02T05:00:00Z") / 1000, "EST midnight (DST ended Nov 1)");
  assert.equal(etDayStart("2026-11-01"), Date.parse("2026-11-01T04:00:00Z") / 1000, "the 25-hour day starts in EDT");
  assert.equal(etDay(Date.parse("2026-10-18T03:59:00Z") / 1000), "2026-10-17");
  assert.equal(covered([{ ts: 0 }, { ts: 100 }, { ts: 200 }], 0, 200, 150)!.length, 3);
  assert.equal(covered([{ ts: 0 }, { ts: 200 }], 0, 200, 150), null);
}
console.log("pumphealth: all assertions passed");
