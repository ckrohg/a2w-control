/**
 * @purpose A soak gets a full hour (2026-11-24). The plan is recomputed at :42 and the forecast starts at the hour in
 * progress, so a soak placed on that hour was written at ~:47 and replaced at ~:07 — ~15 min at 140 °F, never the 30-min
 * dwell (11 of 47 soaks over 8 weeks); and the old 3 h "due" floor re-soaked a cooling day within 12 h of a dwell (15 of
 * 47). Pins shadow.ts in memory mode, ShadowOpts.priorExcursionsKnown AND sanitizeDueMeasured (keep a soak in progress,
 * never place a new one on the hour in progress, a two-block overdue soak, a new soak no later than sanitizeLimitMs, at
 * most SOAK_MAX_RUN_H soak hours in a row) and that without either flag the plan is exactly the old one. Plain
 * node:assert script under tsx like the other planner suites:
 * node --import ./hub/node_modules/tsx/dist/loader.mjs planner/src/soak-memory.test.ts.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, priorExcursionsFromPlans, DEFAULT_OPTS, SOAK_MAX_RUN_H, type DemandFloor, type ForecastHour, type ShadowBlock } from "./shadow";
import { soakDue, SOAK_LEAD_H } from "./hygiene";
import { AutoPilot } from "./autopilot";

// 2026-11-24's shape in LOCAL components (the TZ env makes the Date getters local, so day grouping and the warmest-hour
// pick are deterministic on any machine): a cooling day whose warmest hour is midnight (the night is warmer than the
// day after it), a small afternoon bump, a falling evening; the 25th rises. All below the winter guard, so cfg = null
// keeps the curve mimic out (test 8 brings it in).
const NOV24: number[] = [48, 46, 44, 42, 40, 38, 36, 35, 35, 36, 38, 40, 42, 43, 44, 43, 42, 41, 40, 38, 36, 34, 33, 32];
const tempOf = (ts: Date) => ts.getDate() === 23 ? 46 : ts.getDate() === 24 ? NOV24[ts.getHours()] : 20 + ts.getHours();
/** 24 forecast hours starting at the hour in progress (h may be -1 = 23:00 on the 23rd; Date normalises). */
function forecastFrom(h: number, temp: (ts: Date) => number = tempOf): ForecastHour[] {
  return Array.from({ length: 24 }, (_, k) => { const ts = new Date(2026, 10, 24, h + k); return { ts, outdoorF: temp(ts) }; });
}
const at = (h: number, m = 42) => new Date(2026, 10, 24, h, m).getTime();
type Stored = { computedAt: Date; plan: ShadowBlock[] };
/** known / measured: undefined = true (the live default), null = the field omitted, else the value given. limit: the
 *  key absent = sanitizeLimitMs omitted, else the value given. temp: the forecast's outdoor temperature (default NOV24). */
type Opt = { due?: boolean; urgent?: boolean; known?: boolean | null; measured?: boolean | null; cfg?: Record<string, any> | null; floor?: DemandFloor | null;
  limit?: number | null; temp?: (ts: Date) => number; rested?: boolean };
/** The hourly recompute at h:42 with the stored history as the memory (known / measured default to true). */
function planAt(h: number, history: Stored[], o: Opt = {}): Stored {
  const prior = priorExcursionsFromPlans(history, at(h));
  const opts = { ...DEFAULT_OPTS, priorExcursions: prior,
    ...(o.known === undefined ? { priorExcursionsKnown: true } : o.known === null ? {} : { priorExcursionsKnown: o.known }),
    ...(o.measured === null ? {} : { sanitizeDueMeasured: o.measured ?? true }),
    ...("limit" in o ? { sanitizeLimitMs: o.limit } : {}), ...("rested" in o ? { sanitizeRested: o.rested } : {}) };
  const plan = computeShadowPlan(forecastFrom(h, o.temp), o.cfg ?? null, opts, o.floor ?? null, o.due ?? false, o.urgent ?? false);
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

// 5. NO MEMORY MODE: without priorExcursionsKnown === true, or (history readable) without sanitizeDueMeasured === true,
//    the plan is, block for block, the plan with no memory at all — no per-day memory for the unmeasured mode.
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
        const cases: [boolean | null, boolean | null][] = [[KNOWN_ABSENT, true], [KNOWN_ABSENT, false], [false, true], [false, false],
          [true, false], [true, null], [KNOWN_ABSENT, null]];
        for (const [known, measured] of cases) for (const limit of [undefined, at(h) + 5 * 3600_000, at(h) - 3600_000]) {
          const p = planAt(h, hist, { due, urgent, known, measured, cfg, ...(limit === undefined ? {} : { limit }) });
          assert.deepEqual(p.plan, ref, `h=${h} due=${due} urgent=${urgent} known=${known} measured=${measured} limit=${limit} cfg=${!!cfg}`);
        }
      }
    }
  }
}

// 6. THE LIMIT (review fix 1): the 12 h rest can push "due" past the last warm hour before the interval runs out. Replay
//    of the review's example: the last qualifying dwell ended 07:00 on the 24th, interval 26 h → lapses 09:00 on the
//    25th, limit = 07:00 + (26 − SOAK_LEAD_H) h = 05:30 on the 25th. Every day's warmest hour is 14:00.
{
  const peak = (h0: number) => (ts: Date) => 40 - Math.abs(ts.getHours() - h0);
  const dwellEnd = new Date(2026, 10, 24, 7).getTime();
  const limit = dwellEnd + (26 - SOAK_LEAD_H) * 3600_000;
  assert.equal(limit, new Date(2026, 10, 25, 5, 30).getTime());
  const gate = (h: number) => soakDue((at(h) - dwellEnd) / 3600_000, 26);
  const history: Stored[] = [];
  const replay = (h: number) => { const p = planAt(h, history, { ...gate(h), limit, temp: peak(14) }); history.push(p); return p; };
  for (let h = 8; h <= 17; h++) replay(h);
  assert.ok(!history.some((p) => soaks(p).length), "08:42–17:42: resting, no soak");
  const p1842 = replay(18);
  assert.equal(gate(18).due, false, "18:42 is 11.7 h after the dwell");
  assert.deepEqual(soaks(p1842), [], "18:42 (not due): no soak");
  const p1942 = replay(19);
  assert.equal(gate(19).due, true);
  assert.ok(!soaks(p1942).some((s) => s.startsWith("24@")), "19:42: the 24th has 5 blocks left — no soak on it");
  assert.deepEqual(soaks(p1942), ["25@5"], "the 25th's soak is on 05:00, the last hour that starts by 05:30 — not on 14:00");
  const b = p1942.plan.find((x) => x.sani)!;
  assert.equal(b.reason, "daily sanitize to 140°F = 60°C (I8 pasteurization, last hour before the interval runs out)");
  assert.ok(b.tank_target_f >= 140);
  assert.deepEqual(soaks(planAt(19, history.slice(0, -1), { due: true, temp: peak(14) })), ["25@14"],
    "documents the defect: without the limit the soak waits for 14:00 on the 25th, 31 h after the dwell");
  for (let h = 20; h <= 28; h++) assert.deepEqual(soaks(replay(h)), ["25@5"], `${h % 24}:42: the soak stays on 05:00`);
  const p0542 = replay(29);
  assert.ok(p0542.plan[0].sani && /kept from the previous plan/.test(p0542.plan[0].reason), "05:42 on the 25th: the soak keeps its hour");

  // Not binding: the warmest future hour starts before the limit → the warmest hour, with the unchanged reason.
  const free = planAt(9, [], { due: true, limit: new Date(2026, 10, 24, 20, 30).getTime() });
  assert.deepEqual(soaks(free), ["24@14"]);
  assert.equal(free.plan.find((x) => x.sani)!.reason, "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)");
  // null, undefined (key present or absent) and NaN: the plan without a limit.
  for (const h of [-1, 1, 9, 14, 17]) for (const [due, urgent] of [[false, false], [true, false], [true, true]] as const) {
    const ref = planAt(h, [], { due, urgent });
    for (const l of [null, undefined, NaN, Infinity]) assert.deepEqual(planAt(h, [], { due, urgent, limit: l }).plan, ref.plan, `h=${h} limit=${l}`);
  }
  assert.deepEqual(soaks(planAt(1, [], { due: true })), ["24@2"], "(still due at 01:42: a new FUTURE soak, never the hour in progress)");

  // The limit has already passed (before every future hour): do not wait for the lapse — the soak takes the next hour.
  const early = planAt(9, [], { due: true, limit: new Date(2026, 10, 24, 9, 30).getTime() });
  assert.deepEqual(soaks(early), ["24@10"]);
  assert.equal(early.plan.find((x) => x.sani)!.reason, "daily sanitize to 140°F = 60°C (I8 pasteurization, the interval is about to run out)");
  // The limit falls this evening and the day has fewer than 6 blocks left (the day-skip): the last hour that starts by it.
  const evening = planAt(19, [], { due: true, limit: new Date(2026, 10, 24, 21, 30).getTime(), temp: peak(14) });
  assert.deepEqual(soaks(evening), ["24@21"]);
  assert.match(evening.plan.find((x) => x.sani)!.reason, /last hour before the interval runs out/);
  assert.ok(!evening.plan[0].sani, "never the hour in progress");
  // …and with the limit beyond the horizon nothing is forced: the day-skip stands, tomorrow's warmest hour is planned.
  const far = planAt(19, [], { due: true, limit: new Date(2026, 10, 26, 12).getTime(), temp: peak(14) });
  assert.deepEqual(soaks(far), ["25@14"]);
  // A short forecast (5 blocks: every day is skipped). The limit beyond it forces nothing; the limit inside it does.
  const short = (limit: number) => computeShadowPlan(forecastFrom(19, peak(14)).slice(0, 5), null,
    { ...DEFAULT_OPTS, priorExcursions: [], priorExcursionsKnown: true, sanitizeDueMeasured: true, sanitizeLimitMs: limit }, null, true, false);
  assert.deepEqual(soaks(short(new Date(2026, 10, 25, 12).getTime())), [], "limit beyond the forecast: the next plan covers it");
  assert.deepEqual(soaks(short(new Date(2026, 10, 24, 21, 30).getTime())), ["24@21"]);

  // Afternoon: the day's warmest hour is 16:00, the limit 15:30 → 15:00.
  const pm = planAt(9, [], { due: true, limit: new Date(2026, 10, 24, 15, 30).getTime(), temp: peak(16) });
  assert.deepEqual(soaks(pm), ["24@15"]);
  assert.match(pm.plan.find((x) => x.sani)!.reason, /last hour before the interval runs out/);
  assert.deepEqual(soaks(planAt(9, [], { due: true, temp: peak(16) })).filter((s) => s.startsWith("24@")), ["24@16"], "(without the limit: 16:00)");
}

// 7. THE CAP (review fix 2): at most SOAK_MAX_RUN_H consecutive soak hours.
{
  assert.equal(SOAK_MAX_RUN_H, 3);
  // Overdue for good, hourly recomputes from 03:42: the hour in force from :07 (the previous plan's [1]) and from :47
  // (this plan's [0]) is a soak at 03, 04, 05; not 06; 07, 08, 09; not 10.
  const history: Stored[] = [];
  const isSoak: boolean[] = [];
  for (let h = 3; h <= 10; h++) {
    const prev = history[history.length - 1];
    const p = planAt(h, history, { due: true, urgent: true });
    history.push(p);
    if (prev) assert.equal(prev.plan[1].sani === true, p.plan[0].sani === true, `${h}:00 is the same soak/not before and after :42`);
    isSoak.push(p.plan[0].sani === true);
    if (!p.plan[0].sani) {
      assert.equal(p.plan[0].tank_target_f, DEFAULT_OPTS.dhwFloorF, `${h}:00 refused: its normal target`);
      assert.doesNotMatch(p.plan[0].reason, /sanitize/, `${h}:00 refused: its normal reason`);
    }
  }
  assert.deepEqual(isSoak, [true, true, true, false, true, true, true, false]);

  // A kept soak: one or two soak hours before it → kept; three → not.
  const soakAt = (hs: number[]): Stored[] => [{ computedAt: new Date(at(-2)), plan: hs.map((h) => (
    { ts: new Date(2026, 10, 24, h).toISOString(), outdoor_f: 40, tank_target_f: 140, hp1_setpoint_f: 145, reason: "daily sanitize", sani: true })) }];
  assert.ok(/kept from the previous plan/.test(planAt(12, soakAt([12]), { due: true }).plan[0].reason), "an ordinary kept soak: one hour, unaffected");
  assert.ok(planAt(12, soakAt([10, 11, 12]), { due: true }).plan[0].sani, "third consecutive hour: kept");
  const fourth = planAt(12, soakAt([9, 10, 11, 12]), { due: true });
  assert.ok(!fourth.plan[0].sani && fourth.plan[0].tank_target_f === DEFAULT_OPTS.dhwFloorF, "fourth consecutive hour: not kept");
  assert.ok(planAt(12, soakAt([8, 10, 11, 12]), { due: true }).plan[0].sani, "a gap breaks the run");

  // A NEW soak on draft[1] as the 4th consecutive hour: 23:00 kept after 21:00 and 22:00, the 25th warmest at 00:00.
  const cool25 = (ts: Date) => ts.getDate() === 25 ? 50 - ts.getHours() : 30;
  assert.deepEqual(soaks(planAt(23, soakAt([23]), { due: true, temp: cool25 })), ["24@23", "25@0"], "(no run: the 25th's warmest, 00:00)");
  assert.deepEqual(soaks(planAt(23, soakAt([21, 22, 23]), { due: true, temp: cool25 })), ["24@23", "25@1"], "00:00 would be the 4th: next-warmest");
  // …and on draft[2] (review of ae4b5ec): overdue with a soak at 21:00 behind it marks 22:00 and 23:00; today has 2 blocks
  // left, so the day loop reaches the 25th, whose warmest hour 00:00 is draft[2] and would be the 4th in a row.
  assert.deepEqual(soaks(planAt(22, soakAt([21]), { due: true, urgent: true, temp: cool25 })), ["24@22", "24@23", "25@1"], "00:00 would be the 4th: next-warmest");
  assert.deepEqual(soaks(planAt(22, [], { due: true, urgent: true, temp: cool25 })), ["24@22", "24@23", "25@0"], "(no soak at 21:00: 00:00 is the 3rd, allowed)");
}

// 8. A KEPT SOAK IN A COLD HOUR flows through the winter guard like a freshly placed soak: never below the kept target.
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

// 8b. THE INTERVAL LENGTHENS MID-SOAK (found replaying 8 weeks: Oct 14 and Nov 11): the soak was planned under the 26 h
//     interval, then the outdoor reading crossed 55 °F, the interval became 60 h and "due" turned off with no dwell
//     behind it. The soak in progress keeps its hour while no dwell has qualified (sanitizeRested); nothing new is planned.
{
  const p0842 = planAt(8, [], { due: true, limit: new Date(2026, 10, 24, 9, 30).getTime() });
  assert.deepEqual(soaks(p0842), ["24@9"], "08:42, limit 09:30: the soak is planned on 09:00");
  const flip = planAt(9, [p0842], { due: false, rested: true });
  assert.ok(flip.plan[0].sani && flip.plan[0].tank_target_f >= 140, "09:42, not due but no dwell yet: the soak keeps its hour");
  assert.match(flip.plan[0].reason, /^daily sanitize.*kept from the previous plan/);
  assert.deepEqual(soaks(flip), ["24@9"], "and nothing else is planned while not due");
  assert.deepEqual(soaks(planAt(9, [p0842], { due: false, rested: false })), [], "its dwell has qualified: the soak may end before its hour does");
  assert.deepEqual(soaks(planAt(9, [p0842], { due: false })), [], "sanitizeRested absent: kept only while due (as before)");
  assert.deepEqual(soaks(planAt(9, [p0842], { due: false, rested: true, measured: false })), [], "outside memory mode nothing is kept");
  assert.deepEqual(soaks(planAt(9, [p0842], { due: false, rested: true, known: KNOWN_ABSENT })), []);
  // The hour after: the kept soak is not carried into the next hour.
  assert.deepEqual(soaks(planAt(10, [p0842, flip], { due: false, rested: true })), [], "10:42: the soak had its hour; nothing is kept beyond it");
  // The cap still binds: a soak the history placed on the hour in progress is not kept as the 4th consecutive soak hour.
  const soakAt = (hs: number[]): Stored[] => [{ computedAt: new Date(at(-2)), plan: hs.map((h) => (
    { ts: new Date(2026, 10, 24, h).toISOString(), outdoor_f: 40, tank_target_f: 140, hp1_setpoint_f: 145, reason: "daily sanitize", sani: true })) }];
  assert.deepEqual(soaks(planAt(8, soakAt([6, 7, 8]), { due: false, rested: true })), ["24@8"], "the 3rd hour is kept");
  assert.deepEqual(soaks(planAt(8, soakAt([5, 6, 7, 8]), { due: false, rested: true })), [], `the ${SOAK_MAX_RUN_H + 1}th hour is not kept`);
}

// 9. END TO END — the real AutoPilot (flat-target mode) over the cooling day: plans land at :42, the auto-pilot polls at
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
