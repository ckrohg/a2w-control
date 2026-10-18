/**
 * @purpose Assertions for the Pi-link dropout tracker (#166). Plain node:assert under tsx,
 * the same shape as the planner suites: `npm test` in hub/, or `npx tsx src/dropouts.test.ts`.
 *
 * Each case drives an injected clock, so the measured Oct 17 window (disconnected 05:31Z,
 * reconnected 07:41Z, 2 h 10 min) can be replayed exactly and a 15-second flap can be shown
 * to land as 0.3 min rather than vanishing or rounding up to a "real" dropout.
 */

import assert from "node:assert/strict";
import { createDropoutTracker, toMinutes, WINDOW_24H_MS, WINDOW_7D_MS } from "./dropouts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-17T00:00:00Z");

/** A clock the test moves by hand. */
function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    at: (iso: string) => { t = Date.parse(iso); },
    advance: (ms: number) => { t += ms; },
  };
}

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok   ${name}`);
}

// ---------------------------------------------------------------------------

test("boot → first connect is not a dropout; snapshot is empty and connected", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  c.advance(5 * MIN);
  assert.equal(tr.connected(), null, "the wait for the first Pi after boot is not an episode");
  const s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 0);
  assert.equal(s.pi_dropouts_7d, 0);
  assert.equal(s.longest_dropout_min, 0);
  assert.equal(s.last_dropout, null);
  assert.equal(s.current_dropout_min, null);
  assert.equal(s.tracking_since, "2026-10-17T00:00:00.000Z");
});

test("a clean dropout: the measured Oct 17 window reads as ONE episode of 130 min", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  c.at("2026-10-17T00:00:30Z"); tr.connected();
  c.at("2026-10-17T05:31:00Z");
  assert.equal(tr.disconnected(), true, "first disconnect opens the episode");
  c.at("2026-10-17T07:41:00Z");
  const ended = tr.connected();
  assert.deepEqual(ended, {
    start: "2026-10-17T05:31:00.000Z",
    end: "2026-10-17T07:41:00.000Z",
    minutes: 130,
  });
  c.advance(10 * MIN);
  const s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 1);
  assert.equal(s.pi_dropouts_7d, 1);
  assert.equal(s.longest_dropout_min, 130);
  assert.deepEqual(s.last_dropout, ended);
  assert.equal(s.current_dropout_min, null, "connected again → no open dropout");
});

test("a sub-minute flap is a dropout of 0.3 min — counted, and distinguishable from a real outage", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  c.advance(60 * MIN);
  tr.disconnected();
  c.advance(15_000);                       // 15 s WiFi blip
  const ended = tr.connected();
  assert.ok(ended);
  assert.equal(ended.minutes, 0.3);
  const s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 1, "a flap still counts as an episode");
  assert.equal(s.longest_dropout_min, 0.3);
  assert.equal(toMinutes(0), 0, "an instantaneous reconnect is 0, never negative");
  assert.equal(toMinutes(-5), 0);
});

test("a replacement connection (new socket while the old one is still up) is NOT a dropout", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  c.advance(30 * MIN);
  // index.ts: the new socket arrives, becomes piSocket, and the old one is closed AFTER —
  // so the tracker sees connected() twice with no disconnected() in between.
  assert.equal(tr.connected(), null, "second connect while up is a no-op");
  c.advance(30 * MIN);
  const s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 0);
  assert.equal(s.last_dropout, null);
  assert.equal(s.current_dropout_min, null);
  // ...and a genuine dropout afterwards is still measured from its own start, not from boot.
  tr.disconnected();
  c.advance(2 * MIN);
  assert.equal(tr.connected()?.minutes, 2);
});

test("a repeated disconnect (missed pong → terminate → close) opens exactly one episode", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  c.advance(10 * MIN);
  assert.equal(tr.disconnected(), true);
  c.advance(1 * MIN);
  assert.equal(tr.disconnected(), false, "already down: must not restart the clock");
  c.advance(4 * MIN);
  const ended = tr.connected();
  assert.equal(ended?.minutes, 5, "measured from the FIRST disconnect");
  assert.equal(tr.snapshot().pi_dropouts_24h, 1);
  assert.equal(tr.disconnected(), true);
  assert.equal(tr.disconnected(), false);
});

test("pruning: episodes leave the 24 h count by END time, stay in the 7 d count, then leave that too", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  // Episode A: 10 min, ends at T0+1h.  Episode B: 3 min, ends at T0+2h.
  c.advance(50 * MIN); tr.disconnected();
  c.advance(10 * MIN); tr.connected();
  c.advance(57 * MIN); tr.disconnected();
  c.advance(3 * MIN);  tr.connected();
  let s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 2);
  assert.equal(s.longest_dropout_min, 10);

  // Just under 24 h after A ended: A still inside the window.
  c.at(new Date(T0 + 60 * MIN + WINDOW_24H_MS - 1).toISOString());
  s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 2);
  assert.equal(s.longest_dropout_min, 10);

  // Exactly 24 h after A ended: A has left the 24 h window; B (3 min) is now the longest.
  c.advance(1);
  s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 1);
  assert.equal(s.longest_dropout_min, 3);
  assert.equal(s.pi_dropouts_7d, 2, "A is still in the 7 d count");
  assert.equal(s.last_dropout?.minutes, 3, "last_dropout is the most recent, not the longest");

  // Past 24 h for both: 24 h count is 0, 7 d still 2, last_dropout still reported.
  c.advance(2 * 60 * MIN);
  s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 0);
  assert.equal(s.longest_dropout_min, 0);
  assert.equal(s.pi_dropouts_7d, 2);
  assert.equal(s.last_dropout?.end, new Date(T0 + 120 * MIN).toISOString());

  // Past 7 d for A only.
  c.at(new Date(T0 + 60 * MIN + WINDOW_7D_MS).toISOString());
  s = tr.snapshot();
  assert.equal(s.pi_dropouts_7d, 1);
  // Past 7 d for both: the list is empty and last_dropout is gone.
  c.at(new Date(T0 + 120 * MIN + WINDOW_7D_MS).toISOString());
  s = tr.snapshot();
  assert.equal(s.pi_dropouts_7d, 0);
  assert.equal(s.last_dropout, null);
});

test("a still-open dropout: current_dropout_min grows, nothing is counted until it closes", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  c.at("2026-10-17T05:31:00Z");
  tr.disconnected();
  c.advance(45 * MIN);
  let s = tr.snapshot();
  assert.equal(s.current_dropout_min, 45);
  assert.equal(s.pi_dropouts_24h, 0, "open episodes are not counted — they have no end yet");
  assert.equal(s.longest_dropout_min, 0);
  assert.equal(s.last_dropout, null);
  c.advance(85 * MIN);
  s = tr.snapshot();
  assert.equal(s.current_dropout_min, 130);
  // Snapshots must not disturb the open episode's start.
  const ended = tr.connected();
  assert.equal(ended?.start, "2026-10-17T05:31:00.000Z");
  assert.equal(ended?.minutes, 130);
  assert.equal(tr.snapshot().current_dropout_min, null);
});

test("snapshot keys are exactly the /health additions (no accidental field drift)", () => {
  const tr = createDropoutTracker(clock().now);
  assert.deepEqual(Object.keys(tr.snapshot()).sort(), [
    "current_dropout_min", "last_dropout", "longest_dropout_min",
    "pi_dropouts_24h", "pi_dropouts_7d", "tracking_since",
  ]);
  assert.ok(Number.isInteger(tr.snapshot().pi_dropouts_24h), "drift-check compares it with -le");
});

test("a 7 d window of daily 2 h dropouts plus 20 flaps a day stays bounded and correct", () => {
  const c = clock();
  const tr = createDropoutTracker(c.now);
  tr.connected();
  for (let day = 0; day < 10; day++) {
    for (let i = 0; i < 20; i++) { c.advance(30 * MIN); tr.disconnected(); c.advance(10_000); tr.connected(); }
    c.advance(60 * MIN); tr.disconnected(); c.advance(120 * MIN); tr.connected();
    c.advance(WINDOW_24H_MS - 20 * (30 * MIN + 10_000) - 180 * MIN);
  }
  const s = tr.snapshot();
  assert.equal(s.pi_dropouts_24h, 21);
  assert.equal(s.longest_dropout_min, 120);
  assert.equal(s.pi_dropouts_7d, 7 * 21);
});

console.log(`dropouts.test.ts: ${passed} assertions groups passed`);
