/**
 * @purpose gtm#1328: assertions for aggregateTankUa (pure). a2w-control has no JS test runner
 * (CI is tsc build + bridge pytest), so run locally with: npx tsx planner/src/tank-ua-push.test.ts
 * — it exits non-zero on failure. The physics is the load-bearing part, so it's worth pinning.
 */
import assert from "node:assert/strict";
import { aggregateTankUa, type DecayFitRow } from "./tank-ua-push";

function fit(tStartF: number, tEndF: number, hours: number, slopeFPerH: number, endIso: string): DecayFitRow {
  return { windowStart: new Date("2026-07-01T00:00:00Z"), windowEnd: new Date(endIso), tStartF, tEndF, hours, slopeFPerH };
}

// 1. Empty / no qualifying fits → null.
assert.equal(aggregateTankUa([]), null);

// 2. Anchor: a deliberate coast at ~155°F declining 2.4°F/h → UA = 2.4/(153.5−65) ≈ 0.0271.
//    (slopeFPerH is NEGATIVE for a decline.)
{
  const agg = aggregateTankUa([fit(155, 152, 1.25, -2.4, "2026-07-15T06:00:00Z")]);
  assert.ok(agg, "expected an aggregate");
  assert.ok(Math.abs(agg!.ua - 2.4 / (153.5 - 65)) < 1e-4, `ua ${agg!.ua}`);
  assert.equal(agg!.nWindows, 1);
  assert.equal(agg!.windowEndMs, new Date("2026-07-15T06:00:00Z").getTime());
}

// 3. Median across several fits + newest windowEnd is reported.
{
  const agg = aggregateTankUa([
    fit(150, 148, 2, -1.0, "2026-07-10T00:00:00Z"), // UA = 1/(149−65) ≈ 0.0119
    fit(158, 155, 1.5, -2.0, "2026-07-14T00:00:00Z"), // UA = 2/(156.5−65) ≈ 0.0219
    fit(152, 149, 1.5, -3.0, "2026-07-12T00:00:00Z"), // UA = 3/(150.5−65) ≈ 0.0351
  ]);
  assert.ok(agg);
  assert.equal(agg!.nWindows, 3);
  assert.ok(Math.abs(agg!.ua - 0.0219) < 5e-3, `median ua ${agg!.ua}`); // middle value
  assert.equal(agg!.windowEndMs, new Date("2026-07-14T00:00:00Z").getTime());
}

// 4. Reject a near-ambient window (ΔT ≤ 10) and an out-of-band UA; keep the good one.
{
  const agg = aggregateTankUa([
    fit(70, 69, 1, -1.0, "2026-07-14T00:00:00Z"),    // ΔT ≈ 4.5 → rejected
    fit(155, 100, 0.1, -550, "2026-07-14T00:00:00Z"), // UA huge → out of band, rejected
    fit(150, 148, 2, -1.0, "2026-07-13T00:00:00Z"),   // good
  ]);
  assert.ok(agg);
  assert.equal(agg!.nWindows, 1);
}

// 5. All rejected → null.
assert.equal(aggregateTankUa([fit(70, 69.5, 1, -0.5, "2026-07-14T00:00:00Z")]), null);

console.log("tank-ua-push aggregate assertions: OK");
