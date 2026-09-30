/**
 * @purpose #153: prove Store.lastIdentificationWindowEnd's cooldown rule against a LOCAL Postgres (never prod) — the
 * unit suite fakes the store, so this is what protects the production SQL: only windows that HAPPENED start the
 * 60-min gap (a hold arm, a probe whose write was accepted, or in shadow a shadow window); a row the interlock
 * refused before anything was commanded never does, in either mode. Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://$(whoami)@localhost:5432/a2w_local npx tsx ../scripts/identify-cooldown-local-check.ts
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import type { IdentWindow } from "../planner/src/identify";

// DESTRUCTIVE (TRUNCATEs identification_windows): the URL is parsed structurally and must name the dedicated
// local database `a2w_local` on a literal loopback host with no connection options — a tunnel or proxy that
// happens to listen on localhost must not be reachable from here (codex on #153).
const url = process.env.LOCAL_DATABASE_URL ?? "";
let parsed: URL | null = null;
try { parsed = new URL(url); } catch { parsed = null; }
const okScheme = parsed != null && /^postgres(ql)?:$/.test(parsed.protocol);
const okHost = parsed != null && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
const okDb = parsed != null && parsed.pathname === "/a2w_local";
const okOpts = parsed != null && parsed.search === "" && parsed.hash === "";
if (!parsed || !okScheme || !okHost || !okDb || !okOpts) {
  console.error("refusing: LOCAL_DATABASE_URL must be postgres://<user>@localhost[:port]/a2w_local with no options (loopback host, the dedicated local database, nothing else)");
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;

const T0 = Date.now();
function row(over: Partial<IdentWindow>): Omit<IdentWindow, "id"> {
  return {
    createdAt: new Date(T0), state: "ended", arm: "probe", direction: "up", zoneIds: ["z"], bandLo: 30, bandHi: 45, magnitudeF: 8, baseF: 132, targetF: 140, capF: 145,
    drawProbability: 0.5, drawSeed: "s", startedAt: new Date(T0), endedAt: new Date(T0), endReason: "completed", durationMin: 120, writeId: null, writeAccepted: false,
    dryRun: false, postedOpen: false, postedClosed: false, cell: null, safeToProbe: null, armingTicks: 0, writeAttempts: 0, cleanupState: "none", cleanupDetail: null,
    cleanupAttempts: 0, handoffTargetF: null, ...over,
  };
}
async function lastEnd(includeDryRun: boolean) { return (await store.lastIdentificationWindowEnd(includeDryRun))?.getTime() ?? null; }

async function main() {
  await store.ensureSchema();
  try {
    await run();
  } finally {
    // Fixtures never outlive the check, whichever assertion fails.
    await pool.query(`TRUNCATE identification_windows RESTART IDENTITY`).catch(() => undefined);
    await store.close().catch(() => undefined);
  }
}

async function run() {
  await pool.query(`TRUNCATE identification_windows RESTART IDENTITY`);
  // 1. Nothing → null.
  assert.equal(await lastEnd(false), null);
  // 2. A LIVE probe refused by the interlock before any write (the newest row) → still null.
  await store.insertIdentificationWindow(row({ endedAt: new Date(T0 + 1000), endReason: "interlock:unreadable:HTTP 503", writeAccepted: false }));
  assert.equal(await lastEnd(false), null, "a refused-before-write probe never starts the cooldown");
  // 3. A live probe that was WRITTEN and then ended by plan_moved → counts.
  await store.insertIdentificationWindow(row({ endedAt: new Date(T0 + 2000), endReason: "plan_moved:132->137", writeAccepted: true }));
  assert.equal(await lastEnd(false), T0 + 2000, "an accepted probe counts");
  // 4. A newer refused row does NOT move the cooldown forward.
  await store.insertIdentificationWindow(row({ endedAt: new Date(T0 + 3000), endReason: "interlock:switchback_active:arm_log", writeAccepted: false }));
  assert.equal(await lastEnd(false), T0 + 2000, "a later refusal does not extend the cooldown");
  // 5. A live HOLD arm (never writes) counts by arm.
  await store.insertIdentificationWindow(row({ arm: "hold", endedAt: new Date(T0 + 4000), endReason: "completed", writeAccepted: false, targetF: 132 }));
  assert.equal(await lastEnd(false), T0 + 4000, "a hold arm counts");
  // 6. An unwritten live probe that ended by arming_timeout does not count (nothing happened).
  await store.insertIdentificationWindow(row({ endedAt: new Date(T0 + 5000), endReason: "arming_timeout", writeAccepted: false }));
  assert.equal(await lastEnd(false), T0 + 4000, "an unwritten timeout does not count");
  // 7. Shadow: a shadow window counts only for shadow draws; a shadow interlock refusal never counts.
  await store.insertIdentificationWindow(row({ dryRun: true, endedAt: new Date(T0 + 6000), endReason: "plan_moved:132->137" }));
  assert.equal(await lastEnd(false), T0 + 4000, "shadow rows are invisible to LIVE draws");
  assert.equal(await lastEnd(true), T0 + 6000, "shadow rows count for shadow draws");
  await store.insertIdentificationWindow(row({ dryRun: true, endedAt: new Date(T0 + 7000), endReason: "interlock:switchback_active:arm_log" }));
  assert.equal(await lastEnd(true), T0 + 6000, "a shadow interlock refusal never counts");
  console.log("identify-cooldown-local-check: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
