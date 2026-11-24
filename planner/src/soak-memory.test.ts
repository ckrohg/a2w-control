/**
 * @purpose A soak gets a full hour (2026-11-24). The plan is recomputed at :42 and the forecast starts at the hour in
 * progress, so a soak placed on that hour was written at ~:47 and replaced at ~:07 — ~15 min at 140 °F, never the 30-min
 * dwell (11 of 47 soaks over 8 weeks); and the old 3 h "due" floor re-soaked a cooling day within 12 h of a dwell (15 of
 * 47). Pins shadow.ts with ShadowOpts.priorExcursionsKnown (keep a soak in progress, never place a new one on the hour
 * in progress, a two-block overdue soak, one soak per day when the dwell is not measured) and that without the flag the
 * plan is exactly the old one. Plain node:assert script under tsx like the other planner suites:
 * node --import ./hub/node_modules/tsx/dist/loader.mjs planner/src/soak-memory.test.ts.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, priorExcursionsFromPlans, DEFAULT_OPTS, type DemandFloor, type ForecastHour, type ShadowBlock } from "./shadow";
import { AutoPilot } from "./autopilot";

// 2026-11-24's shape in LOCAL components (the TZ env makes the Date getters local, so day grouping and the warmest-hour
// pick are deterministic on any machine): a cooling day whose warmest hour is midnight (the night is warmer than the
// day after it), a small afternoon bump, a falling evening; the 25th rises. All below the winter guard, so cfg = null
// keeps the curve mimic out (test 8 brings it in).
const NOV24: number[] = [48, 46, 44, 42, 40, 38, 36, 35, 35, 36, 38, 40, 42, 43, 44, 43, 42, 41, 40, 38, 36, 34, 33, 32];
const tempOf = (ts: Date) => ts.getDate() === 23 ? 46 : ts.getDate() === 24 ? NOV24[ts.getHours()] : 20 + ts.getHours();
/** 24 forecast hours starting at the hour in progress (h may be -1 = 23:00 on the 23rd; Date normalises). */
function forecastFrom(h: number): ForecastHour[] {
  return Array.from({ length: 24 }, (_, k) => { const ts = new Date(2026, 10, 24, h + k); return { ts, outdoorF: tempOf(ts) }; });
}
const at = (h: number, m = 42) => new Date(2026, 10, 24, h, m).getTime();
type Stored = { computedAt: Date; plan: ShadowBlock[] };
/** known: undefined = true (the live default), null = the field omitted, else the value given. */
type Opt = { due?: boolean; urgent?: boolean; known?: boolean | null; measured?: boolean; cfg?: Record<string, any> | null; floor?: DemandFloor | null };
/** The hourly recompute at h:42 with the stored history as the memory (known / measured default to true). */
function planAt(h: number, history: Stored[], o: Opt = {}): Stored {
  const prior = priorExcursionsFromPlans(history, at(h));
  const opts = { ...DEFAULT_OPTS, priorExcursions: prior,
    ...(o.known === undefined ? { priorExcursionsKnown: true } : o.known === null ? {} : { priorExcursionsKnown: o.known }),
    sanitizeDueMeasured: o.measured ?? true };
  const plan = computeShadowPlan(forecastFrom(h), o.cfg ?? null, opts, o.floor ?? null, o.due ?? false, o.urgent ?? false);
  return { computedAt: new Date(at(h)), plan };
}
/** The plan as computed before 2026-11-24: no memory at all. */
const oldPlan = (h: number, due: boolean, urgent = false, cfg: Record<string, any> | null = null) =>
  computeShadowPlan(forecastFrom(h), cfg, DEFAULT_OPTS, null, due, urgent);
const soaks = (p: Stored | ShadowBlock[]) => (Array.isArray(p) ? p : p.plan).filter((b) => b.sani).map((b) => { const d = new Date(b.ts); return `${d.getDate()}@${d.getHours()}`; });
const KNOWN_ABSENT = null; // planAt: omit priorExcursionsKnown entirely

// 1. THE COOLING-DAY REPLAY (2026-11-24): soak on 00:00, kept through its hour, nothing while resting, then a FUTURE hour.
{
  const p2342 = planAt(-1, [], { due: true });
  assert.deepEqual(soaks(p2342), ["24@0"], "23:42: the 24th's warmest hour is midnight — the soak goes there (23:00 is a 1-block day)");
  const p0042 = planAt(0, [p2342], { due: true });
  assert.ok(p0042.plan[0].sani, "00:42, still due: the hour in progress is still the soak");
  assert.ok(p0042.plan[0].tank_target_f >= 140);
  assert.match(p0042.plan[0].reason, /sanitize.*kept from the previous plan/);
  assert.deepEqual(soaks(p0042), ["24@0"], "and it is the day's only soak");
  const p0142 = planAt(1, [p2342, p0042], { due: false });
  assert.deepEqual(soaks(p0142), [], "01:42, dwell qualified: no soak");
  const p0842 = planAt(8, [p2342, p0042, p0142], { due: false });
  const p0942 = planAt(9, [p2342, p0042, p0142, p0842], { due: false });
  assert.deepEqual(soaks(p0842), [], "08:42 resting: no soak block");
  assert.deepEqual(soaks(p0942), [], "09:42 resting: no soak block");
  const p1742 = planAt(17, [p2342, p0042, p0142, p0842, p0942], { due: true });
  assert.ok(!p1742.plan[0].sani, "17:42 on a falling evening: never the hour in progress");
  assert.deepEqual(soaks(p1742).filter((s) => s.startsWith("24@")), ["24@18"], "…the warmest FUTURE hour of the day");
  assert.ok(!oldPlan(17, true)[1].sani && oldPlan(17, true)[0].sani, "documents the defect: the old plan soaked 17:00 (written ~17:47, gone at ~18:07)");
  const p1842 = planAt(18, [p2342, p0042, p0142, p0842, p0942, p1742], { due: true });
  assert.ok(p1842.plan[0].sani && /kept from the previous plan/.test(p1842.plan[0].reason), "18:42: the 18:00 soak keeps its hour");
  assert.deepEqual(soaks(p1842).filter((s) => s.startsWith("24@")), ["24@18"]);
}

// 2. FALLING AFTERNOON, due, empty history: the old plan soaks the hour in progress; with the memory, the next-warmest hour.
{
  assert.deepEqual(soaks(planAt(14, [], { due: true, known: KNOWN_ABSENT })).filter((s) => s.startsWith("24@")), ["24@14"], "no flag: today's behaviour, pinned");
  assert.deepEqual(soaks(oldPlan(14, true)).filter((s) => s.startsWith("24@")), ["24@14"]);
  assert.deepEqual(soaks(planAt(14, [], { due: true })).filter((s) => s.startsWith("24@")), ["24@15"], "flag: the warmest of the remaining FUTURE hours");
}

// 3. KEPT TARGET: the commanded target is kept, floored at sanitizeF, capped at sanitizeCapF; nothing is kept when not due.
{
  const hist = (t: number): Stored[] => [{ computedAt: new Date(at(-1)), plan: [{ ts: new Date(2026, 10, 24, 0).toISOString(), outdoor_f: 48, tank_target_f: t, hp1_setpoint_f: t + 5, reason: "daily sanitize", sani: true }] }];
  assert.equal(planAt(0, hist(145), { due: true }).plan[0].tank_target_f, 145);
  assert.equal(planAt(0, hist(140), { due: true }).plan[0].tank_target_f, 140);
  assert.equal(planAt(0, hist(150), { due: true }).plan[0].tank_target_f, DEFAULT_OPTS.sanitizeCapF, "above the cap → the cap");
  assert.equal(planAt(0, hist(150), { due: true }).plan[0].hp1_setpoint_f, DEFAULT_OPTS.sanitizeCapF + DEFAULT_OPTS.i1MarginF);
  const noTarget: Stored[] = [{ computedAt: new Date(at(-1)), plan: [{ ts: new Date(2026, 10, 24, 0).toISOString(), sani: true } as any] }];
  assert.equal(planAt(0, noTarget, { due: true }).plan[0].tank_target_f, DEFAULT_OPTS.sanitizeF, "no stored target → sanitizeF");
  const off = planAt(0, hist(145), { due: false });
  assert.ok(!off.plan[0].sani, "not due: the soak may end before its hour does");
  assert.equal(off.plan[0].tank_target_f, DEFAULT_OPTS.dhwFloorF);
}

// 4. OVERDUE: with the flag the hour in progress AND the next are the backstop; without it only the hour in progress.
{
  const re = /^OVERDUE sanitize to 140°F = 60°C \(I8 window lapsed — earliest hour, not the warmest\)$/;
  for (const h of [3, 17]) {
    const w = planAt(h, [], { due: true, urgent: true });
    assert.ok(w.plan[0].sani && w.plan[1].sani, `${h}:42 overdue: two blocks`);
    assert.match(w.plan[0].reason, re); assert.match(w.plan[1].reason, re);
    assert.ok(w.plan[0].tank_target_f >= 140 && w.plan[1].tank_target_f >= 140);
    assert.ok(!w.plan[2].sani, "and the day gets no further soak");
    const o = planAt(h, [], { due: true, urgent: true, known: KNOWN_ABSENT });
    assert.ok(o.plan[0].sani && !o.plan[1].sani, `${h}:42 no flag: only the hour in progress (today)`);
    assert.deepEqual(o.plan, oldPlan(h, true, true));
  }
  // an overdue soak that is already in progress keeps its commanded target (the kept rule runs after the backstop)
  const prev = planAt(2, [], { due: true, urgent: true });
  const kept = planAt(3, [prev], { due: true, urgent: true });
  assert.ok(kept.plan[0].sani && /OVERDUE sanitize.*kept from the previous plan/.test(kept.plan[0].reason));
  assert.ok(kept.plan[1].sani);
}

// 5. UNKNOWN HISTORY: without priorExcursionsKnown === true the plan is, block for block, the plan with no memory at all.
{
  for (const h of [-1, 0, 3, 9, 14, 17, 20]) {
    const t0 = new Date(2026, 10, 24, h);
    const hist: Stored[] = [{ computedAt: new Date(at(h) - 3600_000), plan: [
      { ts: new Date(t0.getTime() - 3600_000).toISOString(), outdoor_f: 40, tank_target_f: 140, hp1_setpoint_f: 145, reason: "daily sanitize", sani: true },
      { ts: t0.toISOString(), outdoor_f: 40, tank_target_f: 145, hp1_setpoint_f: 150, reason: "daily sanitize", sani: true },
    ] }];
    for (const [due, urgent] of [[false, false], [true, false], [true, true]] as const) {
      for (const cfg of [null, { dot: 0, wwsd: 60, dbt: 180, mbt: 140 }]) {
        const ref = oldPlan(h, due, urgent, cfg);
        for (const known of [KNOWN_ABSENT, false]) for (const measured of [true, false]) {
          const p = planAt(h, hist, { due, urgent, known, measured, cfg });
          assert.deepEqual(p.plan, ref, `h=${h} due=${due} urgent=${urgent} known=${known} measured=${measured} cfg=${!!cfg}`);
        }
      }
    }
  }
}

// 6. NOT MEASURED (auto-sanitize off: due is always true): one soak per day from the history; a soak in progress is kept.
{
  const nm = { due: true, measured: false };
  const p2342 = planAt(-1, [], nm);
  assert.deepEqual(soaks(p2342), ["24@0"]);
  const p0042 = planAt(0, [p2342], nm);
  assert.ok(p0042.plan[0].sani && /kept from the previous plan/.test(p0042.plan[0].reason), "the soak in progress keeps its hour");
  assert.deepEqual(soaks(p0042), ["24@0"]);
  const p0142 = planAt(1, [p2342, p0042], nm);
  assert.deepEqual(soaks(p0142), [], "01:42: the 24th had its soak — no second one");
  assert.deepEqual(soaks(planAt(1, [p2342, p0042], { due: true, measured: true })), ["24@2"], "(measured and still due: a new FUTURE soak is allowed)");
  assert.deepEqual(soaks(oldPlan(1, true)), ["24@1"], "documents the defect: the old plan re-soaked the hour in progress");
  const p1742 = planAt(17, [p2342, p0042, p0142], nm);
  assert.ok(!soaks(p1742).some((s) => s.startsWith("24@")), "17:42: still none on the 24th");
  assert.deepEqual(soaks(p1742).filter((s) => s.startsWith("25@")), ["25@16"], "the next day still gets its own soak");
  // measured absent (not exactly true) is "not measured"
  const absent = computeShadowPlan(forecastFrom(1), null, { ...DEFAULT_OPTS, priorExcursions: priorExcursionsFromPlans([p2342, p0042], at(1)), priorExcursionsKnown: true }, null, true, false);
  assert.deepEqual(soaks(absent), []);
}

// 7. A KEPT SOAK IN A COLD HOUR flows through the winter guard like a freshly placed soak: never below the kept target.
{
  const hist = (t: number): Stored[] => [{ computedAt: new Date(at(-1)), plan: [{ ts: new Date(2026, 10, 24, 0).toISOString(), outdoor_f: 48, tank_target_f: t, hp1_setpoint_f: t + 5, reason: "daily sanitize", sani: true }] }];
  const hot = { dot: 0, wwsd: 60, dbt: 180, mbt: 140 }; // 148 °F at 48 °F outdoor: the guard acts
  const mild = { dot: 0, wwsd: 60, dbt: 150, mbt: 110 }; // 118 °F at 48 °F: the guard leaves the soak alone
  for (const kept of [140, 145]) {
    const g = planAt(0, hist(kept), { due: true, cfg: hot }).plan[0];
    assert.ok(g.sani && g.tank_target_f >= kept, `curve guard: ${g.tank_target_f} ≥ kept ${kept}`);
    assert.match(g.reason, /sanitize.*kept from the previous plan.*raised to the as-found curve/);
    const m = planAt(0, hist(kept), { due: true, cfg: mild }).plan[0];
    assert.ok(m.sani && m.tank_target_f === kept, `mild curve: stays at ${kept}`);
    const f = planAt(0, hist(kept), { due: true, cfg: hot, floor: { tankTargetF: 150, bindingZone: "Den", awtF: 140 } }).plan[0];
    assert.ok(f.sani && f.tank_target_f >= kept, "demand floor: raised, never lowered");
    assert.match(f.reason, /sanitize.*kept.*raised to the demand floor/);
  }
}

// 8. END TO END — the real AutoPilot (flat-target mode) over the cooling day: plans land at :42, the auto-pilot polls at
//    :07 (rollover, previous plan) and :47 (the new plan). With the memory the soak is written ONCE per soak hour, at :07
//    of that hour, and never on an hour already in progress; without it the 17:00 and 18:00 soaks land at :47.
(async () => {
  const DUE = new Set([-1, 0, 17, 18]);
  async function rehearse(known: boolean): Promise<string[]> {
    const history: Stored[] = [];
    const writes: string[] = [];
    let commanded: number | null = 120;
    const store = {
      recentPlans: async () => history.filter((p) => p.computedAt.getTime() <= Date.now()),
      insertAutopilotLog: async () => {},
      activeBoost: async () => null,
    } as any;
    const writer = {
      status: async () => ({ commanded_target_f: commanded, curve_in_force: null }),
      setTarget: async (t: number) => { const n = new Date(Date.now()); writes.push(`${n.getHours()}:${String(n.getMinutes()).padStart(2, "0")}=${t}`); commanded = t; return {}; },
    } as any;
    const ap = new AutoPilot(store, writer, false, async () => {});
    const realNow = Date.now, realLog = console.log;
    console.log = () => {};
    try {
      history.push(planAt(-1, history, { due: true, known: known ? undefined : KNOWN_ABSENT }));
      for (let h = 0; h <= 19; h++) {
        Date.now = () => at(h, 7); await ap.applyLatestPlan();
        history.push(planAt(h, history, { due: DUE.has(h), known: known ? undefined : KNOWN_ABSENT }));
        Date.now = () => at(h, 47); await ap.applyLatestPlan();
      }
    } finally { Date.now = realNow; console.log = realLog; }
    return writes;
  }
  const before = await rehearse(false);
  assert.deepEqual(before, ["0:07=140", "1:07=120", "17:47=140", "18:07=120", "18:47=140", "19:07=120"],
    "documents the defect: on the falling evening the soak lands on the hour in progress at :47 and is gone at :07");
  const after = await rehearse(true);
  assert.deepEqual(after, ["0:07=140", "1:07=120", "18:07=140", "19:07=120"], "with the memory: one soak write per soak hour, at the top of it");
  assert.ok(!after.some((w) => /:47=140$/.test(w)), "never a soak write on an hour in progress");
  console.log("soak-memory.test.ts: all assertions passed ✓");
})().catch((e) => { console.error(e); process.exit(1); });
