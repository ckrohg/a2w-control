/**
 * @purpose Assertions for unverified-binding.ts (#170, surfacing #134): the watch opens once on a room deficit ≥ 1 °F or
 * on ≥ 6 consecutive binding cycles, never for a verified (or unknown-provenance) zone, clears when the binding zone
 * changes or the condition has been false for 3 cycles, and reports a later episode again; the week view keeps the
 * closed ones; the deficit helper reads setpoint − room the way costFirstAwtF does; the log lines name the evidence.
 * Run with: npx tsx planner/src/unverified-binding.test.ts
 */
import assert from "node:assert/strict";
import {
  UnverifiedBindingWatch, roomDeficitF, unverifiedBindingCondition, describeEvent,
  DEFICIT_F, STREAK_CYCLES, CLEAR_CYCLES, WEEK_MS, type BindingFacts, type UnverifiedBindingEvent,
} from "./unverified-binding";

const T0 = Date.parse("2026-11-20T06:00:00Z");
const HOUR = 3_600_000;
const mb = (o: Partial<BindingFacts> = {}): BindingFacts => ({ zone: "Master Bathroom", verified: false, deficitF: 0, ...o });
const kinds = (evs: UnverifiedBindingEvent[]) => evs.map((e) => e.kind);

/** Step `n` hourly cycles from `from`, returning every event in order. */
function run(w: UnverifiedBindingWatch, facts: BindingFacts | null, n: number, from: number): UnverifiedBindingEvent[] {
  const out: UnverifiedBindingEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...w.step(facts, from + i * HOUR));
  return out;
}

// ── 1. deficit helper: setpoint − room, one decimal, null when either side is missing ──────────────────────────────────
assert.equal(roomDeficitF(68.4, 70), 1.6);
assert.equal(roomDeficitF(70, 68), -2, "a warm room is a negative deficit, not clamped — the predicate does the comparing");
assert.equal(roomDeficitF(null, 70), null);
assert.equal(roomDeficitF(68, undefined), null);
assert.equal(roomDeficitF(NaN, 70), null);

// ── 2. the predicate ─────────────────────────────────────────────────────────────────────────────────────────────────
assert.equal(unverifiedBindingCondition(mb({ deficitF: DEFICIT_F }), 1), true, "deficit at the threshold counts");
assert.equal(unverifiedBindingCondition(mb({ deficitF: 0.9 }), 1), false);
assert.equal(unverifiedBindingCondition(mb({ deficitF: null }), STREAK_CYCLES), true, "the streak needs no room telemetry");
assert.equal(unverifiedBindingCondition(mb({ deficitF: null }), STREAK_CYCLES - 1), false);
assert.equal(unverifiedBindingCondition(mb({ verified: true, deficitF: 5 }), 99), false, "a verified zone has a ceiling — never an episode");
assert.equal(unverifiedBindingCondition(mb({ verified: null, deficitF: 5 }), 99), false, "unknown provenance is not evidence of a missing ceiling");

// ── 3. opens on a deficit, once ──────────────────────────────────────────────────────────────────────────────────────
{
  const w = new UnverifiedBindingWatch();
  assert.deepEqual(w.step(mb({ deficitF: 0.5 }), T0), [], "half a degree is noise");
  assert.equal(w.current(), null);
  const ev = w.step(mb({ deficitF: 1.4 }), T0 + HOUR);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "open");
  assert.deepEqual(ev[0].kind === "open" && ev[0].report, { zone: "Master Bathroom", cycles: 2, deficit_f: 1.4, since: new Date(T0 + HOUR).toISOString() });
  assert.deepEqual(w.current(), { zone: "Master Bathroom", cycles: 2, deficit_f: 1.4, since: new Date(T0 + HOUR).toISOString() });
  // the condition stays true for 10 more cycles: nothing more is reported, the open report keeps its opening facts
  assert.deepEqual(run(w, mb({ deficitF: 2.2 }), 10, T0 + 2 * HOUR), [], "reports once per episode");
  assert.equal(w.current()?.since, new Date(T0 + HOUR).toISOString());
  assert.equal(w.current()?.cycles, 2, "the report's cycles are the count at open");
  assert.match(describeEvent(ev[0]), /UNVERIFIED binding zone "Master Bathroom".*room deficit 1\.4 °F.*#134\/#170/);
}

// ── 4. opens on the cycle streak with no room telemetry at all ───────────────────────────────────────────────────────
{
  const w = new UnverifiedBindingWatch();
  const evs = run(w, mb({ deficitF: null }), STREAK_CYCLES - 1, T0);
  assert.deepEqual(evs, [], `${STREAK_CYCLES - 1} binding cycles is not yet a streak`);
  const ev = w.step(mb({ deficitF: null }), T0 + (STREAK_CYCLES - 1) * HOUR);
  assert.equal(kinds(ev).join(), "open");
  assert.equal(ev[0].kind === "open" && ev[0].report.cycles, STREAK_CYCLES);
  assert.equal(ev[0].kind === "open" && ev[0].report.deficit_f, null);
  assert.match(describeEvent(ev[0]), /binding for 6 consecutive cycles, no room telemetry/);
  // a sub-threshold deficit on the streak path is still shown in the line
  const w2 = new UnverifiedBindingWatch();
  const ev2 = run(w2, mb({ deficitF: 0.3 }), STREAK_CYCLES, T0);
  assert.match(describeEvent(ev2[0]), /binding for 6 consecutive cycles \(room deficit 0\.3 °F\)/);
}

// ── 5. never opens for a verified zone, however bad the evidence ────────────────────────────────────────────────────
{
  const w = new UnverifiedBindingWatch();
  assert.deepEqual(run(w, mb({ zone: "Dining Room", verified: true, deficitF: 6 }), 24, T0), []);
  assert.deepEqual(run(w, mb({ zone: "Mud Room", verified: null, deficitF: 6 }), 24, T0), [], "null provenance: TempIQ did not say");
  assert.equal(w.current(), null);
  assert.deepEqual(w.week(T0 + 48 * HOUR), []);
}

// ── 6. clears on a binding change (another zone, then no binding zone at all) ────────────────────────────────────────
{
  const w = new UnverifiedBindingWatch();
  w.step(mb({ deficitF: 3 }), T0);
  const ev = w.step(mb({ zone: "Dining Room", verified: true, deficitF: 3 }), T0 + HOUR);
  assert.equal(kinds(ev).join(), "clear");
  assert.equal(ev[0].kind === "clear" && ev[0].episode.cleared_by, "binding_changed");
  assert.equal(ev[0].kind === "clear" && ev[0].episode.until, new Date(T0 + HOUR).toISOString());
  assert.equal(ev[0].kind === "clear" && ev[0].episode.max_deficit_f, 3);
  assert.equal(w.current(), null);
  assert.match(describeEvent(ev[0]), /episode cleared: it is no longer the binding zone/);

  // the same zone binding again starts its cycle count from scratch — the old streak does not carry over
  const w2 = new UnverifiedBindingWatch();
  run(w2, mb({ deficitF: null }), STREAK_CYCLES - 1, T0);
  assert.deepEqual(w2.step(null, T0 + 5 * HOUR), [], "no binding zone, nothing open: nothing to say");
  assert.deepEqual(run(w2, mb({ deficitF: null }), STREAK_CYCLES - 1, T0 + 6 * HOUR), [], "5 cycles after a gap is not a streak");

  // an open episode clears when the floor goes away (null)
  const w3 = new UnverifiedBindingWatch();
  w3.step(mb({ deficitF: 2 }), T0);
  const ev3 = w3.step(null, T0 + HOUR);
  assert.equal(kinds(ev3).join(), "clear");
  assert.equal(ev3[0].kind === "clear" && ev3[0].episode.cleared_by, "binding_changed");
}

// ── 7. clears after CLEAR_CYCLES false cycles — not before, and a true cycle in between resets the count ─────────────
{
  const w = new UnverifiedBindingWatch();
  w.step(mb({ deficitF: 2 }), T0);
  assert.deepEqual(run(w, mb({ deficitF: 0 }), CLEAR_CYCLES - 1, T0 + HOUR), [], `${CLEAR_CYCLES - 1} false cycles keep it open`);
  assert.deepEqual(w.step(mb({ deficitF: 1.5 }), T0 + 3 * HOUR), [], "back above threshold: still the same episode, no second report");
  assert.deepEqual(w.step(mb({ deficitF: 0 }), T0 + 4 * HOUR), [], "the false count restarted at 1");
  // That was binding cycle 5; from cycle 6 the streak alone keeps the condition true, so a deficit-only clear cannot be
  // shown on this watch. Use a verified flip instead: the owner confirmed the type in TempIQ mid-episode.
  const w2 = new UnverifiedBindingWatch();
  w2.step(mb({ deficitF: 2 }), T0);
  assert.deepEqual(run(w2, mb({ verified: true, deficitF: 2 }), CLEAR_CYCLES - 1, T0 + HOUR), []);
  const ev = w2.step(mb({ verified: true, deficitF: 2 }), T0 + CLEAR_CYCLES * HOUR);
  assert.equal(kinds(ev).join(), "clear");
  assert.equal(ev[0].kind === "clear" && ev[0].episode.cleared_by, "condition_false");
  assert.equal(ev[0].kind === "clear" && ev[0].episode.cycles_at_close, CLEAR_CYCLES + 1);
  assert.match(describeEvent(ev[0]), /the condition has been false for 3 cycles/);
  assert.equal(w2.current(), null);
}

// ── 8. the streak keeps a long episode open with the room silent; a second episode later reports again ───────────────
{
  const w = new UnverifiedBindingWatch();
  // episode 1: deficit opens it at cycle 1, telemetry goes away, the streak takes over at cycle 6 — never clears
  w.step(mb({ deficitF: 2 }), T0);
  assert.deepEqual(run(w, mb({ deficitF: null }), 2, T0 + HOUR), [], "2 false cycles (no telemetry, cycles 2–3)");
  assert.deepEqual(w.step(mb({ deficitF: 1 }), T0 + 3 * HOUR), [], "cycle 4 true again");
  assert.deepEqual(run(w, mb({ deficitF: null }), 12, T0 + 4 * HOUR), [], "cycles 5–16: cycle 5 false, 6+ true via the streak");
  assert.ok(w.current(), "still open");
  // Dining Room takes over → clear #1
  const c1 = w.step(mb({ zone: "Dining Room", verified: true, deficitF: 0 }), T0 + 16 * HOUR);
  assert.equal(kinds(c1).join(), "clear");
  // episode 2 the next evening: Master Bathroom binds again with a deficit → a fresh open with a fresh `since`
  const o2 = w.step(mb({ deficitF: 1.2 }), T0 + 30 * HOUR);
  assert.equal(kinds(o2).join(), "open");
  assert.equal(o2[0].kind === "open" && o2[0].report.since, new Date(T0 + 30 * HOUR).toISOString());
  assert.equal(o2[0].kind === "open" && o2[0].report.cycles, 1, "a new episode's cycle count starts over");
  const wk = w.week(T0 + 31 * HOUR);
  assert.equal(wk.length, 2, "the week view: the closed episode and the open one");
  assert.equal(wk[0].cleared_by, "binding_changed");
  assert.equal(wk[0].cycles_at_close, 16);
  assert.equal(wk[0].max_deficit_f, 2);
  assert.equal(wk[1].until, null);
  // a week later the closed one has aged out; the open one stays
  const later = w.week(T0 + 16 * HOUR + WEEK_MS + 1);
  assert.equal(later.length, 1);
  assert.equal(later[0].until, null);
  // week() hands out copies — a caller mutating /health output cannot corrupt the watch
  later[0].zone = "x";
  assert.equal(w.current()?.zone, "Master Bathroom");
}

console.log("unverified-binding.test.ts: ok");
