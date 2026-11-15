/**
 * @purpose Assertions for shutdown.ts (#180): the signal is logged synchronously before any await; the writer lease is
 * released as soon as no device write is on the wire (not after the drain); it is never released over an in-flight
 * PATCH; a renew that re-claims after the release is undone by the final check; a lease op that never settles leaves
 * the row alone; the hard exit fires through a hung store.close(); every branch logs; the outcome lands on the
 * instance row; the successor's startup lines read right. Run with: npx tsx planner/src/shutdown.test.ts
 */
import assert from "node:assert/strict";
import { runShutdown, describePredecessors, type ShutdownDeps, type ShutdownStore, type ShutdownOutcome } from "./shutdown";
import { HubClient, hubActuationsInFlight } from "./hub";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
/** The real settleAll from index.ts. */
async function settleAll(set: ReadonlySet<Promise<unknown>>, boundMs: number): Promise<boolean> {
  const all = Promise.allSettled([...set]);
  return Promise.race([all.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), boundMs))]);
}
const ME = "host:1";
const BUDGETS = { hardExitMs: 400, loopsMs: 80, leaseOpsMs: 40 };

interface Harness {
  deps: ShutdownDeps;
  events: string[];                  // ordered trace of store calls and barrier
  logs: string[];                    // every log/warn/error line, in order
  lease: { holder: string | null };  // the lease row
  recorded: { leaseReleased: boolean | null; note: string }[];
  writes: { n: number };
  exits: number[];
  loops: Set<Promise<unknown>>;
  leaseOps: Set<Promise<unknown>>;
}
function harness(opts: { leaseEnabled?: boolean; holder?: string | null; closeHangs?: boolean } = {}): Harness {
  const events: string[] = [], logs: string[] = [], exits: number[] = [];
  const lease = { holder: opts.holder === undefined ? ME : opts.holder };
  const recorded: Harness["recorded"] = [];
  const writes = { n: 0 };
  const loops = new Set<Promise<unknown>>(), leaseOps = new Set<Promise<unknown>>();
  const store: ShutdownStore = {
    async releaseWriterLease(id) { events.push(`release(${lease.holder ?? "null"})`); if (lease.holder === id) { lease.holder = null; return true; } return false; },
    async recordShutdown(_id, outcome) { events.push(`record(${outcome.leaseReleased})`); recorded.push(outcome); },
    async close() { events.push("close"); if (opts.closeHangs) await new Promise(() => {}); },
  };
  const deps: ShutdownDeps = {
    instanceId: ME, leaseEnabled: opts.leaseEnabled ?? true, store, activeLoops: loops, pendingLeaseOps: leaseOps,
    deviceWritesInFlight: () => writes.n,
    raiseBarrier: () => events.push("barrier"),
    settleAll,
    log: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l),
    exit: (c) => { exits.push(c); events.push(`exit(${c})`); },
    budgets: BUDGETS,
  };
  return { deps, events, logs, lease, recorded, writes, exits, loops, leaseOps };
}
const has = (lines: string[], re: RegExp) => lines.some((l) => re.test(l));

async function idleRelease(): Promise<void> {
  // ── 1. Idle planner (the deploy case): first line synchronous, release before anything else, every branch logged ──
  const h = harness();
  const t0 = Date.now();
  const p = runShutdown("SIGTERM", h.deps);
  // Synchronous: the log line and the barrier are already there, before a single await has run.
  assert.equal(h.logs.length, 1, "exactly one line before the first await");
  assert.match(h.logs[0], /^\[shutdown\] SIGTERM received at \d{4}-\d\d-\d\dT[\d:.]+Z; loops=0 leaseOps=0 writesOnWire=0$/);
  // The barrier, the row mark and the release CALL are all issued inside the same tick as the signal — nothing else
  // (a renew, a write admission) can be scheduled between the signal and them.
  assert.deepEqual(h.events, ["barrier", "record(null)", `release(${ME})`], "barrier, mark and release are issued before the handler yields");
  const out: ShutdownOutcome = await p;
  assert.equal(h.lease.holder, null, "the lease row is cleared");
  assert.equal(out.leaseReleased, true);
  assert.equal(out.releasedAt, "early", "released by the early step, not after the drain");
  assert.ok(out.elapsedMs < BUDGETS.loopsMs, `an idle planner releases and exits without waiting out the drain (took ${out.elapsedMs} ms)`);
  // Order: barrier → early mark (not awaited) → release → … → outcome record → close. The early release precedes the
  // first store.close and the mark carries no outcome yet.
  const i = (e: string) => h.events.indexOf(e);
  assert.ok(i("barrier") < i("record(null)") && i("record(null)") < i(`release(${ME})`), `order: ${h.events.join(" → ")}`);
  assert.ok(i(`release(${ME})`) < i("record(true)") && i("record(true)") < i("close"), `order: ${h.events.join(" → ")}`);
  assert.equal(h.events.filter((e) => e.startsWith("release(")).length, 2, "early release + the final check (which finds it already null)");
  assert.ok(has(h.logs, /writer lease released by host:1 \d+ ms after the signal \(no device write on the wire; 0 poll\(s\) and 0 lease op\(s\) still draining\)/), h.logs.join("\n"));
  assert.ok(!has(h.logs, /final check/), "the final check found nothing to undo, so it says nothing");
  assert.match(h.logs[h.logs.length - 1], /^\[shutdown\] SIGTERM: done \d+ ms after the signal — lease released \(early\); loops settled true, lease ops settled true, device writes on the wire 0; exiting 0$/);
  assert.deepEqual(h.recorded.map((r) => r.leaseReleased), [null, true], "the row is marked at once, then given the outcome");
  assert.match(h.recorded[1].note, /^SIGTERM: lease released \(early\); loops settled true, lease ops settled true, writes on the wire 0; \d+ ms$/);
  assert.deepEqual(h.exits, [], "the hard exit never fired");
  assert.ok(Date.now() - t0 < BUDGETS.hardExitMs);
}

async function releaseWhilePollRuns(): Promise<void> {
  // ── 2. A poll is still running (no write on the wire): release does NOT wait for it; the poll still gets its drain ──
  const h = harness();
  const loop = deferred();
  let loopDone = false;
  h.loops.add(loop.promise);
  let holderAtRelease: string | null | undefined;
  const origRelease = h.deps.store.releaseWriterLease.bind(h.deps.store);
  h.deps.store.releaseWriterLease = async (id) => { holderAtRelease ??= loopDone ? "after-loop" : "during-loop"; return origRelease(id); };
  setTimeout(() => { loopDone = true; loop.resolve(); h.loops.delete(loop.promise); }, 30);
  const out = await runShutdown("SIGTERM", h.deps);
  assert.equal(holderAtRelease, "during-loop", "the lease was released while the poll was still running");
  assert.equal(out.releasedAt, "early");
  assert.equal(out.loopsSettled, true, "and the poll was still waited for (its inserts finish)");
  assert.ok(has(h.logs, /1 poll\(s\) and 0 lease op\(s\) still draining/), h.logs.join("\n"));
}

async function neverOverAWrite(): Promise<void> {
  // ── 3. A device PATCH is on the wire at the signal: no early release; released once it finishes ──
  const h = harness();
  h.writes.n = 1;
  setTimeout(() => { h.writes.n = 0; }, 30); // the PATCH completes during the drain
  const p = runShutdown("SIGTERM", h.deps);
  assert.match(h.logs[0], /writesOnWire=1$/);
  const out = await p;
  assert.ok(has(h.logs, /1 device write\(s\) on the wire — the lease is released once they finish, never over one/), h.logs.join("\n"));
  assert.equal(out.releasedAt, "after-drain");
  assert.equal(out.leaseReleased, true);
  assert.equal(h.lease.holder, null);
  assert.ok(has(h.logs, /writer lease released by host:1 \d+ ms after the signal, once the in-flight write finished/), h.logs.join("\n"));
  // the release happened strictly after the write count dropped: no release call while n was 1
  const firstRelease = h.events.findIndex((e) => e.startsWith("release("));
  assert.ok(firstRelease > 0, "there was a release");

  // ── 4. The PATCH never finishes inside the budget: the row is left alone (the old, safe staleness path) ──
  const g = harness();
  g.writes.n = 1;
  const out2 = await runShutdown("SIGTERM", g.deps);
  assert.equal(out2.leaseReleased, false);
  assert.equal(out2.releasedAt, null);
  assert.equal(g.lease.holder, ME, "the lease row still names us: the successor takes over after the staleness window");
  assert.equal(g.events.filter((e) => e.startsWith("release(")).length, 0, "no release call of any kind over an in-flight write");
  assert.ok(has(g.logs, /NOT releasing the writer lease — 1 device write\(s\) still on the wire/), g.logs.join("\n"));
  assert.match(g.logs[g.logs.length - 1], /done \d+ ms after the signal — lease NOT released; .*device writes on the wire 1; exiting 0$/);
  assert.equal(g.recorded[1].leaseReleased, false);
  assert.deepEqual(g.exits, []);
}

async function neverOverAHubCommand(): Promise<void> {
  // ── 4b. A Phase B setpoint already past the barrier is on its way to the Pi (hub.ts, not writes.ts): the lease is not
  //        released early over it; it is released once the command returns. Uses the real HubClient counter. ──
  const h = harness();
  const answer = deferred<Response>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => answer.promise) as typeof fetch;
  try {
    const hub = new HubClient("http://hub.invalid", "t");
    const send = hub.sendSetpoint("pump1", 55, 90, "phase-b"); // counted synchronously, before its first await
    assert.equal(hubActuationsInFlight(), 1, "the command is counted the moment it is issued");
    h.deps.deviceWritesInFlight = () => h.writes.n + hubActuationsInFlight();
    setTimeout(() => answer.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })), 30);
    const p = runShutdown("SIGTERM", h.deps);
    assert.match(h.logs[0], /writesOnWire=1$/);
    assert.ok(!h.events.some((e) => e.startsWith("release(")), "no early release while the hub command is on the wire");
    const out = await p;
    assert.equal((await send).ok, true);
    assert.equal(hubActuationsInFlight(), 0, "the counter drops when the command returns");
    assert.equal(out.releasedAt, "after-drain", "released only after the hub command finished");
    assert.equal(h.lease.holder, null);
  } finally {
    globalThis.fetch = realFetch;
  }
  // a failed command (fetch throws) also decrements
  globalThis.fetch = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
  try {
    const r = await new HubClient("http://hub.invalid", "t").sendBreaker("c", "open", "a", "backup-gate");
    assert.equal(r.ok, false);
    assert.equal(hubActuationsInFlight(), 0, "a failed command is not left counted");
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function lateRenewUndone(): Promise<void> {
  // ── 5. A renew in flight at the signal lands after the early release and re-claims the row: the final check undoes it ──
  const h = harness();
  const renew = deferred();
  h.leaseOps.add(renew.promise);
  setTimeout(() => { h.lease.holder = ME; renew.resolve(); h.leaseOps.delete(renew.promise); }, 20); // the renew lands: holder = me again
  const out = await runShutdown("SIGTERM", h.deps);
  assert.equal(h.lease.holder, null, "the re-claimed row is released again");
  assert.equal(out.releasedAt, "early");
  assert.equal(out.leaseOpsSettled, true);
  assert.ok(has(h.logs, /writer lease released on the final check \d+ ms after the signal \(a renew landed after the first release\)/), h.logs.join("\n"));
  assert.deepEqual(h.events.filter((e) => e.startsWith("release(")), [`release(${ME})`, `release(${ME})`]);

  // ── 5b. The first attempt found the row not held (a claim in flight had not landed yet); the final check releases ──
  const g = harness({ holder: null });
  const claim = deferred();
  g.leaseOps.add(claim.promise);
  setTimeout(() => { g.lease.holder = ME; claim.resolve(); g.leaseOps.delete(claim.promise); }, 20);
  const out2 = await runShutdown("SIGINT", g.deps);
  assert.equal(g.lease.holder, null);
  assert.equal(out2.leaseReleased, true);
  assert.equal(out2.releasedAt, "after-drain", "the retry after the drain catches the claim that landed");
  assert.ok(has(g.logs, /SIGINT: writer lease not held by host:1 \d+ ms after the signal \(no device write on the wire/), g.logs.join("\n"));
  assert.ok(has(g.logs, /SIGINT: writer lease released by host:1 \d+ ms after the signal, on the retry after the drain \(the first attempt found it not held\)/), g.logs.join("\n"));
  assert.ok(!has(g.logs, /final check/), "nothing left for the final check to undo");
}

async function pendingLeaseOpLeavesRow(): Promise<void> {
  // ── 6. A lease op that never settles: the early release still happens (nothing on the wire), the final check is
  //       skipped (an op still pending could land after it), and the warning says so ──
  const h = harness();
  h.leaseOps.add(new Promise(() => {}));
  const out = await runShutdown("SIGTERM", h.deps);
  assert.equal(out.releasedAt, "early");
  assert.equal(out.leaseOpsSettled, false);
  assert.equal(h.events.filter((e) => e.startsWith("release(")).length, 1, "early release only — no final check while an op is pending");
  assert.ok(has(h.logs, /a lease renew\/claim is still pending \d+ ms after the signal/), h.logs.join("\n"));
  assert.match(h.logs[h.logs.length - 1], /lease ops settled false/);
  assert.deepEqual(h.exits, []);
}

async function leaseDisabled(): Promise<void> {
  // ── 7. Lease disabled: no release call, still logged, still recorded and closed ──
  const h = harness({ leaseEnabled: false });
  const out = await runShutdown("SIGTERM", h.deps);
  assert.equal(out.leaseReleased, null);
  assert.equal(h.events.filter((e) => e.startsWith("release(")).length, 0);
  assert.ok(has(h.logs, /writer lease disabled — nothing to release/), h.logs.join("\n"));
  assert.ok(h.events.includes("close"));
  assert.match(h.logs[h.logs.length - 1], /lease disabled;/);
  assert.equal(h.recorded[1].leaseReleased, null);
}

async function hardExitThroughHungClose(): Promise<void> {
  // ── 8. store.close() hangs: the hard exit fires (through the close), with the lease already released and a line saying so ──
  const h = harness({ closeHangs: true });
  const exited = new Promise<void>((r) => { h.deps.exit = (c) => { h.exits.push(c); r(); }; });
  // The hard-exit timer is unref'd (it must never keep a real process alive) and close() hangs forever, so without a
  // ref'd timer of our own the event loop empties and node exits 0 mid-test — silently skipping every scenario after
  // this one. Hold the loop open until the hard exit has fired.
  const keepAlive = setTimeout(() => {}, BUDGETS.hardExitMs + 2_000);
  const t0 = Date.now();
  void runShutdown("SIGTERM", h.deps);
  await exited;
  clearTimeout(keepAlive);
  const took = Date.now() - t0;
  assert.deepEqual(h.exits, [0]);
  assert.ok(took >= BUDGETS.hardExitMs - 20 && took < BUDGETS.hardExitMs + 300, `hard exit at the budget (${took} ms)`);
  assert.equal(h.lease.holder, null, "the lease had already been released before the hang");
  assert.ok(has(h.logs, /forced exit after 400 ms — in-flight work did not finish .*lease released \(early\); exiting 0/), h.logs.join("\n"));
  assert.ok(!has(h.logs, /: done /), "no 'done' line: the process was forced out");
}

async function storeErrorsAreLoggedNotFatal(): Promise<void> {
  // ── 9. A failing release / record / close never throws out of the sequence; each failure is one logged line ──
  const h = harness();
  h.deps.store.releaseWriterLease = async () => { throw new Error("db down"); };
  h.deps.store.recordShutdown = async () => { throw new Error("db down"); };
  h.deps.store.close = async () => { throw new Error("pool gone"); };
  const out = await runShutdown("SIGTERM", h.deps);
  assert.equal(out.leaseReleased, false);
  assert.ok(has(h.logs, /lease release failed: db down/), h.logs.join("\n"));
  assert.ok(has(h.logs, /heartbeat row mark failed: db down/), h.logs.join("\n"));
  assert.ok(has(h.logs, /outcome record failed: db down/), h.logs.join("\n"));
  assert.ok(has(h.logs, /store close failed: pool gone/), h.logs.join("\n"));
  assert.match(h.logs[h.logs.length - 1], /done .* exiting 0$/);
}

function successorLines(): void {
  // ── 10. The successor's startup lines ──
  assert.deepEqual(describePredecessors([]), ["[startup] no predecessor instance row within the last hour"]);
  const at = new Date("2026-11-11T20:00:00Z");
  const lines = describePredecessors([
    { instanceId: "old:7", heartbeatAgeMs: 95_000, shutdownAt: at, leaseReleased: true, note: "SIGTERM: lease released (early); 410 ms" },
    { instanceId: "older:3", heartbeatAgeMs: 800_000, shutdownAt: null, leaseReleased: null, note: null },
    { instanceId: "odd:9", heartbeatAgeMs: 10_000, shutdownAt: at, leaseReleased: false, note: null },
    { instanceId: "live:5", heartbeatAgeMs: 120_000, shutdownAt: null, leaseReleased: null, note: null },
  ]);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "[startup] predecessor old:7 shut down at 2026-11-11T20:00:00.000Z (last heartbeat 95 s ago) and released the writer lease — SIGTERM: lease released (early); 410 ms");
  assert.match(lines[1], /^\[startup\] predecessor older:3 never recorded a shutdown \(last heartbeat 800 s ago\): killed before its SIGTERM handler ran/);
  assert.match(lines[2], /predecessor odd:9 shut down at .* and did NOT release the writer lease$/);
  // rolling deploy: the old container is still up when the new one starts — reported as normal, not as the #180 fault
  assert.equal(lines[3], "[startup] predecessor live:5 still running (last heartbeat 120 s ago, no shutdown recorded yet) — normal during a rolling deploy");
}

// A test that empties the event loop exits 0 without reaching the end; make that a failure, not a silent pass.
let finished = false;
process.on("exit", (code) => { if (code === 0 && !finished) { console.error("shutdown.test.ts: exited before the last scenario ran"); process.exitCode = 1; } });

(async () => {
  await idleRelease();
  await releaseWhilePollRuns();
  await neverOverAWrite();
  await neverOverAHubCommand();
  await lateRenewUndone();
  await pendingLeaseOpLeavesRow();
  await leaseDisabled();
  await hardExitThroughHungClose();
  await storeErrorsAreLoggedNotFatal();
  successorLines();
  finished = true;
  console.log("shutdown.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
