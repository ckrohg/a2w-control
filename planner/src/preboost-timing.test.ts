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
 * Plain node:assert script under tsx like the other planner suites: npx tsx planner/src/preboost-timing.test.ts.
 */
process.env.TZ = "America/New_York"; // the planner runs in the house's zone (run.sh); the fall-back night is 2026-11-01
import assert from "node:assert/strict";
import { computeShadowPlan, priorExcursionsFromPlans, DEFAULT_OPTS, MAX_PREBOOST_F, type ForecastHour, type ShadowBlock } from "./shadow";
import { AutoPilot } from "./autopilot";

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

console.log("preboost-timing.test.ts: all assertions passed ✓");
})().catch((e) => { console.error(e); process.exit(1); });
