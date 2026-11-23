/**
 * @purpose #285 (2026-11-10): the morning DHW pre-boost lands in the hour before the window and survives the hourly
 * replan. Since #249 the boost reached 130 °F by 06:00 on 4 of 7 mornings. When the rolling sag p90 fell from 15 to
 * 10 °F on Nov 2 the "warmest lead hour + standby allowance" rule fitted under the 135 °F cap and moved the boost to
 * 03:00, where the 120 °F floor blocks at 04:00 and 05:00 let the charge coast to 122–128 °F by the showers; every
 * hourly replan then re-placed it on the current lead hour (04:00, then 05:00 at 05:57 — too late to charge). Now:
 *   (a) the boost is the hour before the bell, also across the DST change (the Nov 2 placement was NOT a DST bug —
 *       the lead arithmetic is on real instants — but the test pins it);
 *   (b) no block sits between the boost and the window, so no floor block can lower the target before the showers;
 *   (c) a replan late in the lead hours keeps the boost the history placed on the current hour, at the target the
 *       auto-pilot commanded — no rewrite, no extra HBX write;
 *   (d) a normal day still boosts once per window, sized floor + p90, capped at 135.
 * 2026-11 winter mornings lost the boost to the winter guard (Nov 8–16, every night at 32–40 °F — owner 2026-11-19:
 * the boost stays at its own target):
 *   (e) the as-found curve mimic (no demand floor) never cancels the boost: flag, target and reason stay, and the
 *       auto-pilot / identification driver still see an excursion;
 *   (f) (g) the demand floor raises the boost's target when it is higher, never lower, and the block stays the boost;
 *   (h) a boost already written on the current hour is kept when the learned windows shift under it (Nov 13);
 *   (i) with no shaped curve (every block written flat) raiseBoostsToGuard holds the boost hour at the guard's value;
 *   (j) warm weather (≥ 50 °F) is untouched.
 * Plain node:assert script under tsx like the other planner suites: npx tsx planner/src/preboost-timing.test.ts.
 */
process.env.TZ = "America/New_York"; // the planner runs in the house's zone (run.sh); the fall-back night is 2026-11-01
import assert from "node:assert/strict";
import { computeShadowPlan, priorExcursionsFromPlans, raiseBoostsToGuard, DEFAULT_OPTS, MAX_PREBOOST_F, type ForecastHour, type ShadowBlock, type ShadowOpts } from "./shadow";
import { AutoPilot, curveDecision } from "./autopilot";
import { planConflictAhead } from "./identify";
import { boostWindows, mergeWindows } from "./dhw";

// A November night like Nov 2 2026: falling overnight, 03:00 the warmest lead hour of [3, 4, 5]. Below the winter
// guard, but with no demand floor and cfg = null the winter pass changes nothing (as bank-memory.test.ts).
const TEMPS: number[] = [46, 45, 44, 43, 42, 42, 41, 42, 45, 48, 51, 54, 56, 57, 57, 56, 54, 51, 49, 48, 47, 47, 46, 46];
/** 24 forecast hours from a local instant, stepped by real hours (so the repeated 01:00 of the fall-back night is in it). */
function forecastFrom(startMs: number): ForecastHour[] {
  return Array.from({ length: 24 }, (_, k) => {
    const ts = new Date(startMs + k * 3600_000);
    return { ts, outdoorF: TEMPS[ts.getHours()] };
  });
}
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const hourOf = (b: ShadowBlock) => new Date(b.ts).getHours();
// The live shape: learned peaks merged with DHW_SHOWER_WINDOWS=06:30-10:00 → [6,10), p90 10.2 °F over 37 draws; the
// afternoon peak's sag is contaminated (21.8) and capped. Floor windows cover the whole day on this house.
const morning = { windowStart: 6, windowEnd: 10, boostF: 10, sagP75F: 8.1, sagP90F: 10.2, n: 37 };
const afternoon = { windowStart: 15, windowEnd: 17, boostF: 22, sagP75F: 13.5, sagP90F: 21.8, n: 9 };
const opts = { ...DEFAULT_OPTS, dhwWindows: [[0, 24]] as [number, number][], preBoosts: [morning, afternoon] };
type Stored = { computedAt: Date; plan: ShadowBlock[] };
/** The hourly recompute at d/h:m — the forecast starts at the current (partial) hour, the memory is the stored history. */
function planAt(d: number, h: number, m: number, history: Stored[], o: { memory?: boolean; preBoosts?: typeof opts.preBoosts } = {}): Stored {
  const now = local(d, h, m);
  const prior = o.memory === false ? [] : priorExcursionsFromPlans(history, now);
  const plan = computeShadowPlan(forecastFrom(local(d, h)), null, { ...opts, preBoosts: o.preBoosts ?? opts.preBoosts, priorExcursions: prior }, null, false);
  return { computedAt: new Date(now), plan };
}
const morningBoost = (p: Stored, d: number) => p.plan.find((b) => b.boost && new Date(b.ts).getDate() === d && hourOf(b) < 6);
/** ONLY=ac runs blocks (a) and (c) alone — used to show each block fails on its own against the pre-fix shadow.ts. */
const run = (k: string) => !process.env.ONLY || process.env.ONLY.includes(k);

(async () => {

// (a) PLACEMENT across the DST change: the night of 2026-11-01 repeats 01:00 EDT/EST; the boost for the 06:00 window
//     is the 05:00 block on Nov 1 and on Nov 2 — the hour before the bell, never the warmer 03:00.
if (run("a")) {
  assert.equal(new Date(2026, 10, 1, 1).getTimezoneOffset(), 240, "the test runs in America/New_York (01:00 Nov 1 is still EDT)");
  assert.equal(new Date(2026, 10, 2, 1).getTimezoneOffset(), 300, "…and Nov 2 is EST");
  const nov1 = planAt(1, 0, 19, []);
  assert.equal(nov1.plan.filter((b) => hourOf(b) === 1 && new Date(b.ts).getDate() === 1).length, 2, "the fall-back night carries two 01:00 blocks");
  const b1 = morningBoost(nov1, 1);
  assert.ok(b1, "Nov 1 gets a morning boost");
  assert.equal(hourOf(b1), 5, `Nov 1 (fall-back night): the boost is the 05:00 block, got ${hourOf(b1)}:00`);
  assert.equal(b1.tank_target_f, 130, "floor 120 + p90 10, no standby allowance");
  const nov2 = planAt(2, 0, 19, []);
  const b2 = morningBoost(nov2, 2);
  assert.ok(b2, "Nov 2 gets a morning boost");
  assert.equal(hourOf(b2), 5, `Nov 2 (first full EST day): the boost is the 05:00 block, not the warmer 03:00 (got ${hourOf(b2)}:00)`);
  assert.equal(b2.tank_target_f, 130);
  assert.match(b2.reason, /^pre-boost to 130°F for 06:00 window \(sag p90 10.2°F over 37 draws; hour before the bell, 42°F\)$/);
  console.log("preboost-timing.test.ts (a) placement across DST: ok");
}

// (b) NO FLOOR BLOCK BETWEEN THE BOOST AND THE WINDOW: the block after the boost is the window's first, and nothing
//     from the boost to the bell commands less than the boost (the Nov 2–4 shape — boost 135 at 03:00, floor 120 at
//     04:00 and 05:00 — cannot be planned).
if (run("b")) {
  const p = planAt(2, 0, 19, []);
  const i = p.plan.findIndex((b) => b.boost && hourOf(b) < 6);
  assert.ok(i > 0, "a morning boost is planned");
  assert.equal(hourOf(p.plan[i + 1]), morning.windowStart, "the block right after the boost opens the window");
  const between = p.plan.slice(i, p.plan.findIndex((b, k) => k > i && hourOf(b) === morning.windowStart));
  assert.equal(between.length, 1, "no block lies between the boost and the window");
  assert.ok(between.every((b) => b.tank_target_f >= p.plan[i].tank_target_f), "nothing before the window commands below the boost");
  // the lead hours before the boost are the plain floor — the boost is written once, from one block
  for (const b of p.plan.slice(i - 2, i)) assert.equal(b.tank_target_f, DEFAULT_OPTS.dhwFloorF, `${hourOf(b)}:00 is the floor`);
  console.log("preboost-timing.test.ts (b) no floor block after the boost: ok");
}

// (c) A REPLAN LATE IN THE LEAD HOURS KEEPS THE BOOST IN FORCE. Nov 3: replans at 03:57, 04:57 and 05:57 (the Nov 3/4
//     timing). The 04:57 plan places the boost on 05:00; the auto-pilot writes it at ~05:02; the 05:57 replan — whose
//     only lead hour is the current one — keeps that block at its commanded target. No rewrite, no extra HBX write.
if (run("c")) {
  const p0357 = planAt(3, 3, 57, []);
  assert.equal(hourOf(morningBoost(p0357, 3)!), 5);
  const p0457 = planAt(3, 4, 57, [p0357]);
  const at05 = p0457.plan.find((b) => hourOf(b) === 5 && new Date(b.ts).getDate() === 3)!;
  assert.ok(at05.boost, "04:57: the boost sits on the 05:00 block");
  assert.equal(at05.tank_target_f, 130);
  assert.equal(p0457.plan[0].tank_target_f, DEFAULT_OPTS.dhwFloorF, "04:57: the current (04:00) block is the floor — no boost written at 04:00");
  // 05:57, the sag re-measured a degree deeper meanwhile (a draw at 05:30 read as sag): without memory the replan
  // would re-derive 133 and the auto-pilot would write it with minutes to go; with memory the 130 in force is kept.
  const deeper = [{ ...morning, boostF: 13, sagP90F: 13.1 }, afternoon];
  const p0557 = planAt(3, 5, 57, [p0357, p0457], { preBoosts: deeper });
  const kept = p0557.plan[0];
  assert.equal(hourOf(kept), 5, "05:57: the plan starts at the current (05:00) hour");
  assert.ok(kept.boost, "…and that block is still the boost");
  assert.equal(kept.tank_target_f, at05.tank_target_f, "…at the target the 04:57 plan placed (what the auto-pilot commanded)");
  assert.match(kept.reason, /^pre-boost to 130°F for 06:00 window \(sag p90 13.1°F over 37 draws; kept from the previous plan, 42°F\)$/);
  assert.equal(p0557.plan.filter((b) => b.boost && new Date(b.ts).getDate() === 3 && hourOf(b) < 10).length, 1, "one morning boost, not a second one");
  const noMemory = planAt(3, 5, 57, [p0357, p0457], { preBoosts: deeper, memory: false });
  assert.equal(noMemory.plan[0].tank_target_f, 133, "documents what the memory prevents: a re-derived 133 °F at 05:57");

  // The auto-pilot at 05:57, with the 05:00 boost already commanded at 05:02: the new plan reads "already commanded".
  const calls: number[] = [];
  const store = {
    recentPlans: async () => [{ plan: p0557.plan }],
    insertAutopilotLog: async () => {},
    activeBoost: async () => null,
  } as any;
  const writer = {
    status: async () => ({ commanded_target_f: at05.tank_target_f, curve_in_force: null }),
    setTarget: async (target: number) => { calls.push(target); return {}; },
    setCurve: async () => { throw new Error("no curve write expected"); },
  } as any;
  const realNow = Date.now;
  Date.now = () => local(3, 5, 57);
  try {
    const ap = new AutoPilot(store, writer, false, async () => {});
    await ap.applyLatestPlan();
    assert.deepEqual(calls, [], "no HBX write at 05:57 — the boost in force is kept");
    assert.match(ap.lastResult, /^holding 130°F \(pre-boost to 130°F for 06:00 window .*kept from the previous plan.*\) — already commanded$/);
    assert.equal(ap.lastPreBoost?.toF, 130, "/health.dhw.last_pre_boost still names the boost");
    // the window opens: the 06:00 block is the floor and the auto-pilot steps down once, as before
    Date.now = () => local(3, 6, 2);
    const p0602 = planAt(3, 6, 2, [p0357, p0457, p0557], { preBoosts: deeper });
    assert.equal(p0602.plan[0].tank_target_f, DEFAULT_OPTS.dhwFloorF, "06:02: the window floor");
    assert.equal(p0602.plan.filter((b) => b.boost && new Date(b.ts).getDate() === 3 && hourOf(b) < 10).length, 0, "the morning boost is spent for the day");
  } finally {
    Date.now = realNow;
  }
  console.log("preboost-timing.test.ts (c) late replan keeps the boost: ok");
}

// (d) A NORMAL DAY: one boost per window, in the hour before each bell, floor + p90 (rounded), capped at 135 and
//     saying so. Nov 5 shape (no DST, plan at 00:19).
if (run("d")) {
  const p = planAt(5, 0, 19, []);
  const boosts = p.plan.filter((b) => b.boost && new Date(b.ts).getDate() === 5);
  assert.equal(boosts.length, 2, "one boost per peak window");
  const [am, pm] = boosts;
  assert.equal(hourOf(am), 5); assert.equal(am.tank_target_f, DEFAULT_OPTS.dhwFloorF + Math.round(morning.sagP90F), "morning: floor + p90");
  assert.match(am.reason, /hour before the bell/); assert.doesNotMatch(am.reason, /standby|warmest/);
  assert.equal(hourOf(pm), 14); assert.equal(pm.tank_target_f, DEFAULT_OPTS.strictCapF, `afternoon: 120 + ${MAX_PREBOOST_F} = 136 → 135`);
  assert.match(pm.reason, /capped at \+16; hour before the bell/);
  assert.ok(boosts.every((b) => b.hp1_setpoint_f >= b.tank_target_f + DEFAULT_OPTS.i1MarginF), "Phase B leads the setpoints off each boost (I1)");
  // the plan is byte-identical to a plan with no memory on a day the history has nothing for
  assert.deepEqual(planAt(5, 0, 19, [], { memory: false }).plan, p.plan);
  console.log("preboost-timing.test.ts (d) normal day: ok");
}

// ---- 2026-11 winter mornings lost the boost to the winter guard ------------------------------------------------------
// Nov 15 2026 (EST, no DST). One learned peak [3,10) with p90 10 °F over 37 draws → the boost is the 02:00 block at
// floor 120 + 10 = 130. Outdoor 32 °F all night: the as-found curve below gives exactly 135 °F at 32 °F
// (150 + (32 − 2) × (120 − 150) / (62 − 2)), the number the Nov 8–16 guard blocks carried.
const coldCfg = { dot: 2, wwsd: 62, dbt: 150, mbt: 120 };
const earlyPeak = { windowStart: 3, windowEnd: 10, boostF: 10, sagP75F: 8.1, sagP90F: 10.2, n: 37 };
const flat = (f: number) => (startMs: number): ForecastHour[] => Array.from({ length: 24 }, (_, k) => ({ ts: new Date(startMs + k * 3600_000), outdoorF: f }));
type ColdPlan = { cfg?: Record<string, number> | null; floor?: { tankTargetF: number; bindingZone: string; awtF: number } | null; prior?: ShadowOpts["priorExcursions"]; outdoorF?: number; preBoosts?: typeof opts.preBoosts; o?: Partial<ShadowOpts> };
function coldPlanAt(d: number, h: number, p: ColdPlan = {}): ShadowBlock[] {
  const forecast = flat(p.outdoorF ?? 32)(local(d, h));
  const o: ShadowOpts = { ...opts, preBoosts: p.preBoosts ?? [earlyPeak], priorExcursions: p.prior ?? [], ...(p.o ?? {}) };
  return computeShadowPlan(forecast, p.cfg === undefined ? coldCfg : p.cfg, o, p.floor ?? null, false);
}
const at = (plan: ShadowBlock[], h: number) => plan.find((b) => hourOf(b) === h)!;

// (e) THE CURVE MIMIC NEVER CANCELS THE BOOST. No demand floor, the as-found curve at 135 °F: the 02:00 block is still
//     the boost at 130 with its pre-boost reason, the auto-pilot classifies it as an excursion (a flat write, not the
//     ~120 °F shaped curve the Nov 8–16 mornings got) and the identification driver keeps its distance. The hours
//     around it are the guard's mimic blocks as before, and the boost records the 135 it declined (guard_f).
if (run("e")) {
  const plan = coldPlanAt(15, 0);
  const b = at(plan, 2);
  assert.equal(b.boost, true, "02:00 is still the boost under the winter guard");
  assert.equal(b.tank_target_f, 130, "…at its own target, not the 135 °F curve");
  assert.match(b.reason, /^pre-boost to 130°F for 03:00 window \(sag p90 10.2°F over 37 draws; hour before the bell, 32°F\)$/);
  assert.equal(b.guard_f, 135, "the block records what the guard would have written");
  assert.ok(b.hp1_setpoint_f >= b.tank_target_f + DEFAULT_OPTS.i1MarginF, "Phase B still leads the setpoint off the boost (I1)");
  assert.equal(curveDecision(b).kind, "excursion", "the auto-pilot writes the boost flat, never the shaped curve through it");
  assert.equal(planConflictAhead(plan, local(15, 1), 3), true, "the identification driver sees the boost and stands down");
  assert.equal(plan.filter((x) => x.boost).length, 1, "one boost");
  for (const h of [0, 1, 3, 4]) {
    assert.equal(at(plan, h).tank_target_f, 135, `${h}:00 is the guard's mimic`);
    assert.equal(at(plan, h).reason, "winter guard: mimic HBX curve");
    assert.equal(at(plan, h).guard_f, undefined, "guard_f rides only on a boost block");
  }
  // a curve BELOW the boost records nothing (the guard would not have raised the block): 128 °F at 32 °F, so the
  // band's curve + 3 ceiling (131) still admits the 130
  const mild = at(coldPlanAt(15, 0, { cfg: { dot: 2, wwsd: 62, dbt: 143, mbt: 113 } }), 2);
  assert.equal(mild.tank_target_f, 130); assert.equal(mild.guard_f, undefined);
  console.log("preboost-timing.test.ts (e) the winter guard's curve mimic keeps the boost: ok");
}

// (f) A DEMAND FLOOR ABOVE THE BOOST raises the boost's target to the floor and says so; the block is still the boost.
//     (The everyday band caps every non-soak block at strictCapF, so the 137 is observed with the cap at 140; with the
//     default cap the same block is 135 — the floor clamped like its neighbours — and still the boost.)
if (run("f")) {
  const floor = { tankTargetF: 137, bindingZone: "Living Room Baseboard", awtF: 133 };
  const b = at(coldPlanAt(15, 0, { floor, o: { strictCapF: 140 } }), 2);
  assert.equal(b.boost, true, "02:00 is still the boost under the demand floor");
  assert.equal(b.tank_target_f, 137, "max(boost 130, floor 137)");
  assert.match(b.reason, /^pre-boost to 130°F for 03:00 window .* — raised to the demand floor 137°F \(binding zone: Living Room Baseboard needs 133°F/);
  assert.equal(curveDecision(b).kind, "excursion");
  const capped = at(coldPlanAt(15, 0, { floor }), 2);
  assert.equal(capped.boost, true); assert.equal(capped.tank_target_f, DEFAULT_OPTS.strictCapF, "default cap: the floor is clamped to 135, the boost identity stays");
  assert.match(capped.reason, /^pre-boost to 130°F .* — raised to the demand floor 137°F/);
  console.log("preboost-timing.test.ts (f) demand floor above the boost: ok");
}

// (g) A DEMAND FLOOR BELOW THE BOOST leaves it alone: 130, boost, the plain pre-boost reason.
if (run("g")) {
  const plan = coldPlanAt(15, 0, { floor: { tankTargetF: 125, bindingZone: "Dining", awtF: 121 } });
  const b = at(plan, 2);
  assert.equal(b.boost, true); assert.equal(b.tank_target_f, 130);
  assert.match(b.reason, /^pre-boost to 130°F for 03:00 window/); assert.doesNotMatch(b.reason, /raised to the demand floor/);
  assert.equal(b.guard_f, undefined, "the floor branch raises the target itself; nothing to record");
  assert.ok(plan.filter((x) => !x.boost).every((x) => x.tank_target_f === 125 && /^binding zone/.test(x.reason)), "every other block is the floor");
  console.log("preboost-timing.test.ts (g) demand floor below the boost: ok");
}

// (h) A WINDOW SHIFT UNDER A RUNNING BOOST (Nov 13 2026): the 03:21 plan boosted 04:00 for a [5,10) window and the
//     auto-pilot wrote 131 at 04:06; the 04:21 replan learned [3,10) — 04:00 now INSIDE the peak, a lead hour of
//     nothing — and dropped the block to the 120 °F floor. The started boost is kept at its commanded 131.
if (run("h")) {
  const prior = [{ ts: new Date(local(13, 4)).toISOString(), boost: true, tank_target_f: 131 }];
  const p = computeShadowPlan(forecastFrom(local(13, 4)), null, { ...opts, preBoosts: [earlyPeak], priorExcursions: prior }, null, false);
  const b = p[0];
  assert.equal(hourOf(b), 4, "the plan starts at the current (04:00) hour");
  assert.equal(b.boost, true, "04:21: the boost written at 04:06 is kept");
  assert.equal(b.tank_target_f, 131, "…at its commanded target");
  assert.match(b.reason, /^pre-boost to 131°F \(kept from the previous plan/);
  assert.equal(p.filter((x) => x.boost && new Date(x.ts).getDate() === 13 && hourOf(x) < 10).length, 1, "no second morning boost (02:00 is in the past, 03:00+ is the peak)");
  const dropped = computeShadowPlan(forecastFrom(local(13, 4)), null, { ...opts, preBoosts: [earlyPeak] }, null, false)[0];
  assert.equal(dropped.tank_target_f, DEFAULT_OPTS.dhwFloorF, "documents what the memory prevents: the floor at 04:21, showers an hour away");
  // the kept boost also survives the winter guard (rule 1 holds for it too), and is capped at strictCapF
  const cold = coldPlanAt(13, 4, { prior });
  assert.equal(cold[0].boost, true); assert.equal(cold[0].tank_target_f, 131); assert.equal(cold[0].guard_f, 135);
  assert.match(cold[0].reason, /^pre-boost to 131°F \(kept from the previous plan/);
  const over = coldPlanAt(13, 4, { prior: [{ ...prior[0], tank_target_f: 150 }], cfg: null })[0];
  assert.equal(over.tank_target_f, DEFAULT_OPTS.strictCapF, "a stored target above the cap is capped");
  // a window still leading from the kept hour names itself, as in (c): peaks back at [5,10) → "for 05:00 window"
  const same = computeShadowPlan(forecastFrom(local(13, 4)), null, { ...opts, preBoosts: [{ ...earlyPeak, windowStart: 5 }], priorExcursions: prior }, null, false)[0];
  assert.equal(same.boost, true); assert.equal(same.tank_target_f, 131);
  assert.match(same.reason, /^pre-boost to 131°F for 05:00 window \(sag p90 10.2°F over 37 draws; kept from the previous plan/);
  // a soak on the hour keeps its own identity — a prior boost never relabels it
  const soaked = computeShadowPlan(forecastFrom(local(13, 4)), null, { ...opts, preBoosts: [earlyPeak], priorExcursions: prior }, null, true, true)[0];
  assert.equal(soaked.sani, true); assert.equal(soaked.boost, undefined);
  console.log("preboost-timing.test.ts (h) window shift keeps the running boost: ok");
}

// (i) DEGRADED MODE (no shaped curve stamped → every block written flat): raiseBoostsToGuard lifts a boost block to
//     its guard_f, re-leads the HP line, keeps the pre-boost identity, and returns every other block as the same object.
if (run("i")) {
  const plan = coldPlanAt(15, 0);
  const held = raiseBoostsToGuard(plan, DEFAULT_OPTS);
  const b = at(held, 2);
  assert.equal(b.boost, true); assert.equal(b.tank_target_f, 135, "130 → the guard's 135");
  assert.equal(b.hp1_setpoint_f, 135 + DEFAULT_OPTS.i1MarginF, "HP line re-led: target + margin, under strictCap + margin");
  assert.match(b.reason, /^pre-boost to 130°F for 03:00 window .*; held at the winter guard's 135°F/);
  assert.equal(curveDecision(b).kind, "excursion");
  for (let i = 0; i < plan.length; i++) if (i !== plan.indexOf(at(plan, 2))) assert.equal(held[i], plan[i], `block ${i} is untouched (same object)`);
  assert.deepEqual(plan.filter((x) => x.boost)[0].tank_target_f, 130, "pure: the input plan is not mutated");
  // hand-built edge cases: no guard_f, guard_f at or below the target, a non-boost block with a stray guard_f
  const mk = (x: Partial<ShadowBlock>): ShadowBlock => ({ ts: "2026-11-15T07:00:00.000Z", outdoor_f: 32, tank_target_f: 130, hp1_setpoint_f: 135, reason: "pre-boost to 130°F", boost: true, ...x });
  const edge = [mk({}), mk({ guard_f: 130 }), mk({ guard_f: 128 }), mk({ boost: undefined, guard_f: 135, reason: "winter guard: mimic HBX curve" }), mk({ guard_f: 135, bank: true })];
  const out = raiseBoostsToGuard(edge, DEFAULT_OPTS);
  for (let i = 0; i < 4; i++) assert.equal(out[i], edge[i], `edge ${i} untouched`);
  assert.equal(out[4].tank_target_f, 135);
  // nothing to hold on a warm plan or a floor-raised plan (no guard_f anywhere)
  assert.deepEqual(raiseBoostsToGuard(coldPlanAt(15, 0, { outdoorF: 55, cfg: { dot: 5, wwsd: 125, dbt: 165, mbt: 145 } }), DEFAULT_OPTS), coldPlanAt(15, 0, { outdoorF: 55, cfg: { dot: 5, wwsd: 125, dbt: 165, mbt: 145 } }));
  console.log("preboost-timing.test.ts (i) degraded mode holds the boost at the guard: ok");
}

// (j) WARM CONTROL: at 55 °F the winter pass does not run — the plan with the as-found curve is byte-identical to the
//     plan without it (the band's ceiling is strictCap either way), carries no guard_f, and boosts 02:00 at 130.
if (run("j")) {
  const asFound = { dot: 5, wwsd: 125, dbt: 165, mbt: 145 }; // the prod baseline: 156.7 °F at 55 °F → ceiling strictCap
  const warm = coldPlanAt(15, 0, { outdoorF: 55, cfg: asFound });
  assert.deepEqual(warm, coldPlanAt(15, 0, { outdoorF: 55, cfg: null }), "no cfg effect above the winter guard");
  assert.ok(warm.every((b) => b.guard_f === undefined), "no guard_f anywhere");
  const b = at(warm, 2);
  assert.equal(b.boost, true); assert.equal(b.tank_target_f, 130);
  assert.match(b.reason, /^pre-boost to 130°F for 03:00 window \(sag p90 10.2°F over 37 draws; hour before the bell, 55°F\)$/);
  assert.ok(warm.filter((x) => !x.boost).every((x) => x.tank_target_f === DEFAULT_OPTS.dhwFloorF && x.reason === "DHW window floor"), "every other block is the floor, as before");
  // the same with a demand floor below the guard threshold's reach: the winter pass is skipped at 55 °F regardless
  assert.deepEqual(coldPlanAt(15, 0, { outdoorF: 55, cfg: asFound, floor: { tankTargetF: 137, bindingZone: "x", awtF: 133 } }), warm, "a demand floor is a winter-pass input only");
  console.log("preboost-timing.test.ts (j) warm control unchanged: ok");
}

// (k) THE DECLARED SHOWER WINDOW GETS ITS OWN BOOST HOUR (2026-11-23). Heating-season zone load reads as draws, so the
//     learned peaks were [2,6) and [7,13); with 06:00–10:00 declared the plain union was one window [2,13) and the only
//     morning boost was the 01:00 block, five hours before the showers. boostWindows keeps 05:00 out of every window, so
//     the 06:00 window is boosted there. Sags are fixed here: this pins where the boosts land, not their size.
if (run("k")) {
  const learnedPeaks: [number, number][] = [[2, 6], [7, 13], [16, 17], [18, 19], [20, 23]];
  const asBoosts = (ws: [number, number][]) => ws.map(([a, b]) => ({ windowStart: a, windowEnd: b, boostF: 10, sagP75F: 7, sagP90F: 9.7, n: 40 }));
  const boostHours = (p: Stored) => p.plan.filter((b) => b.boost && new Date(b.ts).getDate() === 24 && hourOf(b) < 13).map(hourOf);
  const before = planAt(24, 0, 19, [], { preBoosts: asBoosts(mergeWindows(learnedPeaks, [[6, 10]])) });
  assert.deepEqual(boostHours(before), [1], "the plain union: one boost at 01:00, none before the 06:00 showers");
  const after = planAt(24, 0, 19, [], { preBoosts: asBoosts(boostWindows(learnedPeaks, [[6, 10]])) });
  assert.deepEqual(boostHours(after), [1, 5], "the night peak keeps its 01:00 boost and the declared window gets 05:00");
  const b5 = after.plan.find((b) => new Date(b.ts).getDate() === 24 && hourOf(b) === 5)!;
  assert.equal(b5.tank_target_f, 130);
  assert.match(b5.reason, /^pre-boost to 130°F for 06:00 window /);
  // nothing else moves: every block from 13:00 on is identical under both rules
  const tail = (p: Stored) => p.plan.filter((b) => new Date(b.ts).getDate() === 24 && hourOf(b) >= 13);
  assert.deepEqual(tail(after), tail(before), "afternoon and evening blocks are unchanged");
  console.log("preboost-timing.test.ts (k) the declared window gets its own boost hour: ok");
}

console.log("preboost-timing.test.ts: all assertions passed ✓");
})().catch((e) => { console.error(e); process.exit(1); });
