/**
 * @purpose a2w#167 / #173 — the guarded HBX writer against the hub's copy of the Pi. #167: both I1 checks (setTarget,
 * setCurve) refuse 503 when the Pi is disconnected from the hub or the hub's frame is older than PI_STATE_FRESH_MS —
 * the hub keeps serving a dropped Pi's last pumps[] and the writer used to read it as live (the 2026-10-17 17:51Z
 * write → 17:55Z I1 VIOLATION). Connected + fresh is unchanged; restore() stays exempt. #173: status().curve_in_force
 * .shaped is the shared four-field predicate (curveAlreadyInForce), not the old dbt−mbt>4 spread. Plain node:assert
 * under tsx like the other planner suites: npx tsx planner/src/writes.test.ts
 */
import assert from "node:assert/strict";
import { HbxWriter, WriteError, PI_STATE_FRESH_MS, piStateUnverifiable } from "./writes";
import type { HubState } from "./hub";

const nowS = () => Math.floor(Date.now() / 1000);

// ── 1. the pure verdict: the three refusal shapes and the one pass ───────────────────────────────────────────────
{
  const now = Date.now();
  assert.equal(piStateUnverifiable({ pi_connected: true, ts: nowS() - 20 }, now), null, "connected + 20 s old frame is live");
  assert.equal(piStateUnverifiable({ pi_connected: true, ts: nowS() - PI_STATE_FRESH_MS / 1000 + 5 }, now), null, "just inside the bound is live");
  const disc = piStateUnverifiable({ pi_connected: false, ts: nowS() - 134 }, now);
  assert.match(disc ?? "", /^Pi disconnected from the hub — cannot verify I1 \(last state 134 s ago\)$/, "disconnected names the age");
  const stale = piStateUnverifiable({ pi_connected: true, ts: nowS() - 11 * 60 }, now);
  assert.match(stale ?? "", /^Pi state at the hub is stale — cannot verify I1 \(last state 660 s ago, limit 600 s\)$/, "stale names the age and the bound");
  const none = piStateUnverifiable({ pi_connected: true, ts: null }, now);
  assert.match(none ?? "", /^no Pi state at the hub — cannot verify I1/, "a hub with no frame since it started is not evidence");
  assert.match(piStateUnverifiable({ pi_connected: false, ts: null }, now) ?? "", /^Pi disconnected/, "disconnected wins over no-frame");
  // units: the Pi sends time.time() seconds; a millisecond value is normalised, never read as far-future (fail-open)
  assert.equal(piStateUnverifiable({ pi_connected: true, ts: now - 20_000 }, now), null, "a ms frame 20 s old is live");
  assert.match(piStateUnverifiable({ pi_connected: true, ts: now - 11 * 60_000 }, now) ?? "", /stale/, "a ms frame 11 min old is stale");
  assert.equal(piStateUnverifiable({ pi_connected: true, ts: nowS() + 30 }, now), null, "a Pi clock slightly ahead is not stale (age clamps at 0)");
  assert.match(piStateUnverifiable({ pi_connected: true, ts: Number.NaN }, now) ?? "", /no Pi state/, "NaN is no frame");
  console.log("writes.test.ts (#167 piStateUnverifiable): all assertions passed");
}

// ── harness: a writer over fake SLX / store / hub ───────────────────────────────────────────────────────────────
type Audit = { source: string; action: string; result: string; detail?: string | null };
function harness(state: () => HubState, cfg: Record<string, number> = { dot: 10, wwsd: 65, dbt: 130, mbt: 126 }) {
  const audits: Audit[] = []; const patches: Array<Record<string, number>> = []; const notes: string[] = [];
  let live: Record<string, number> = { ...cfg };
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), tankF: 120, targetF: 128, outdoorF: 30 }),
    latestConfig: async () => ({ ...live }),
    baselineConfig: async () => ({ ...cfg }),
    insertHbxWrite: async (w: Audit) => { audits.push(w); },
    activeBoost: async () => null,
    insertConfigVersion: async () => {},
  } as any;
  const slx = { patchDevice: async (_b: string, _s: string, fields: Record<string, number>) => { patches.push(fields); live = { ...live, ...fields }; return { syncCode: "x", ...live, temps: { temp1: { actual: 120, target: 128 }, temp3: { actual: 30 } } }; } } as any;
  const hub = { getState: async () => state() } as any;
  const writer = new HbxWriter(slx, store, hub, "b", "s", async (t: string) => { notes.push(t); });
  return { writer, audits, patches, notes };
}
const pumps = (setpointC: number, online = true) => [
  { id: "pump1", name: "Pump 1", online, setpoint_c: setpointC },
  { id: "pump2", name: "Pump 2", online, setpoint_c: setpointC },
];
const CURVE = { dot: 10, wwsd: 65, dbt: 131, mbt: 126 }; // passes curveWriteGuard against the 130/126 baseline (dbt 131 ≤ 133 ceiling at 10 °F)

async function rejects(p: Promise<unknown>, status: number, re: RegExp): Promise<WriteError> {
  let err: unknown = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err instanceof WriteError, `expected a WriteError, got ${String(err)}`);
  assert.equal(err.status, status, `status ${err.status} ≠ ${status} (${err.message})`);
  assert.match(err.message, re);
  return err;
}

(async () => {
  // ── 2. connected + fresh: UNCHANGED — the write goes through (and an uncovered pump is still the 409) ─────────
  {
    const h = harness(() => ({ pi_connected: true, ts: nowS() - 15, pumps: pumps(60) }));
    const r = await h.writer.setTarget(128, "test");
    assert.equal(r.ok, true); assert.equal(h.patches.length, 1, "one PATCH");
    assert.equal(h.audits.at(-1)?.result, "accepted");
    const h2 = harness(() => ({ pi_connected: true, ts: nowS() - 15, pumps: pumps(52) })); // 125.6 °F < 128 + 5
    await rejects(h2.writer.setTarget(128, "test"), 409, /I1 conflict/);
    assert.equal(h2.patches.length, 0);
  }
  // ── 3. disconnected → 503, no PATCH, audited; the ledger key is the age-free `stable` form ─────────────────────
  {
    const h = harness(() => ({ pi_connected: false, ts: nowS() - 2 * 3600, pumps: pumps(60) })); // the Oct 17 shape: stale 140 °F setpoints that COVER the target
    const e = await rejects(h.writer.setTarget(128, "autopilot"), 503, /^Pi disconnected from the hub — cannot verify I1 \(last state 7200 s ago\)$/);
    assert.equal(e.stable, "Pi disconnected from the hub — cannot verify I1", "stable form drops the moving age");
    assert.equal(h.patches.length, 0, "NO PATCH against a Pi that is not there");
    assert.deepEqual(h.audits.map((a) => [a.action, a.result]), [["set_target", "rejected"]], "the refusal is audited");
    assert.match(h.audits[0].detail ?? "", /Pi disconnected/);
    const c = harness(() => ({ pi_connected: false, ts: nowS() - 2 * 3600, pumps: pumps(60) }));
    await rejects(c.writer.setCurve(CURVE, "autopilot"), 503, /^Pi disconnected from the hub — cannot verify I1/);
    assert.equal(c.patches.length, 0); assert.equal(c.audits[0].action, "set_curve"); assert.equal(c.audits[0].result, "rejected");
  }
  // ── 4. connected but STALE (the hub's frame is older than PI_STATE_FRESH_MS) → 503 on both paths ──────────────
  {
    const h = harness(() => ({ pi_connected: true, ts: nowS() - 15 * 60, pumps: pumps(60) }));
    const e = await rejects(h.writer.setTarget(128, "autopilot"), 503, /^Pi state at the hub is stale — cannot verify I1 \(last state 900 s ago, limit 600 s\)$/);
    assert.equal(e.stable, "Pi state at the hub is stale — cannot verify I1");
    assert.equal(h.patches.length, 0);
    const c = harness(() => ({ pi_connected: true, ts: nowS() - 15 * 60, pumps: pumps(60) }));
    await rejects(c.writer.setCurve(CURVE, "autopilot"), 503, /stale/);
    assert.equal(c.patches.length, 0);
    // a hub that has had no frame since it started (pumps [] would pass the online filter vacuously) is refused too
    const n = harness(() => ({ pi_connected: true, ts: null, pumps: [] }));
    await rejects(n.writer.setTarget(128, "autopilot"), 503, /no Pi state at the hub/);
    assert.equal(n.patches.length, 0);
  }
  // ── 5. restore() stays exempt: reverting to the as-found curve is never blocked by the Pi's absence ───────────
  {
    const h = harness(() => ({ pi_connected: false, ts: null, pumps: [] }));
    const r = await h.writer.restore("boost-expiry");
    assert.equal(r.ok, true); assert.equal(h.patches.length, 1); assert.deepEqual(h.patches[0], { dbt: 130, mbt: 126, dot: 10 });
  }
  // ── 6. an unreachable hub keeps today's shape (503, "hub unreachable") — the new refusal classifies beside it ──
  {
    const h = harness(() => { throw new Error("hub GET /api/state: HTTP 503"); });
    const e = await rejects(h.writer.setTarget(128, "autopilot"), 503, /^hub unreachable — cannot verify I1: hub GET \/api\/state: HTTP 503$/);
    assert.equal(e.stable, e.message, "no moving parts → stable is the message");
  }
  console.log("writes.test.ts (#167 I1 refusals): all assertions passed");

  // ── 7. #173: status().curve_in_force.shaped is the shared predicate, spread_f beside it ───────────────────────
  {
    // the live 2026-10-18 case: the floor-clamped plan curve 121/119 (spread 2) IS in force — /health said true,
    // the writer's old dbt−mbt>4 said false
    const h = harness(() => ({ pi_connected: true, ts: nowS(), pumps: pumps(60) }), { dot: 21, wwsd: 125, dbt: 121, mbt: 119 });
    let st = await h.writer.status();
    let cif = st.curve_in_force as { shaped: boolean; spread_f: number };
    assert.equal(cif.shaped, false, "no plan curve known yet → not 'the plan's curve in force' (as on /health)");
    assert.equal(cif.spread_f, 2, "spread_f stays visible beside it");
    h.writer.setPlanCurve({ dot: 21, wwsd: 125, dbt: 121, mbt: 119 });
    st = await h.writer.status(); cif = st.curve_in_force as { shaped: boolean; spread_f: number };
    assert.equal(cif.shaped, true, "the plan's 121/119 curve is the one in force — same answer as /health");
    h.writer.setPlanCurve({ dot: 21, wwsd: 110, dbt: 121, mbt: 119 });
    cif = (await h.writer.status()).curve_in_force as { shaped: boolean };
    assert.equal(cif.shaped, false, "wwsd drift is not 'in force' (the four-field predicate, #145)");
    h.writer.setPlanCurve(null);
    cif = (await h.writer.status()).curve_in_force as { shaped: boolean };
    assert.equal(cif.shaped, false, "a plan without a shaped curve → false");
    console.log("writes.test.ts (#173 shaped predicate): all assertions passed");
  }
})().catch((e) => { console.error(e); process.exit(1); });
