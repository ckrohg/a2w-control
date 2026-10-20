/**
 * @purpose Assertions for stale-target.ts: the physical proof that SensorLinx's reported tank target is a frozen
 * snapshot, replayed from the 2026-10-19 afternoon (soak 139.9 °F reported for 7 h while the planner's 120 °F curve
 * was in force, the tank coasted 141 → 127 °F and no stage was called). Run with: npx tsx planner/src/stale-target.test.ts
 */
import assert from "node:assert/strict";
import { staleReportedTarget, staleTankMarginF, STALE_TANK_MARGIN_DEFAULT_F, STALE_REPORT_MIN_POLLS, STALE_REPORT_MAX_AGE_MS, type RecentPoll } from "./stale-target";

const NOW = new Date("2026-10-19T19:39:00Z").getTime(); // 15:39 ET — three idle polls after the tank crossed 136.9
const poll = (minAgo: number, tankF: number | null, over: Partial<RecentPoll> = {}): RecentPoll => ({ ts: new Date(NOW - minAgo * 60_000), tankF, anyCall: false, hdActive: true, ...over });
// The live case: reported 139.9 (the soak), command 119 (curve 120/118 midpoint), curve output 119.5 at 54 °F outdoor.
const live = { reportedF: 139.9, commandedF: 119, curveOutputF: 119.5, htDifF: 4, nowMs: NOW };
const oct19 = [poll(10, 132.9), poll(5, 132.5), poll(0, 132.1)]; // 15:29 / 15:34 / 15:39 ET in slx_readings

// margin: htDif/2 + 1 °F slack; the as-found differential is 4
assert.equal(staleTankMarginF(4), 3);
assert.equal(staleTankMarginF(6), 4);
assert.equal(staleTankMarginF(null), 3);
assert.equal(staleTankMarginF(0), 3, "a nonsense differential falls back to the as-found 4");
assert.equal(STALE_TANK_MARGIN_DEFAULT_F, 3);

// 1. The Oct 19 case is stale: the operative target is the curve output, not the frozen report.
{
  const v = staleReportedTarget({ ...live, recent: oct19 });
  assert.equal(v.kind, "stale");
  if (v.kind === "stale") {
    assert.equal(v.operativeF, 119.5);
    assert.equal(v.marginF, 3);
    assert.equal(v.polls, STALE_REPORT_MIN_POLLS);
    assert.equal(v.tankF, 132.1, "the newest poll's tank");
  }
  // without a curve output the commanded midpoint stands in
  const mid = staleReportedTarget({ ...live, curveOutputF: null, recent: oct19 });
  assert.equal(mid.kind, "stale"); if (mid.kind === "stale") assert.equal(mid.operativeF, 119);
  // the polls may arrive in any order; the newest three are examined
  assert.equal(staleReportedTarget({ ...live, recent: [...oct19].reverse() }).kind, "stale");
  // an older hour of polls with a call in it does not spoil the verdict — only the newest three count
  assert.equal(staleReportedTarget({ ...live, recent: [poll(55, 141.0, { anyCall: true }), poll(50, 141.3), ...oct19] }).kind, "stale");
}

// 2. Not applicable: adopted (within tolerance), or the report sits BELOW the command (a raise has no idle proof), or inputs missing.
{
  assert.equal(staleReportedTarget({ ...live, reportedF: 120, recent: oct19 }).kind, "not_applicable");
  assert.equal(staleReportedTarget({ ...live, reportedF: 122, recent: oct19 }).kind, "not_applicable", "3 °F is the adoption tolerance");
  assert.equal(staleReportedTarget({ ...live, reportedF: 120, commandedF: 128, recent: oct19 }).kind, "not_applicable", "raise: reported below commanded");
  assert.equal(staleReportedTarget({ ...live, reportedF: null, recent: oct19 }).kind, "not_applicable");
  assert.equal(staleReportedTarget({ ...live, commandedF: null, recent: oct19 }).kind, "not_applicable");
  assert.equal(staleReportedTarget({ ...live, reportedF: NaN, recent: oct19 }).kind, "not_applicable");
}

// 3. Unproven — each missing piece of the proof keeps the driver idle, with the reason.
{
  const why = (recent: RecentPoll[], over: Partial<typeof live> = {}) => {
    const v = staleReportedTarget({ ...live, ...over, recent });
    assert.equal(v.kind, "unproven", JSON.stringify(v));
    return v.kind === "unproven" ? v.why : "";
  };
  assert.match(why([]), /needs 3 idle polls .* \(have 0\)/);
  assert.match(why(oct19.slice(1)), /\(have 2\)/);
  // a call inside the three polls: the report is live while calling, so the device really is at it (the 15:04 sample)
  assert.match(why([poll(10, 141.0, { anyCall: true }), poll(5, 141.3), poll(0, 140.7)]), /a stage was called at 19:29Z — the report is live while calling/);
  // the tank has not fallen below reported − margin yet (15:09–15:19: 141.3 / 140.7 / 139.8 against 136.9)
  assert.match(why([poll(10, 141.3), poll(5, 140.7), poll(0, 139.8)]), /tank 141\.3 °F at 19:29Z is not below 136\.9 °F \(reported 139\.9 − 3\.0\)/);
  // exactly at the threshold is not below it
  assert.match(why([poll(10, 136.9), poll(5, 136.8), poll(0, 136.8)]), /tank 136\.9 °F .* is not below 136\.9/);
  // a wider differential needs a deeper tank
  assert.match(why(oct19, { htDifF: 12 }), /not below 132\.9 °F \(reported 139\.9 − 7\.0\)/);
  // no heat demand: an idle device proves nothing
  assert.match(why([poll(10, 132.9), poll(5, 132.5, { hdActive: false }), poll(0, 132.1)]), /no heat demand at 19:34Z/);
  // a missing tank reading
  assert.match(why([poll(10, 132.9), poll(5, null), poll(0, 132.1)]), /no tank reading at 19:34Z/);
  // the three newest polls are not consecutive (a 40-min gap: an outage, not a proof)
  assert.match(why([poll(45, 132.9), poll(40, 132.5), poll(0, 132.1)]), /span 45 min \(limit 20\) — not consecutive/);
  assert.ok(STALE_REPORT_MAX_AGE_MS === 20 * 60_000);
  // the tank is below the COMMAND's own threshold with no call: the device heats to neither value (WWSD / dead relay) — not "settled on the curve"
  assert.match(why([poll(10, 115.0), poll(5, 114.5), poll(0, 114.0)]), /below the command's own call threshold 116\.5 °F with no call/);
  // hdActive unknown (an older fake / a reading without demands) is not a refusal
  assert.equal(staleReportedTarget({ ...live, recent: oct19.map((p) => ({ ts: p.ts, tankF: p.tankF, anyCall: false })) }).kind, "stale");
}

// 4. The bank case (the other 40-odd stretches): reported 128.1 after the afternoon bank, curve 120/118 in force, tank 125 coasting.
{
  const bank = { reportedF: 128.1, commandedF: 119, curveOutputF: 119.7, htDifF: 4, nowMs: NOW };
  assert.equal(staleReportedTarget({ ...bank, recent: [poll(10, 125.0), poll(5, 124.9), poll(0, 124.8)] }).kind, "stale");
  // a tank at 126 is within the margin of 128.1 — the device MAY still be at 128.1 and simply satisfied; wait
  assert.equal(staleReportedTarget({ ...bank, recent: [poll(10, 126.0), poll(5, 125.9), poll(0, 125.8)] }).kind, "unproven");
}

console.log("stale-target.test.ts: all assertions passed");
