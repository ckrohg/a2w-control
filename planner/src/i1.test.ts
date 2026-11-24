/**
 * @purpose Assertions for i1.ts — the pure halves of index.ts checkI1 that no test reached before. i1Offenders: offline
 * pumps and null setpoints are ignored, a setpoint exactly at target + margin is NOT an offender, the °C→°F figure is
 * compared unrounded but printed with toFixed(1), and the line is byte-identical to the string checkI1 used to build
 * inline. piClockOffsetS: null when the Pi is disconnected or the frame time is 0, missing, null or non-numeric; a
 * millisecond stamp (> 1e11) is divided by 1000 and a seconds stamp is not; a frame 30 s old reads ≈ +30.
 * Run with: npx tsx planner/src/i1.test.ts
 */
import assert from "node:assert/strict";
import { i1Offenders, piClockOffsetS } from "./i1";
import { DEFAULT_OPTS } from "./shadow";
import type { HubPump } from "./hub";

const cToF = (c: number) => (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const pump = (id: string, setpoint_c: number | null, online = true): Pick<HubPump, "id" | "online" | "setpoint_c"> =>
  ({ id, online, setpoint_c });

// ---------- i1Offenders ----------
{
  // the live margin: 135 °F target → 140 °F required
  const target = 135;
  const margin = DEFAULT_OPTS.i1MarginF;
  assert.equal(margin, 5, "the A-4-measured margin the plan relies on");

  // nothing to report: both pumps well above the bar
  const clean = i1Offenders([pump("pump1", 65), pump("pump2", 68)], target, margin);
  assert.deepEqual(clean, { offenders: [], required: 140 });

  // offline pumps are ignored even with a hopeless setpoint
  const offline = i1Offenders([pump("pump1", 40, false), pump("pump2", 65)], target, margin);
  assert.deepEqual(offline.offenders, []);

  // a pump with no setpoint reading is ignored (not an offender, not a crash)
  const noSetpoint = i1Offenders([pump("pump1", null), pump("pump2", 65)], target, margin);
  assert.deepEqual(noSetpoint.offenders, []);

  // exactly at the bar: 140 °F = 60 °C — NOT an offender (strict <)
  assert.equal(cToF(60), 140);
  const atBar = i1Offenders([pump("pump1", 60)], target, margin);
  assert.deepEqual(atBar.offenders, []);

  // a hair under the bar IS an offender; the rounded text still prints 140.0 because the comparison is unrounded
  const hair = i1Offenders([pump("pump1", 59.99)], target, margin);
  assert.equal(hair.offenders.length, 1);
  assert.equal(hair.offenders[0], "pump1 setpoint 140.0°F < required 140.0°F");

  // message format: byte-identical to the inline string checkI1 built before the extraction
  const p = pump("pump2", 56); // 132.8 °F
  const legacy = `${p.id} setpoint ${cToF(p.setpoint_c as number).toFixed(1)}°F < required ${(target + margin).toFixed(1)}°F`;
  const got = i1Offenders([p], target, margin);
  assert.deepEqual(got.offenders, [legacy]);
  assert.equal(got.offenders[0], "pump2 setpoint 132.8°F < required 140.0°F");
  assert.equal(Buffer.from(got.offenders[0]).equals(Buffer.from(legacy)), true);

  // °C→°F rounding matches toFixed(1): 57 °C = 134.6 °F, 52.5 °C = 126.5 °F, 51 °C = 123.8 °F
  const rounding = i1Offenders([pump("a", 57), pump("b", 52.5), pump("c", 51)], target, margin);
  assert.deepEqual(rounding.offenders, [
    "a setpoint 134.6°F < required 140.0°F",
    "b setpoint 126.5°F < required 140.0°F",
    "c setpoint 123.8°F < required 140.0°F",
  ]);

  // a fractional required value is printed to one decimal too, and `required` is returned unrounded
  const frac = i1Offenders([pump("pump1", 50)], 119.6, margin);
  assert.equal(frac.required, 124.6);
  assert.deepEqual(frac.offenders, ["pump1 setpoint 122.0°F < required 124.6°F"]);

  // the exact-bar case again on a fractional target: fToC(124.6) round-trips to the bar, so it is not an offender
  const fracBar = i1Offenders([pump("pump1", fToC(124.6))], 119.6, margin);
  assert.equal(cToF(fToC(124.6)) < 124.6, false);
  assert.deepEqual(fracBar.offenders, []);

  // mixed roster: only the online, below-bar pump is listed, in roster order
  const mixed = i1Offenders(
    [pump("pump1", 40, false), pump("pump2", null), pump("pump3", 55), pump("pump4", 65), pump("pump5", 58)],
    target, margin,
  );
  assert.deepEqual(mixed.offenders, [
    "pump3 setpoint 131.0°F < required 140.0°F",
    "pump5 setpoint 136.4°F < required 140.0°F",
  ]);

  // an empty roster is simply clean
  assert.deepEqual(i1Offenders([], target, margin).offenders, []);
}

// ---------- piClockOffsetS ----------
{
  const nowMs = 1_761_000_000_000; // 2025-10-20T22:40:00Z — a seconds stamp of 1_761_000_000
  const nowS = nowMs / 1000;

  // not connected → null, whatever ts says
  assert.equal(piClockOffsetS({ pi_connected: false, ts: nowS }, nowMs), null);
  assert.equal(piClockOffsetS({ pi_connected: false, ts: nowMs }, nowMs), null);

  // connected but no usable frame time → null
  assert.equal(piClockOffsetS({ pi_connected: true, ts: 0 }, nowMs), null);
  assert.equal(piClockOffsetS({ pi_connected: true, ts: null }, nowMs), null);
  assert.equal(piClockOffsetS({ pi_connected: true } as any, nowMs), null); // missing
  assert.equal(piClockOffsetS({ pi_connected: true, ts: "1761000000" } as any, nowMs), null); // non-numeric
  assert.equal(piClockOffsetS({ pi_connected: true, ts: NaN } as any, nowMs), null);
  assert.equal(piClockOffsetS({ pi_connected: true, ts: -5 }, nowMs), null);

  // a seconds stamp equal to now → 0; it is NOT divided by 1000
  assert.equal(piClockOffsetS({ pi_connected: true, ts: nowS }, nowMs), 0);

  // a millisecond stamp (> 1e11) IS divided by 1000: the same instant reads 0, not ~1.76e9
  assert.equal(piClockOffsetS({ pi_connected: true, ts: nowMs }, nowMs), 0);
  assert.equal(piClockOffsetS({ pi_connected: true, ts: nowMs - 30_000 }, nowMs), 30);

  // the threshold itself: 1e11 is treated as seconds (strict >), 1e11 + 1 as milliseconds
  const atThreshold = piClockOffsetS({ pi_connected: true, ts: 1e11 }, nowMs)!;
  assert.equal(atThreshold, nowS - 1e11);
  const pastThreshold = piClockOffsetS({ pi_connected: true, ts: 1e11 + 1 }, nowMs)!;
  assert.equal(pastThreshold, nowS - (1e11 + 1) / 1000);

  // a frame 30 s old yields ≈ +30 (the planner's clock is ahead of the frame's stamp)
  const frame30 = piClockOffsetS({ pi_connected: true, ts: nowS - 30 }, nowMs)!;
  assert.ok(Math.abs(frame30 - 30) < 1e-6, `expected ≈ +30, got ${frame30}`);

  // the Pi's clock ahead of the planner's reads negative
  const ahead = piClockOffsetS({ pi_connected: true, ts: nowS + 12 }, nowMs)!;
  assert.ok(Math.abs(ahead + 12) < 1e-6, `expected ≈ −12, got ${ahead}`);

  // extra fields on the state object are not consulted
  assert.equal(piClockOffsetS({ pi_connected: true, ts: nowS - 15, pumps: [] } as any, nowMs), 15);

  // the real-clock path: a fresh frame stamped from Date.now() reads a few ms at most
  const live = piClockOffsetS({ pi_connected: true, ts: Date.now() / 1000 }, Date.now())!;
  assert.ok(live >= 0 && live < 1, `fresh frame offset should be sub-second, got ${live}`);
}

console.log("i1.test.ts: all assertions passed");
