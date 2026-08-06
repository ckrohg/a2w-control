/**
 * @purpose Assertions for the #59 winter DP (winterdp.ts). Run with: npx tsx planner/src/winterdp.test.ts
 * — exits non-zero on failure. Pins the safety contract (floors are NEVER violated, caps never
 * exceeded), the economics (banks ahead of cold snaps when COP timing pays; beats or ties naive
 * floor-following by construction), and the degraded modes (no anchor / no load still solve).
 */
import assert from "node:assert/strict";
import { solveWinterDp, copAt, DEFAULT_TANK_UA, type DpHour, type CopAnchor } from "./winterdp";

const ANCHOR: CopAnchor = { cop: 2.55, sinkF: 139, outdoorF: 75 }; // the prod quality-filtered aggregate

const mkHours = (outdoor: number[], floorF: number | number[], loadBtu = 15_000, capF = 135): DpHour[] =>
  outdoor.map((o, i) => ({
    ts: new Date(2026, 0, 15, i, 0, 0).toISOString(),
    outdoorF: o,
    floorF: Array.isArray(floorF) ? floorF[i] : floorF,
    capF,
    loadBtu,
  }));

// 1. COP model sanity: warmer outdoor and cooler sink both raise COP; clamps hold.
{
  assert.ok(copAt(ANCHOR, 45, 130) > copAt(ANCHOR, 15, 130), "warmer outdoor → higher COP");
  assert.ok(copAt(ANCHOR, 30, 120) > copAt(ANCHOR, 30, 145), "cooler sink → higher COP");
  assert.ok(copAt(ANCHOR, -20, 170) >= 0.8 && copAt(null, 40, 130) > 1, "clamps + fallback model sane");
}

// 2. Safety contract: every block's target sits in [floorF, capF] — including a mid-day floor
//    spike (baseboard zone starts calling) and regardless of the start state.
{
  const floors = Array.from({ length: 24 }, (_, h) => (h >= 14 && h < 18 ? 132 : 120));
  const hours = mkHours(Array.from({ length: 24 }, (_, h) => 30 + (h > 11 ? 10 : 0)), floors);
  const res = solveWinterDp(hours, { anchor: ANCHOR, tankUa: DEFAULT_TANK_UA, startTankF: 105 });
  assert.ok(res, "solver returns a result");
  res!.blocks.forEach((b, i) => {
    assert.ok(b.targetF >= floors[i], `hour ${i}: target ${b.targetF} must cover floor ${floors[i]}`);
    assert.ok(b.targetF <= 135, `hour ${i}: target ${b.targetF} under cap`);
  });
}

// 3a. Deep-winter LWT discipline: heavy continuous load (18 kBTU/h ≈ 20°F/h of tank — the 110 gal
//     battery holds ~40 min of it) → banking CANNOT pay; the DP must hold the floor (lowest sink)
//     and exactly match naive floor-following. This is the physics, not a failure to optimize.
{
  const hours = mkHours([...Array(12).fill(40), ...Array(12).fill(10)], 122, 18_000);
  const res = solveWinterDp(hours, { anchor: ANCHOR, tankUa: DEFAULT_TANK_UA, startTankF: 122 })!;
  assert.ok(res.blocks.every((b) => b.targetF === 122), "heavy-load winter: hold the floor, no banking");
  assert.ok(res.totalKwh <= res.floorKwh + 0.01, "total ≤ floor-following");
}

// 3b. Shoulder-season banking: light load (3 kBTU/h) with a 45°F day → 15°F night. The DP banks
//     above the floor in the hours JUST BEFORE the transition (short hold = low standby tax) and
//     never does worse than floor-following.
{
  const hours = mkHours([...Array(12).fill(45), ...Array(12).fill(15)], 120, 3_000);
  const res = solveWinterDp(hours, { anchor: ANCHOR, tankUa: DEFAULT_TANK_UA, startTankF: 120 })!;
  assert.ok(res.totalKwh <= res.floorKwh + 0.01, "total ≤ floor-following");
  assert.ok(res.savedPct >= 0, "savedPct non-negative");
  const preBankPeak = Math.max(...res.blocks.slice(8, 14).map((b) => b.targetF));
  assert.ok(preBankPeak > 121, `banks above floor just before the cold (peak ${preBankPeak})`);
  const earlyBank = Math.max(...res.blocks.slice(0, 8).map((b) => b.targetF));
  assert.ok(earlyBank <= preBankPeak, "no early hoarding — the bank hugs the transition");
}

// 4. Flat mild day with zero load: the DP holds the floor — no phantom banking when nothing pays.
{
  const hours = mkHours(Array(24).fill(48), 120, 0);
  const res = solveWinterDp(hours, { anchor: ANCHOR, tankUa: DEFAULT_TANK_UA, startTankF: 120 })!;
  const over = res.blocks.filter((b) => b.targetF > 121);
  assert.equal(over.length, 0, "no banking on a flat zero-load day");
}

// 5. Degraded modes: no COP anchor and no load still produce a full, floor-respecting plan.
{
  const hours = mkHours(Array(24).fill(25), 126, 0);
  const res = solveWinterDp(hours, { anchor: null, tankUa: DEFAULT_TANK_UA, startTankF: 110 })!;
  assert.equal(res.blocks.length, 24, "full horizon");
  assert.ok(res.blocks.every((b) => b.targetF >= 126), "floors hold in degraded mode");
}

// 6. Empty forecast → null (caller treats as 'no DP this cycle').
assert.equal(solveWinterDp([], { anchor: ANCHOR, tankUa: DEFAULT_TANK_UA, startTankF: 120 }), null);

console.log("winterdp.test.ts: all assertions passed ✓");
