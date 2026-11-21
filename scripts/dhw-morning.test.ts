/**
 * @purpose node:assert checks for scripts/dhw-morning.ts on hand-built fixtures: a morning with the pre-boost planned
 * and written and a draw from 126 °F (OK), a morning with no boost and a draw from 118 °F (FAIL + NO_BOOST), a window
 * with no draws (NO_DRAWS), the lead hour of a window starting at hour 0 (the previous day's hour 23), the
 * planned_boost rule, the ±10 min nearest-reading lookup, and how hbx_writes rows are read. No database, no network.
 *
 * Run from the repo root:  node --import ./hub/node_modules/tsx/dist/loader.mjs scripts/dhw-morning.test.ts
 *            or planner/:  npx tsx ../scripts/dhw-morning.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_FAIL_BELOW_F, etInstant, etParts, shiftDay, daysBetween, leadFor, windowTimes, normalizeWindowsArg, parseWindowsArg,
  isPlannedBoost, blockAt, writeLevelF, shortRequested, classifyWrites, nearestTankF, findDraws, evaluateWindow,
  summarize, formatTable, formatSummary, type PlanRow, type SlxRow, type Window, type WriteRow,
} from "./dhw-morning";

const MIN = 60_000;

// ---- local time --------------------------------------------------------------------------------------------------
assert.equal(new Date(etInstant("2026-11-21", 6)).toISOString(), "2026-11-21T11:00:00.000Z", "06:00 EST");
assert.equal(new Date(etInstant("2026-07-04", 6)).toISOString(), "2026-07-04T10:00:00.000Z", "06:00 EDT");
assert.equal(etInstant("2026-11-21", 24), etInstant("2026-11-22", 0), "hour 24 is the next day's midnight");
assert.deepEqual(etParts(etInstant("2026-11-21", 23)), { day: "2026-11-21", hour: 23, minute: 0 });
assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
assert.deepEqual(daysBetween("2026-11-29", "2026-12-01"), ["2026-11-29", "2026-11-30", "2026-12-01"]);
assert.deepEqual(daysBetween("2026-11-22", "2026-11-21"), []);

// ---- (d) lead hour -----------------------------------------------------------------------------------------------
assert.deepEqual(leadFor("2026-11-21", 6, [[6, 10]]), { day: "2026-11-21", hour: 5 }, "the hour before the bell");
assert.deepEqual(leadFor("2026-11-21", 0, [[0, 3]]), { day: "2026-11-20", hour: 23 }, "a window at hour 0 leads from yesterday's 23:00");
assert.equal(windowTimes("2026-11-21", [0, 3], [[0, 3]]).leadMs, etInstant("2026-11-20", 23));
assert.equal(windowTimes("2026-11-21", [0, 3], [[0, 3]]).writesFromMs, etInstant("2026-11-20", 22), "writes are read from 1 h before the lead hour");
// shadow.ts: a lead hour must not lie inside another peak — the latest hour outside every window is taken
assert.deepEqual(leadFor("2026-11-21", 0, [[0, 3], [22, 24]]), { day: "2026-11-20", hour: 21 });
assert.deepEqual(leadFor("2026-11-21", 12, [[6, 11], [12, 14]]), { day: "2026-11-21", hour: 11 });
assert.equal(leadFor("2026-11-21", 12, [[8, 12], [12, 14]]), null, "no hour outside every window within the 3 h lookback");

// ---- --windows -----------------------------------------------------------------------------------------------------
assert.equal(normalizeWindowsArg("5-8, 18-20"), "5:00-8:00,18:00-20:00");
assert.deepEqual(parseWindowsArg("5-8,18-20"), [[5, 8], [18, 20]]);
assert.deepEqual(parseWindowsArg("06:30-10:00"), [[6, 10]], "the planner's DHW_SHOWER_WINDOWS form, start down / end up");
assert.deepEqual(parseWindowsArg(undefined), []);

// ---- (e) planned_boost ---------------------------------------------------------------------------------------------
assert.equal(isPlannedBoost({ reason: "pre-boost to 130°F (kept from the previous plan after the learned windows moved, 34°F)" }), true);
assert.equal(isPlannedBoost({ reason: "preboost" }), true);
assert.equal(isPlannedBoost({ reason: "Pre-Boost to 129°F for 06:00 window" }), true);
assert.equal(isPlannedBoost({ reason: "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)" }), false, "sanitize is not a pre-boost");
assert.equal(isPlannedBoost({ reason: "sanitize", sani: true }), false);
assert.equal(isPlannedBoost({ reason: "winter guard: mimic HBX curve", boost: true }), true, "the flag alone is enough");
assert.equal(isPlannedBoost({ reason: "off-window DHW-ready floor (draws possible any hour)" }), false);
assert.equal(isPlannedBoost(null), false);

// ---- (f) nearest reading -------------------------------------------------------------------------------------------
{
  const T = etInstant("2026-11-21", 6);
  const rows: SlxRow[] = [{ ts: T - 11 * MIN, tank_f: 121, outdoor_f: 30 }, { ts: T + 12 * MIN, tank_f: 127, outdoor_f: 30 }];
  assert.equal(nearestTankF(rows, T), null, "nothing within ±10 min");
  assert.equal(nearestTankF([...rows, { ts: T + 10 * MIN, tank_f: 126, outdoor_f: 30 }], T), 126, "exactly 10 min away counts");
  assert.equal(nearestTankF([{ ts: T - 4 * MIN, tank_f: 124, outdoor_f: null }, { ts: T + 1 * MIN, tank_f: 125, outdoor_f: null }], T), 125, "the nearer one");
  assert.equal(nearestTankF([{ ts: T, tank_f: null, outdoor_f: 30 }, { ts: T + 3 * MIN, tank_f: 123, outdoor_f: 30 }], T), 123, "a reading without tank_f is skipped");
}

// ---- hbx_writes rows, as writes.ts audits them ---------------------------------------------------------------------
const curveRow = (ts: number, out: number): WriteRow => ({ ts, source: "autopilot", action: "set_curve", result: "accepted",
  requested: { dot: 5, dbt: 121, mbt: 119, wwsd: 125 }, detail: `curve commanded: 121°F at 5°F → 119°F at 125°F (output ${out}°F at 34°F outdoor; adopts on the next reheat cycle)` });
const targetRow = (ts: number, f: number, source = "autopilot"): WriteRow => ({ ts, source, action: "set_target", result: "accepted",
  requested: { dbt: f + 1, mbt: f - 3 }, detail: `target ${f}°F commanded (curve ${f + 1}/${f - 3} → ${f}°F output at 34°F outdoor; adopts on the next reheat cycle)` });
{
  const T = etInstant("2026-11-21", 6);
  assert.equal(writeLevelF(targetRow(T, 130)), 130);
  assert.equal(writeLevelF(curveRow(T, 120.4)), 120.4);
  assert.equal(writeLevelF({ ...targetRow(T, 130), detail: null, requested: { dbt: 132, mbt: 128 } }), 130, "dbt/mbt midpoint when the detail is missing");
  assert.equal(writeLevelF({ ts: T, source: "dashboard", action: "restore", result: "accepted", requested: { dbt: 160, mbt: 120, dot: 5 }, detail: "as-found curve restored (160/120°F from 5°F) — as-found requested" }), null);
  assert.equal(shortRequested({ dbt: 131, mbt: 127 }), "dbt 131 mbt 127");
  assert.equal(shortRequested({ target_f: 130, minutes: 60 }), "target_f 130 minutes 60");
  assert.equal(shortRequested(null), "-");

  const from = T - 2 * 3600_000;
  // a raise over the level the earlier curve write left in force
  const up = classifyWrites([curveRow(T - 3 * 3600_000, 120.4), targetRow(T - 54 * MIN, 130)], from, T);
  assert.equal(up.boost_written, true);
  assert.equal(up.held_f, 130);
  assert.deepEqual(up.written.map((w) => [w.local, w.action, w.result, w.requested, w.level_f, w.raised]), [["05:06", "set_target", "accepted", "dbt 131 mbt 127", 130, true]]);
  // the same level re-commanded, a lowering, and a rejected boost are not a written boost
  assert.equal(classifyWrites([targetRow(T - 3 * 3600_000, 130), targetRow(T - 54 * MIN, 130)], from, T).boost_written, false);
  assert.equal(classifyWrites([targetRow(T - 3 * 3600_000, 135), targetRow(T - 54 * MIN, 130)], from, T).boost_written, false);
  const refused = classifyWrites([curveRow(T - 3 * 3600_000, 120.4),
    { ts: T - 50 * MIN, source: "autopilot", action: "set_target", result: "rejected", requested: { target_f: 130 }, detail: "I1 conflict: pump1 at 125.6°F < 133°F — raise pump setpoint(s) first or pick a lower target" },
    { ts: T - 40 * MIN, source: "dashboard", action: "boost", result: "arming", requested: { target_f: 130, minutes: 60 }, detail: "arming: …" }], from, T);
  assert.equal(refused.boost_written, false);
  assert.equal(refused.held_f, 120.4, "a refused write leaves the earlier level in force");
  assert.equal(refused.written.length, 2);
  // a write at or after the window start is outside the interval; one with no earlier level cannot be called a raise
  assert.equal(classifyWrites([curveRow(T - 3 * 3600_000, 120.4), targetRow(T, 130)], from, T).written.length, 0);
  assert.equal(classifyWrites([targetRow(T - 54 * MIN, 130)], from, T).boost_written, false);
}

// ---- three fixture windows -----------------------------------------------------------------------------------------
const WINDOWS: Window[] = [[6, 10], [18, 20]];
/** 5-min readings over [fromH, toH) of `day`; `tank(minuteOfDay)` gives tank_f. */
function day5min(day: string, fromH: number, toH: number, tank: (m: number) => number, outdoor: (m: number) => number): SlxRow[] {
  const rows: SlxRow[] = [];
  for (let m = fromH * 60; m < toH * 60; m += 5) rows.push({ ts: etInstant(day, 0) + m * MIN, tank_f: tank(m), outdoor_f: outdoor(m) });
  return rows;
}
const block = (day: string, h: number, target: number, reason: string, extra: Record<string, unknown> = {}) =>
  ({ ts: new Date(etInstant(day, h)).toISOString(), outdoor_f: 34, tank_target_f: target, hp1_setpoint_f: target + 5, reason, ...extra });
const FLOOR = "off-window DHW-ready floor (draws possible any hour)";

// (a) Nov 21: boost planned for 05:00 and written at 05:06; tank 128 °F at 06:00; a shower at 07:10 from 126 °F
const A = "2026-11-21";
const tankA = (m: number) => {
  if (m < 300) return 120;
  if (m < 360) return 120 + ((m - 300) / 60) * 8; // the boost hour: 120 → 128
  if (m <= 420) return 128 - ((m - 360) / 60) * 2; // standby: 128 → 126 at 07:00
  if (m === 425) return 126;
  if (m === 430) return 123.5; // draw detected here; the sample before it read 126
  if (m === 435) return 121;
  if (m === 440) return 119.5;
  if (m === 445) return 119.5;
  return Math.min(124, 119.5 + (m - 445) * 0.1); // recharge
};
const planA: PlanRow = { id: 4101, computedAtMs: etInstant(A, 4) + 21 * MIN, plan: [
  block(A, 4, 120, FLOOR),
  block(A, 5, 130, "pre-boost to 130°F for 06:00 window (sag p90 9.5°F over 14 draws; hour before the bell, 34°F)", { boost: true, guard_f: 135 }),
  block(A, 6, 120, "DHW window floor"),
] };
const writesA: WriteRow[] = [curveRow(etInstant(A, 3) + 6 * MIN, 120.4), targetRow(etInstant(A, 5) + 6 * MIN, 130)];
const slxA = day5min(A, 0, 12, tankA, (m) => (m < 240 ? 33 : m < 360 ? 31.5 : 36));
const a = evaluateWindow({ day: A, window: [6, 10], windows: WINDOWS, plan: planA, writes: writesA, slx: slxA });
assert.deepEqual(a.lead, { day: A, hour: 5, ts: "2026-11-21T10:00:00.000Z" });
assert.equal(a.plan?.id, 4101);
assert.deepEqual([a.plan?.block?.target_f, a.plan?.block?.boost, a.plan?.block?.guard_f], [130, true, 135]);
assert.deepEqual(a.plan?.boost_hours_in_window, []);
assert.equal(a.planned_boost, true);
assert.equal(a.boost_written, true);
assert.equal(a.held_f, 130);
assert.equal(a.tank_at_start, 128);
assert.equal(a.draws.length, 1, "four samples of one shower are one draw");
assert.deepEqual(a.draws[0], { ts: new Date(etInstant(A, 7) + 10 * MIN).toISOString(), local: "07:10", pre_draw_f: 126, min_f: 119.5, sag_f: 6.5 });
assert.equal(a.outdoor_min_f, 31.5, "minimum outdoor over 00:00–06:00");
assert.equal(a.verdict, "OK");
assert.equal(a.no_boost, false);
assert.equal(a.partial, false);

// (b) Nov 22: no boost planned or written; a shower at 07:05 from 118 °F
const B = "2026-11-22";
const tankB = (m: number) => (m <= 420 ? 118.5 - (m / 420) * 0.5 : m === 425 ? 114 : m === 430 ? 111 : Math.min(120, 111 + (m - 430) * 0.1));
const planB: PlanRow = { id: 4125, computedAtMs: etInstant(B, 4) + 21 * MIN, plan: [block(B, 4, 120, FLOOR), block(B, 5, 120, FLOOR), block(B, 6, 120, "DHW window floor")] };
const writesB: WriteRow[] = [...writesA, curveRow(etInstant(A, 6) + 6 * MIN, 120.6)];
const slxB = day5min(B, 0, 12, tankB, () => 28);
const b = evaluateWindow({ day: B, window: [6, 10], windows: WINDOWS, plan: planB, writes: writesB, slx: slxB });
assert.equal(b.planned_boost, false);
assert.equal(b.boost_written, false);
assert.equal(b.written.length, 0);
assert.equal(b.held_f, 120.6, "the curve write of the day before is still the level in force");
assert.equal(b.tank_at_start, tankB(360));
assert.equal(b.draws.length, 1);
assert.deepEqual([b.draws[0].local, b.draws[0].pre_draw_f, b.draws[0].min_f, b.draws[0].sag_f], ["07:05", 118, 111, 7]);
assert.equal(b.verdict, "FAIL");
assert.equal(b.no_boost, true);
// the bar is --fail-below: at 115 the same morning passes, and a draw from exactly the bar is not a FAIL
assert.equal(evaluateWindow({ day: B, window: [6, 10], windows: WINDOWS, plan: planB, writes: writesB, slx: slxB, failBelowF: 115 }).verdict, "OK");
assert.equal(evaluateWindow({ day: B, window: [6, 10], windows: WINDOWS, plan: planB, writes: writesB, slx: slxB, failBelowF: 118 }).verdict, "OK");
assert.equal(DEFAULT_FAIL_BELOW_F, 120);
// planned but never written is NO_BOOST too
{
  const planned = evaluateWindow({ day: B, window: [6, 10], windows: WINDOWS, writes: writesB, slx: slxB,
    plan: { ...planB, plan: [block(B, 5, 130, "pre-boost to 130°F for 06:00 window", { boost: true })] } });
  assert.deepEqual([planned.planned_boost, planned.boost_written, planned.no_boost], [true, false, true]);
}

// (c) Nov 21 evening: a flat tank, no draws
const slxC = day5min(A, 0, 22, () => 121, () => 40);
const c = evaluateWindow({ day: A, window: [18, 20], windows: WINDOWS, plan: { id: 4113, computedAtMs: etInstant(A, 16) + 21 * MIN, plan: [block(A, 17, 120, FLOOR)] }, writes: writesA, slx: slxC });
assert.deepEqual(c.lead, { day: A, hour: 17, ts: "2026-11-21T22:00:00.000Z" });
assert.equal(c.draws.length, 0);
assert.equal(c.verdict, "NO_DRAWS");
assert.equal(c.no_boost, false, "NO_BOOST is only raised for a window that had draws");
assert.equal(c.tank_at_start, 121);

// a window the restore does not reach is NO_DATA, never OK; one it reaches only partly says so
assert.equal(evaluateWindow({ day: B, window: [18, 20], windows: WINDOWS, plan: null, writes: [], slx: slxB }).verdict, "NO_DATA");
assert.equal(evaluateWindow({ day: B, window: [6, 10], windows: WINDOWS, plan: planB, writes: writesB, slx: slxB.filter((r) => r.ts < etInstant(B, 8)) }).partial, true);

// a draw already under way at the window start is not a draw that STARTS in the window; one in the tail after it is not either
{
  const T = etInstant(A, 6);
  const fall: SlxRow[] = [-10, -5, 0, 5, 10].map((m, i) => ({ ts: T + m * MIN, tank_f: 126 - i * 2, outdoor_f: 30 }));
  assert.equal(findDraws(fall, T, T + 3600_000).length, 0, "the fall began at 05:55");
  assert.equal(findDraws(fall, T - 3600_000, T + 3600_000).length, 1);
  const late: SlxRow[] = [0, 5, 10].map((m, i) => ({ ts: T + 3600_000 + m * MIN, tank_f: 126 - i * 2, outdoor_f: 30 }));
  assert.equal(findDraws(late, T, T + 3600_000).length, 0);
  // a 20-min telemetry hole is not a draw (dhw.ts: pairs wider than 12 min are not adjacent)
  assert.equal(findDraws([{ ts: T, tank_f: 126, outdoor_f: 30 }, { ts: T + 20 * MIN, tank_f: 120, outdoor_f: 30 }], T, T + 3600_000).length, 0);
}

// blockAt matches the hour exactly
assert.equal(blockAt(planA.plan, etInstant(A, 5))?.tank_target_f, 130);
assert.equal(blockAt(planA.plan, etInstant(A, 7)), null);
assert.equal(blockAt(null, etInstant(A, 5)), null);

// ---- report --------------------------------------------------------------------------------------------------------
const results = [a, c, b];
const s = summarize(results);
assert.deepEqual(s, {
  days_checked: 2, windows_checked: 3, windows_with_draws: 2, fail: 1, no_boost: 1, no_data: 0,
  lowest_pre_draw_f: 118, lowest_pre_draw_at: "2026-11-22 07:05", worst_sag_f: 7, worst_sag_at: "2026-11-22 07:05",
});
const table = formatTable(results);
const lines = table.split("\n");
assert.equal(lines.length, 4, "a header and one line per day × window");
assert.match(lines[1], /^2026-11-21 {2}06-10 {3}05:00 {2}130\.0 {3}135\.0 {2}yes .* OK {2}/);
assert.match(lines[2], /^2026-11-21 {2}18-20 .* NO_DRAWS/);
assert.match(lines[3], /^2026-11-22 {2}06-10 .* FAIL NO_BOOST/);
assert.ok(!/\x1b\[/.test(table), "no colour codes");
assert.match(formatSummary(s), /FAIL 1 .*NO_BOOST 1/);
assert.doesNotThrow(() => JSON.stringify({ results, summary: s }));

console.log(table);
console.log(formatSummary(s));
console.log(`dhw-morning.test: all assertions passed (${results.length} fixture windows: ${results.map((r) => r.verdict + (r.no_boost ? "+NO_BOOST" : "")).join(", ")})`);
