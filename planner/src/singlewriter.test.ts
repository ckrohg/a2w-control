/**
 * @purpose Assertions for singlewriter.ts: a redeploy's dead container no longer counts as a second planner, while a
 * genuinely live peer still does after two polls. Replays 2026-10-20 ~21:47 ET (f3d6d5eafb00 listed the stopped
 * d2df60d3ffb4 as a peer for ~12 min). Run with: npx tsx planner/src/singlewriter.test.ts
 */
import assert from "node:assert/strict";
import { livePeers, observePeers, peerLiveMs, type PeerHeartbeat } from "./singlewriter";

const POLL_S = 300;
const LIVE_MS = peerLiveMs(POLL_S);
assert.equal(LIVE_MS, 450_000, "1.5 × the 5-min poll");
const min = (m: number) => m * 60_000;
const T0 = new Date("2026-10-21T01:47:00Z").getTime(); // 21:47 ET, the new instance's first poll

// The store returns every peer row inside INSTANCE_FRESH_MS (12 min): its heartbeat_at and its age at our poll.
const row = (instanceId: string, pollAtMs: number, heartbeatAtMs: number): PeerHeartbeat =>
  ({ instanceId, heartbeatAtMs, ageMs: pollAtMs - heartbeatAtMs });
const at = (k: number) => T0 + min(5 * k); // our polls, every 5 min
function run(polls: PeerHeartbeat[][]): string[][] {
  let prev = new Map<string, number>();
  return polls.map((rows) => { const o = observePeers(prev, rows, LIVE_MS); prev = o.next; return o.sustained; });
}

// Dead peer: the old container's last heartbeat was 1 min before our first poll, then it was SIGTERMed and its row
// left behind. We see the same heartbeat_at at ages 1, 6, 11 min. Age 6 min is still under 1.5 polls (7.5 min), so
// age alone would have flagged it on poll 2; the unchanged heartbeat_at is what rules it out.
const dead = "d2df60d3ffb4:1";
const deadHb = T0 - min(1);
const deadPolls = [0, 1, 2].map((k) => [row(dead, at(k), deadHb)]);
assert.deepEqual(run(deadPolls), [[], [], []], "a dead container's stale row never becomes a sustained second instance");
assert.deepEqual(livePeers(deadPolls[0], LIVE_MS), [dead], "fresh on the first poll (it really did just run)");
assert.deepEqual(livePeers(deadPolls[2], LIVE_MS), [], "and past 1.5 polls it is not even listed");
// worst case for the old logic: last heartbeat just before our first poll — still never sustained
assert.deepEqual(run([0, 1].map((k) => [row(dead, at(k), T0 - 1_000)])), [[], []]);

// Live peer: heartbeats every poll, 2 min before each of ours (with a slow poll on the third).
const live = "rogue:7";
const liveHbs = [at(0) - min(2), at(1) - min(2), at(2) - min(6)];
const livePolls = [0, 1, 2].map((k) => [row(live, at(k), liveHbs[k])]);
assert.deepEqual(run(livePolls), [[], [live], [live]], "a genuinely live peer is sustained from the second poll");

// Both at once: the dead row drops out, the live one still counts.
assert.deepEqual(run([0, 1].map((k) => [...deadPolls[k], ...livePolls[k]])), [[], [live]]);

// A peer that misses a poll (its heartbeat did not advance) is not sustained on that poll, and is again once it does.
assert.deepEqual(run([[row(live, at(0), at(0) - min(1))], [row(live, at(1), at(0) - min(1))], [row(live, at(2), at(2) - min(1))]]),
  [[], [], [live]]);

// Boundary + bad data
assert.deepEqual(livePeers([row("a", T0, T0 - LIVE_MS), row("b", T0, T0 - LIVE_MS - 1)], LIVE_MS), ["a"]);
assert.deepEqual(livePeers([{ instanceId: "c", ageMs: NaN, heartbeatAtMs: T0 }], LIVE_MS), [], "an unparseable age is not a live peer");
assert.deepEqual(observePeers(new Map([["d", T0 - 1]]), [{ instanceId: "d", ageMs: 0, heartbeatAtMs: NaN }], LIVE_MS).sustained, []);

console.log("singlewriter.test.ts: all assertions passed");
