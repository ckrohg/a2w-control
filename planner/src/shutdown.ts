/**
 * @purpose The planner's graceful-handover sequence on SIGTERM/SIGINT (and the POLL_ONCE one-shot's exit), split out
 * of index.ts so its ORDER is unit-testable against a stubbed store (#180). Every real deploy since #162 paid the full
 * 600–700 s staleness wait because the old container never released the writer lease; the handler logged nothing, so
 * nothing in the logs said why. This module (a) logs synchronously on the very first line, before any await, so a
 * signal that reaches node leaves a trace even if the process is killed a moment later; (b) releases the lease as soon
 * as no device write is on the wire — the write barrier is already up, so no new one can start — instead of after up
 * to 10.5 s of settling; (c) logs the outcome of every exit branch; (d) records the outcome on the instance's own
 * planner_instances row so the successor can report its predecessor's fate at startup (describePredecessors).
 *
 * Invariants kept from #162 (index.ts, near the lease code):
 *   - the lease is NEVER released over an in-flight device PATCH (two planners could then command the device);
 *   - a renew/claim that was in flight at the signal cannot keep the row: its own continuation releases a lease it
 *     landed after shuttingDown (index.ts), and the final check here releases again once every tracked lease op has
 *     settled — releaseWriterLease is conditional on `holder = me`, so a late release can never clear a successor's;
 *   - the hard-exit timer stays armed THROUGH store.close(), so a hung pool.end() cannot outlive the drain window.
 */

export interface ShutdownStore {
  /** Clears the lease row only if this instance holds it; true when a row was released. */
  releaseWriterLease(instanceId: string): Promise<boolean>;
  /** Marks this instance's heartbeat row as shut down (the successor's peer check ignores it; it reads the outcome). */
  recordShutdown(instanceId: string, outcome: { leaseReleased: boolean | null; note: string }): Promise<void>;
  close(): Promise<void>;
}

export interface ShutdownBudgets {
  /** Forced process.exit(0) after this long, whatever is still pending. Must fit inside Railway's drain window. */
  hardExitMs: number;
  /** How long to wait for running polls to finish (their DB inserts), post-barrier. */
  loopsMs: number;
  /** How long to wait for a lease renew/claim in flight at the signal (each of two chances). */
  leaseOpsMs: number;
}

/** 12 s hard exit inside RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20 (set on the service, handoff-2026-10-01). */
export const DEFAULT_BUDGETS: ShutdownBudgets = { hardExitMs: 12_000, loopsMs: 9_000, leaseOpsMs: 1_500 };

export interface ShutdownDeps {
  instanceId: string;
  leaseEnabled: boolean;
  store: ShutdownStore;
  /** Every loop() still running and every lease renew/claim still awaiting the DB (index.ts track()). */
  activeLoops: ReadonlySet<Promise<unknown>>;
  pendingLeaseOps: ReadonlySet<Promise<unknown>>;
  /** Device PATCHes currently on the wire (writes.ts). */
  deviceWritesInFlight(): number;
  /** SYNCHRONOUS: sets shuttingDown, aborts shutdown-aware waits, raises the write barrier, stops the claim-retry timer. */
  raiseBarrier(): void;
  /** Resolves true when every promise in the set settled within boundMs, false on the bound. */
  settleAll(set: ReadonlySet<Promise<unknown>>, boundMs: number): Promise<boolean>;
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  /** process.exit — called only by the hard-exit timer. */
  exit(code: number): void;
  now?: () => number;
  budgets?: ShutdownBudgets;
}

export interface ShutdownOutcome {
  /** null when the writer lease is disabled. */
  leaseReleased: boolean | null;
  /** Which step released it: "early" (no write on the wire at the signal), "after-drain" (a write finished during
   *  cleanup), "final" (the last check undid a late renew), or null. */
  releasedAt: "early" | "after-drain" | "final" | null;
  loopsSettled: boolean;
  leaseOpsSettled: boolean;
  writesOnWireAtExit: number;
  elapsedMs: number;
  /** One line for the DB row and the successor's log. */
  note: string;
}

/**
 * Run the whole sequence. The first log line and the barrier happen synchronously, inside this call, before the
 * returned promise is even created — nothing can be scheduled between the signal and them.
 */
export function runShutdown(reason: string, deps: ShutdownDeps): Promise<ShutdownOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  // 1. The trace that was missing in production (#180): synchronous, before any await.
  deps.log(`[shutdown] ${reason} received at ${new Date(t0).toISOString()}; loops=${deps.activeLoops.size} leaseOps=${deps.pendingLeaseOps.size} writesOnWire=${deps.deviceWritesInFlight()}`);
  // 2. Barrier: no new device write, renew, claim or timer from here on.
  deps.raiseBarrier();
  return drain(reason, deps, t0, now);
}

async function drain(reason: string, deps: ShutdownDeps, t0: number, now: () => number): Promise<ShutdownOutcome> {
  const { instanceId, leaseEnabled, store } = deps;
  const budgets = deps.budgets ?? DEFAULT_BUDGETS;
  const elapsed = () => now() - t0;
  let released: boolean | null = leaseEnabled ? false : null;
  let releasedAt: ShutdownOutcome["releasedAt"] = null;
  let loopsDone = false, leaseOpsDone = false;
  const leaseWord = () => released === null ? "lease disabled" : released ? `lease released (${releasedAt})` : "lease NOT released";

  const hardExit = setTimeout(() => {
    deps.error(`[shutdown] ${reason}: forced exit after ${budgets.hardExitMs} ms — in-flight work did not finish (loops settled: ${loopsDone}, lease ops settled: ${leaseOpsDone}, device writes on the wire: ${deps.deviceWritesInFlight()}); ${leaseWord()}; exiting 0`);
    deps.exit(0);
  }, budgets.hardExitMs);
  hardExit.unref?.();

  // 3. Mark the heartbeat row shut down FIRST (not awaited: a slow DB must not eat the budget; the write at the end
  // carries the outcome). A barred, shutting-down instance is no longer a writer; the successor's peer check skips it.
  void store.recordShutdown(instanceId, { leaseReleased: null, note: `${reason}: shutting down` })
    .catch((e) => deps.error(`[shutdown] heartbeat row mark failed: ${(e as Error).message}`));

  const release = async (): Promise<boolean> =>
    store.releaseWriterLease(instanceId).catch((e) => { deps.error(`[shutdown] ${reason}: lease release failed: ${(e as Error).message}`); return false; });

  // 4. Release NOW if nothing is on the wire. The barrier guarantees no new write starts, so a running poll or a
  // pending renew is not a reason to wait: the renew's own continuation and the final check below undo a re-claim.
  const writeOnWireAtSignal = deps.deviceWritesInFlight() > 0;
  if (!leaseEnabled) {
    deps.log(`[shutdown] ${reason}: writer lease disabled — nothing to release`);
  } else if (!writeOnWireAtSignal) {
    const r = await release();
    if (r) { released = true; releasedAt = "early"; }
    deps.log(`[shutdown] ${reason}: writer lease ${r ? "released" : "not held"} by ${instanceId} ${elapsed()} ms after the signal (no device write on the wire; ${deps.activeLoops.size} poll(s) and ${deps.pendingLeaseOps.size} lease op(s) still draining)`);
  } else {
    deps.warn(`[shutdown] ${reason}: ${deps.deviceWritesInFlight()} device write(s) on the wire — the lease is released once they finish, never over one`);
  }

  // 5. Drain what is running: polls finish their inserts, a lease op in flight lands. A device write admitted outside a
  // poll (the dashboard API routes) is in neither set, so when one was on the wire at the signal, keep waiting for it
  // inside what is left of the loop budget — the hard exit bounds everything anyway.
  const drainStart = now();
  loopsDone = await deps.settleAll(deps.activeLoops, budgets.loopsMs);
  leaseOpsDone = await deps.settleAll(deps.pendingLeaseOps, budgets.leaseOpsMs);
  while (leaseEnabled && releasedAt === null && deps.deviceWritesInFlight() > 0 && now() - drainStart < budgets.loopsMs) {
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, budgets.loopsMs - (now() - drainStart)))));
  }

  // 6. Not released yet — a write was on the wire at the signal, or the early attempt found the row not held (a claim
  // in flight had not landed): release now if nothing is on the wire, else leave the row to the staleness window (the
  // old, safe path — two planners must never command the device).
  if (leaseEnabled && releasedAt === null) {
    const w = deps.deviceWritesInFlight();
    if (w === 0) {
      const r = await release();
      if (r) { released = true; releasedAt = "after-drain"; }
      const why = writeOnWireAtSignal ? "once the in-flight write finished" : "on the retry after the drain (the first attempt found it not held)";
      deps.log(`[shutdown] ${reason}: writer lease ${r ? "released" : "not held"} by ${instanceId} ${elapsed()} ms after the signal, ${why} (loops settled: ${loopsDone}, lease ops settled: ${leaseOpsDone})`);
    } else {
      deps.warn(`[shutdown] ${reason}: NOT releasing the writer lease — ${w} device write(s) still on the wire ${elapsed()} ms after the signal (loops settled: ${loopsDone}, lease ops settled: ${leaseOpsDone}); the successor takes over after the staleness window`);
    }
  }

  // 7. Final check: a renew/claim that was in flight at the signal may have re-claimed the row after the release.
  // Release once more, but ONLY when every tracked lease op has settled (one still pending could land after this
  // too). Its own continuation (index.ts) releases as well; both are conditional on `holder = me`, so neither can
  // touch the successor's lease.
  if (!leaseOpsDone) leaseOpsDone = await deps.settleAll(deps.pendingLeaseOps, budgets.leaseOpsMs);
  if (leaseEnabled && leaseOpsDone && deps.deviceWritesInFlight() === 0) {
    const r = await release();
    if (r) {
      deps.log(`[shutdown] ${reason}: writer lease released on the final check ${elapsed()} ms after the signal (a renew landed after the first release)`);
      released = true; releasedAt ??= "final";
    }
  } else if (leaseEnabled && !leaseOpsDone) {
    deps.warn(`[shutdown] ${reason}: a lease renew/claim is still pending ${elapsed()} ms after the signal — if it re-claimed the row, its own continuation releases it; otherwise the successor takes over after the staleness window`);
  }

  const writesOnWireAtExit = deps.deviceWritesInFlight();
  const note = `${reason}: ${leaseWord()}; loops settled ${loopsDone}, lease ops settled ${leaseOpsDone}, writes on the wire ${writesOnWireAtExit}; ${elapsed()} ms`;
  // 8. The outcome, for the successor's startup line (and a retry of the early mark, which a racing heartbeat may have beaten).
  await store.recordShutdown(instanceId, { leaseReleased: released, note })
    .catch((e) => deps.error(`[shutdown] ${reason}: outcome record failed: ${(e as Error).message}`));
  // 9. Close with the hard-exit timer still armed: a hung pool.end() must not outlive the drain window.
  await store.close().catch((e) => deps.error(`[shutdown] ${reason}: store close failed: ${(e as Error).message}`));
  clearTimeout(hardExit);
  deps.log(`[shutdown] ${reason}: done ${elapsed()} ms after the signal — ${leaseWord()}; loops settled ${loopsDone}, lease ops settled ${leaseOpsDone}, device writes on the wire ${writesOnWireAtExit}; exiting 0`);
  return { leaseReleased: released, releasedAt, loopsSettled: loopsDone, leaseOpsSettled: leaseOpsDone, writesOnWireAtExit, elapsedMs: elapsed(), note };
}

// ── The successor's side ─────────────────────────────────────────────────────────────────────────────────────────────

/** planner_instances rows other than our own, as the store returns them at startup. */
export interface PredecessorRow {
  instanceId: string;
  /** ms since the row's last heartbeat, on the DB clock. */
  heartbeatAgeMs: number;
  /** null: the instance never recorded a shutdown (killed before its handler ran, or still running). */
  shutdownAt: Date | null;
  leaseReleased: boolean | null;
  note: string | null;
}

/**
 * One log line per predecessor row (newest first), so the first thing a new deploy says is what happened to the one
 * it replaced. A row with no shutdown record and a STALE heartbeat (older than freshMs) is the #180 signature: the
 * container was killed without its SIGTERM handler ever running. A row with no shutdown record and a FRESH heartbeat is
 * the normal rolling-deploy case — Railway signals the old container only after this one is healthy — so it is
 * reported as still running, not as a fault. index.ts logs these again when the writer lease is acquired, by which
 * point the predecessor has handed over.
 */
export function describePredecessors(rows: PredecessorRow[], freshMs = 12 * 60 * 1000): string[] {
  if (!rows.length) return ["[startup] no predecessor instance row within the last hour"];
  const s = (ms: number) => `${Math.round(ms / 1000)} s`;
  return rows.map((r) => {
    if (r.shutdownAt) {
      const lease = r.leaseReleased === true ? "released the writer lease" : r.leaseReleased === false ? "did NOT release the writer lease" : "lease outcome not recorded";
      return `[startup] predecessor ${r.instanceId} shut down at ${r.shutdownAt.toISOString()} (last heartbeat ${s(r.heartbeatAgeMs)} ago) and ${lease}${r.note ? ` — ${r.note}` : ""}`;
    }
    if (r.heartbeatAgeMs < freshMs) {
      return `[startup] predecessor ${r.instanceId} still running (last heartbeat ${s(r.heartbeatAgeMs)} ago, no shutdown recorded yet) — normal during a rolling deploy`;
    }
    return `[startup] predecessor ${r.instanceId} never recorded a shutdown (last heartbeat ${s(r.heartbeatAgeMs)} ago): killed before its SIGTERM handler ran — the lease waits out the staleness window unless it released`;
  });
}
