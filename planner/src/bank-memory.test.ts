/**
 * @purpose Rolling-horizon fix for the #58 afternoon bank (2026-10-20): the bank is chosen ONCE per local day, with
 * the plan history as the memory (shadow.ts priorExcursionsFromPlans + ShadowOpts.priorExcursions). Before this the
 * hourly recompute re-banked the CURRENT hour on every falling afternoon — the forecast starts at the current hour,
 * so "the warmest remaining hour" was always now — and the auto-pilot wrote the floor at :04 from the old plan and
 * the bank at :19 from the new one (2026-10-19 15:04–18:19: hbx_writes 1372–1379, eight accepted writes in four
 * hours; 101 of the 145 bank writes since Sep 1 were the second write in their hour). Plain node:assert script under
 * tsx like the other planner suites: npx tsx planner/src/bank-memory.test.ts.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, priorExcursionsFromPlans, DEFAULT_OPTS, type ForecastHour, type ShadowBlock } from "./shadow";
import { AutoPilot } from "./autopilot";

// 2026-10-19's shape in LOCAL components (the TZ env makes the Date getters local, so day grouping and the warmest-hour
// pick are deterministic on any machine): the afternoon falls from a 14:00 peak, the next day is a cool rising morning
// that still earns its own (future) bank. Hours below the winter guard are kept off the curve mimic by cfg = null.
const TEMPS: Record<number, number> = { 13: 56, 14: 58, 15: 57, 16: 55, 17: 52, 18: 49, 19: 47, 20: 45, 21: 44, 22: 43, 23: 42 };
function forecastFrom(startH: number, temps: Record<number, number> = TEMPS): ForecastHour[] {
  return Array.from({ length: 24 }, (_, k) => {
    const ts = new Date(2026, 9, 19, startH + k); // normalises past midnight
    return { ts, outdoorF: ts.getDate() === 19 ? temps[ts.getHours()] : 36 + ts.getHours() };
  });
}
const opts = { ...DEFAULT_OPTS, bankF: 8 };
const at = (h: number, m = 19) => new Date(2026, 9, 19, h, m).getTime();
type Stored = { computedAt: Date; plan: ShadowBlock[] };
/** The hourly recompute at h:19: the forecast starts at the current (partial) hour, the memory is the stored history. */
function planAt(h: number, history: Stored[], opt: { sanitizeDue?: boolean; memory?: boolean; temps?: Record<number, number> } = {}): Stored {
  const prior = opt.memory === false ? [] : priorExcursionsFromPlans(history, at(h));
  const plan = computeShadowPlan(forecastFrom(h, opt.temps), null, { ...opts, priorExcursions: prior }, null, opt.sanitizeDue ?? false);
  return { computedAt: new Date(at(h)), plan };
}
const bankHours = (p: Stored, day = 19) => p.plan.filter((b) => b.bank && new Date(b.ts).getDate() === day).map((b) => new Date(b.ts).getHours());
const soakHours = (p: Stored, day = 19) => p.plan.filter((b) => b.sani && new Date(b.ts).getDate() === day).map((b) => new Date(b.ts).getHours());

// 1. THE DEFECT, documented: without memory every hourly recompute from the peak onward banks the CURRENT hour —
//    one bank per hour, not per day — until fewer than 6 hours of the day remain.
{
  assert.deepEqual(bankHours(planAt(13, [], { memory: false })), [14], "before the peak the bank sits on the peak hour");
  for (const h of [14, 15, 16, 17, 18]) assert.deepEqual(bankHours(planAt(h, [], { memory: false })), [h], `no memory: the ${h}:19 recompute re-banks ${h}:00`);
  assert.deepEqual(bankHours(planAt(19, [], { memory: false })), [], "…until <6 h of day are left (where production stopped flapping)");
}

// 2. WITH memory the day gets ONE bank: the hour the history chose is kept while it is current, and is spent after.
{
  const p13 = planAt(13, []);
  assert.deepEqual(bankHours(p13), [14]);
  const p14 = planAt(14, [p13]);
  assert.deepEqual(bankHours(p14), [14], "the 14:19 recompute keeps the bank on 14:00 (already commanded at 14:04)");
  const kept = p14.plan.find((b) => b.bank)!;
  assert.equal(kept.tank_target_f, opts.dhwFloorF + 8);
  assert.match(kept.reason, /afternoon bank to 128°F .*kept from the previous plan/, "the reason still reads as a bank (poster, identification, curveDecision) and says it was kept");
  const p15 = planAt(15, [p13, p14]);
  assert.deepEqual(bankHours(p15), [], "15:19: the day's bank is spent — no re-bank of 15:00");
  assert.equal(bankHours(p15, 20).length, 1, "tomorrow still gets its own (future) bank");
  const p16 = planAt(16, [p13, p14, p15]);
  assert.deepEqual(bankHours(p16), [], "the memory carries through a plan that itself carried no bank (the history still has 14:00)");
  assert.deepEqual(bankHours(planAt(17, [p13, p14, p15, p16])), []);
  // the 15:00 block is the plain floor, exactly what the old plan said for it at 15:04
  assert.equal(p15.plan[0].tank_target_f, opts.dhwFloorF);
  assert.equal(p15.plan[0].reason, p14.plan[1].reason);
}

// 3. SOAK DAY IS THE BANK — also after the soak hour has left the horizon (the 2026-10-19 case: soak at 14:00,
//    then "afternoon bank to 128°F" on 15:00, 16:00, 17:00, 18:00).
{
  const p13 = planAt(13, [], { sanitizeDue: true });
  assert.deepEqual(soakHours(p13), [14]); assert.deepEqual(bankHours(p13), [], "a soak day plans no bank");
  const p15old = planAt(15, [p13], { sanitizeDue: false, memory: false });
  assert.deepEqual(bankHours(p15old), [15], "documents the defect: once the soak hour is out of the horizon the old plan banks");
  const p15 = planAt(15, [p13], { sanitizeDue: false });
  assert.deepEqual(bankHours(p15), [], "with memory the soak spent the day — no bank after it");
  assert.deepEqual(bankHours(planAt(16, [p13, p15])), []);
}

// 4. A pinned bank survives the <6 h rule: the bank an earlier plan put on a future hour is still kept when that hour
//    arrives with only 5 hours of day left — otherwise the recompute would drop the bank in the very hour it was written.
{
  const temps = { ...TEMPS, 18: 50, 19: 53, 20: 47 }; // 19:00 is the warmest of 18–23
  const p18 = planAt(18, [], { temps });
  assert.deepEqual(bankHours(p18), [19], "6 h left: the bank is planned on 19:00");
  assert.deepEqual(bankHours(planAt(19, [], { temps, memory: false })), [], "no memory: 5 h left → the bank vanishes at 19:19");
  assert.deepEqual(bankHours(planAt(19, [p18], { temps })), [19], "with memory the commanded bank stays on 19:00");
}

// 5. The soak outranks a pinned bank: when the recompute puts the soak on the pinned hour the block is the soak, not a bank.
{
  const temps = { ...TEMPS, 17: 50, 18: 53, 19: 47 };
  const p17 = planAt(17, [], { temps });
  assert.deepEqual(bankHours(p17), [18]);
  const p18 = planAt(18, [p17], { temps, sanitizeDue: true });
  assert.deepEqual(soakHours(p18), [18]); assert.deepEqual(bankHours(p18), [], "the soak took the hour — one excursion identity per block");
  assert.ok(p18.plan[0].tank_target_f >= opts.sanitizeF);
}

// 6. The memory is per LOCAL DAY and per HOUR, and the newest plan covering an hour decides it.
{
  const yesterday: Stored = { computedAt: new Date(2026, 9, 18, 20, 19), plan: [{ ts: new Date(2026, 9, 18, 15).toISOString(), outdoor_f: 60, tank_target_f: 128, hp1_setpoint_f: 133, reason: "afternoon bank", bank: true }] };
  assert.deepEqual(bankHours(planAt(13, [yesterday])), [14], "yesterday's bank does not spend today");
  // an old plan banked 14:00, a newer plan covering 14:00 moved it: the newer plan was the one in force
  const older: Stored = { computedAt: new Date(at(12)), plan: [{ ts: new Date(2026, 9, 19, 14).toISOString(), outdoor_f: 58, tank_target_f: 128, hp1_setpoint_f: 133, reason: "afternoon bank", bank: true }] };
  const newer: Stored = { computedAt: new Date(at(13)), plan: [{ ts: new Date(2026, 9, 19, 14).toISOString(), outdoor_f: 58, tank_target_f: 120, hp1_setpoint_f: 125, reason: "DHW window floor" }, { ts: new Date(2026, 9, 19, 16).toISOString(), outdoor_f: 55, tank_target_f: 128, hp1_setpoint_f: 133, reason: "afternoon bank", bank: true }] };
  assert.deepEqual(priorExcursionsFromPlans([older, newer], at(14, 30)), [], "newest plan wins per hour; the 16:00 bank has not started");
  assert.deepEqual(priorExcursionsFromPlans([newer, older], at(14, 30)), [], "…whatever order the rows arrive in (computedAt sorts them)");
  assert.deepEqual(priorExcursionsFromPlans([older, newer], at(16, 30)).map((e) => [new Date(e.ts).getHours(), e.bank, e.sani]), [[16, true, false]]);
  const soak: Stored = { computedAt: new Date(at(13)), plan: [{ ts: new Date(2026, 9, 19, 14).toISOString(), outdoor_f: 58, tank_target_f: 140, hp1_setpoint_f: 145, reason: "daily sanitize", sani: true }] };
  assert.deepEqual(priorExcursionsFromPlans([soak, { plan: "not a plan" } as any, { plan: null } as any], at(14)).map((e) => e.sani), [true], "a soak is remembered; malformed rows are skipped");
  assert.deepEqual(priorExcursionsFromPlans([], at(14)), []);
}

// 7. END TO END — the auto-pilot over the 2026-10-19 afternoon: plans land at :19, the auto-pilot polls at :04 and :19
//    (shaped-curve mode, as live). Before the fix: curve 120 at :04, bank 128 at :19, every hour (eight writes); with the
//    memory: ONE command per hour that changes, none in the hours that do not.
(async () => {
  const CURVE = { dot: 28, wwsd: 125, dbt: 120, mbt: 118 };
  async function rehearse(memory: boolean): Promise<{ hour: number; kind: string; target: number }[]> {
    const history: Stored[] = [];
    const planned = (h: number) => history.push(planAt(h, history, { memory }));
    const writes: { hour: number; kind: string; target: number }[] = [];
    let commanded: number | null = 120, inForce: Record<string, number> | null = null;
    const store = {
      recentPlans: async () => history.filter((p) => p.computedAt.getTime() <= Date.now()).map((p) => ({ computedAt: p.computedAt, plan: p.plan.map((b) => ({ ...b, shaped_curve: CURVE })) })),
      insertAutopilotLog: async () => {},
      activeBoost: async () => null,
    } as any;
    const writer = {
      status: async () => ({ commanded_target_f: commanded, curve_in_force: inForce }),
      setTarget: async (t: number) => { writes.push({ hour: new Date(Date.now()).getHours(), kind: "set_target", target: t }); commanded = t; inForce = { dot: CURVE.dot, wwsd: CURVE.wwsd, dbt: t + 1, mbt: t - 3 }; return {}; },
      setCurve: async (c: typeof CURVE) => { writes.push({ hour: new Date(Date.now()).getHours(), kind: "set_curve", target: c.dbt }); commanded = c.dbt; inForce = { ...c }; return {}; },
    } as any;
    const ap = new AutoPilot(store, writer, false, async () => {}, true);
    const realNow = Date.now;
    try {
      planned(13);
      for (const h of [14, 15, 16, 17]) {
        Date.now = () => at(h, 4); await ap.applyLatestPlan();   // the hour rollover poll, on the previous plan
        planned(h);                                               // the hourly recompute at h:19
        Date.now = () => at(h, 19, ) + 30_000; await ap.applyLatestPlan(); // the first poll on the new plan
        Date.now = () => at(h, 24); await ap.applyLatestPlan();
      }
    } finally { Date.now = realNow; }
    return writes;
  }
  const before = await rehearse(false);
  assert.deepEqual(before.map((w) => `${w.hour}:${w.kind}=${w.target}`),
    ["14:set_target=128", "15:set_curve=120", "15:set_target=128", "16:set_curve=120", "16:set_target=128", "17:set_curve=120", "17:set_target=128"],
    "documents 2026-10-19: the floor at :04 and the bank at :19, every hour after the first");
  const after = await rehearse(true);
  assert.deepEqual(after.map((w) => `${w.hour}:${w.kind}=${w.target}`), ["14:set_target=128", "15:set_curve=120"],
    "with the memory: the bank once, the curve back once, then nothing — one command per hour that changes");
  const perHour = new Map<number, number>();
  for (const w of after) perHour.set(w.hour, (perHour.get(w.hour) ?? 0) + 1);
  assert.ok([...perHour.values()].every((n) => n === 1), "no hour gets two commands");
  console.log("bank-memory.test.ts: all assertions passed ✓");
})().catch((e) => { console.error(e); process.exit(1); });
