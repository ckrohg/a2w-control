/**
 * @purpose Assertions for the self-diagnosing foreign-curve alert (#177, drift.ts handlePolledConfig / curveVerdict).
 * Run with: npx tsx planner/src/drift.test.ts — exits non-zero on failure. Replays the two 2026-10-18 "FOREIGN HBX
 * CURVE WRITE" pages from their logged numbers and pins: echo verdict at 0/−1/−2 °F, foreign at −3, a re-read that
 * reverts → no page, a failed / shutdown-skipped re-read records nothing and pages nobody (the next poll re-checks),
 * the device lock ordering against a concurrent planner write, and the raw device object on every row.
 */
import assert from "node:assert/strict";
import {
  curveVerdict, handlePolledConfig, diffConfig, extractConfig, deviceMeta, patchEcho,
  ECHO_TITLE, FOREIGN_TITLE, UNCONFIRMED_TITLE, REREAD_DELAY_MS, ECHO_WINDOW_MS, pendingUnconfirmedNotice,
  type PlannerWrite, type ConfigVersionRecord, type DriftDeps, type HbxConfig,
} from "./drift";
import { withDeviceLock } from "./writes";

// A device object shaped like the as-found SensorLinx one (knowledge/reference/hbx-config-asfound-20260713.json):
// curve + a non-curve config field + live telemetry + the API's provenance fields.
const device = (dbt: number, mbt: number, extra: Record<string, unknown> = {}): Record<string, any> => ({
  syncCode: "SYNC", dot: 26, wwsd: 125, dbt, mbt, htDif: 4, dhwOn: false,
  temps: { temp1: { actual: 128.2, target: 128 } },
  changeSource: "server", updatedAt: "2026-10-18T21:01:07.000Z", connectedAt: "2026-10-18T02:00:00.000Z",
  ...extra,
});
const prevOf = (dev: Record<string, any>) => ({ config: extractConfig(dev), raw: dev });

const write = (at: string, action: string, requested: Record<string, number>): PlannerWrite =>
  ({ at, source: "autopilot", action, requested, echo: { ...requested, changeSource: "server" } });

interface Harness {
  deps: DriftDeps;
  rows: ConfigVersionRecord[];
  pages: { title: string; body: string; priority: string; email?: boolean }[];
  waits: number[];
}
function harness(o: {
  nowIso: string;
  reread?: Record<string, any> | Error;
  writes?: PlannerWrite[];
  waitOk?: boolean;
  latest?: { config: HbxConfig; raw: Record<string, any> | null } | null;
}): Harness {
  const rows: ConfigVersionRecord[] = [];
  const pages: Harness["pages"] = [];
  const waits: number[] = [];
  let t = Date.parse(o.nowIso);
  const writes = o.writes ?? [];
  const deps: DriftDeps = {
    now: () => t,
    wait: async (ms) => { waits.push(ms); if (o.waitOk === false) return false; t += ms; return true; },
    reread: async () => { if (o.reread instanceof Error) throw o.reread; return o.reread ?? {}; },
    plannerWrites: async (sinceMs) => ({
      last: writes.length ? [...writes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] : null,
      recent: writes.filter((w) => Date.parse(w.at) >= sinceMs),
    }),
    record: async (r) => { rows.push(r); },
    notify: async (title, body, priority, opts) => { pages.push({ title, body, priority, email: opts?.email }); },
    log: () => {},
    ...(o.latest !== undefined ? { latest: async () => o.latest! } : {}),
  };
  return { deps, rows, pages, waits };
}

async function main(): Promise<void> {
  // ── 1. Replay: 2026-10-18 21:05:56Z — 120/118 → 141/137, 1 °F under the 20:41Z soak band 142/138 ───────────────
  {
    const prev = prevOf(device(120, 118));
    const seen = device(141, 137, { updatedAt: "2026-10-18T21:05:40.000Z" });
    const writes = [
      write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 }),         // set 140°F — OVERDUE sanitize
      write("2026-10-18T21:01:07.000Z", "set_curve", { dot: 26, dbt: 120, mbt: 118, wwsd: 125 }), // DHW window floor
    ];
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: seen, writes });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.kind, "curve");
    assert.deepEqual(h.waits, [REREAD_DELAY_MS], "re-reads after ~30 s before paging");
    assert.equal(out.diagnosis?.verdict, "echo_suspected", "141/137 is within 1 °F of the planner's own 142/138");
    assert.equal(out.diagnosis?.reread_confirmed, true);
    assert.deepEqual(out.diagnosis?.matches.map((m) => [m.field, m.written, m.delta_f]), [["dbt", 142, -1], ["mbt", 138, -1]]);
    assert.equal(out.diagnosis?.planner_last_write?.action, "set_curve", "the planner's last write rides along");
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].title, ECHO_TITLE);
    assert.equal(h.pages[0].priority, "default", "an echo pages at default priority");
    assert.equal(h.pages[0].email, true, "the email carries the evidence");
    assert.doesNotMatch(h.pages[0].body, /single-writer/i, "an echo must not claim a single-writer violation");
    assert.match(h.pages[0].body, /dbt: 120 -> 141/);
    assert.match(h.pages[0].body, /planner wrote 142 at 2026-10-18T20:41:05\.000Z/);
    assert.match(h.pages[0].body, /updatedAt=2026-10-18T21:05:40\.000Z/, "device provenance after the change is in the page");
    // the row: both reads, raw whole, verdict + diagnosis beside it
    assert.equal(h.rows.length, 1);
    const r = h.rows[0];
    assert.equal(r.verdict, "echo_suspected");
    assert.deepEqual(r.raw, seen, "raw = the full device object, provenance fields included");
    assert.deepEqual(r.rereadRaw, seen);
    assert.deepEqual(r.changes, diffConfig(prev.config, extractConfig(seen)));
    assert.ok(!("_source" in (r.changes ?? {})), "a drift row never carries _source (that marks the planner's own write)");
  }

  // ── 2. Replay: 22:05:56Z — 120/118 → 129/125, 1 °F under the 21:36Z bank band 130/126 ──────────────────────────
  {
    const prev = prevOf(device(120, 118));
    const seen = device(129, 125);
    const writes = [
      write("2026-10-18T21:01:07.000Z", "set_curve", { dot: 26, dbt: 120, mbt: 118, wwsd: 125 }),
      write("2026-10-18T21:16:03.000Z", "set_curve", { dot: 26, dbt: 120, mbt: 118, wwsd: 125 }),
      write("2026-10-18T21:36:00.000Z", "set_target", { dbt: 130, mbt: 126 }),        // set 128°F — afternoon bank
      write("2026-10-18T22:01:06.000Z", "set_curve", { dot: 26, dbt: 120, mbt: 118, wwsd: 125 }),
    ];
    const h = harness({ nowIso: "2026-10-18T22:05:56.000Z", reread: seen, writes });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.diagnosis?.verdict, "echo_suspected");
    assert.deepEqual(out.diagnosis?.matches.map((m) => [m.field, m.written, m.delta_f]), [["dbt", 130, -1], ["mbt", 126, -1]]);
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].title, ECHO_TITLE);
    assert.equal(h.pages[0].priority, "default");
  }

  // ── 3. The tolerance edge: 0 / −1 / −2 °F → echo; −3 °F → foreign (today's high page) ─────────────────────────────
  for (const [delta, expected] of [[0, "echo_suspected"], [-1, "echo_suspected"], [-2, "echo_suspected"], [-3, "foreign"]] as const) {
    const prev = prevOf(device(120, 118));
    const seen = device(142 + delta, 138 + delta);
    const writes = [write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 })];
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: seen, writes });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.diagnosis?.verdict, expected, `Δ ${delta} °F → ${expected}`);
    assert.equal(h.pages.length, 1, `Δ ${delta}: one page`);
    if (expected === "foreign") {
      assert.equal(h.pages[0].title, FOREIGN_TITLE);
      assert.equal(h.pages[0].priority, "high", "a true foreign write keeps the high page");
      assert.match(h.pages[0].body, /single-writer invariant/i);
      assert.match(h.pages[0].body, /planner wrote 142 at .*Δ -3 °F/, "the foreign page carries the same evidence");
    } else {
      assert.equal(h.pages[0].priority, "default");
    }
  }
  // +2 °F (above what we wrote) is just as much an echo; +3 is not
  assert.equal(curveVerdict({ dbt: { old: 120, new: 144 } }, [write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 })], Date.parse("2026-10-18T21:05:56Z"))?.verdict, "echo_suspected");
  assert.equal(curveVerdict({ dbt: { old: 120, new: 145 } }, [write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 })], Date.parse("2026-10-18T21:05:56Z"))?.verdict, "foreign");

  // ── 4. EVERY changed curve field must match; one field off → foreign ────────────────────────────────────────────
  {
    const w = [write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 })];
    const at = Date.parse("2026-10-18T21:05:56Z");
    assert.equal(curveVerdict({ dbt: { old: 120, new: 141 }, mbt: { old: 118, new: 130 } }, w, at)?.verdict, "foreign", "mbt 130 is 8 °F off");
    // per field: dbt's value is NOT matched against a written mbt
    assert.equal(curveVerdict({ dbt: { old: 120, new: 138 } }, w, at)?.verdict, "foreign", "138 matches a written mbt, not a written dbt");
    // a non-numeric new value can never be an echo
    assert.equal(curveVerdict({ dbt: { old: 120, new: null } }, w, at)?.verdict, "foreign");
    // not a curve event at all
    assert.equal(curveVerdict({ htDif: { old: 4, new: 5 } }, w, at), null);
  }

  // ── 5. The 60-min window: a write 61 min earlier does not make an echo; a write AFTER the read does not either ────
  {
    const at = Date.parse("2026-10-18T21:05:56Z");
    const ch = { dbt: { old: 120, new: 141 }, mbt: { old: 118, new: 137 } };
    const old = [write(new Date(at - ECHO_WINDOW_MS - 60_000).toISOString(), "set_target", { dbt: 142, mbt: 138 })];
    assert.equal(curveVerdict(ch, old, at)?.verdict, "foreign");
    const later = [write(new Date(at + 60_000).toISOString(), "set_target", { dbt: 142, mbt: 138 })];
    assert.equal(curveVerdict(ch, later, at)?.verdict, "foreign");
    const edge = [write(new Date(at - ECHO_WINDOW_MS).toISOString(), "set_target", { dbt: 142, mbt: 138 })];
    assert.equal(curveVerdict(ch, edge, at)?.verdict, "echo_suspected", "exactly 60 min is inside");
  }

  // ── 6. A re-read that REVERTS → no page; both reads recorded; latestConfig stays the old curve ──────────────────
  {
    const prevDev = device(120, 118);
    const prev = prevOf(prevDev);
    const seen = device(141, 137);
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: prevDev, writes: [] });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(h.pages.length, 0, "a change that does not persist pages nobody");
    assert.equal(out.diagnosis?.verdict, "reverted");
    assert.equal(out.diagnosis?.reread_confirmed, false);
    assert.equal(out.diagnosis?.paged, null);
    assert.deepEqual(out.diagnosis?.fields, diffConfig(prev.config, extractConfig(seen)), "the transient change is kept in the diagnosis");
    assert.equal(h.rows.length, 1, "both reads are still recorded");
    assert.deepEqual(h.rows[0].raw, seen);
    assert.deepEqual(h.rows[0].rereadRaw, prevDev);
    assert.equal(h.rows[0].changes, null, "changed_fields NULL: the mirror badge + TempIQ closer never count a transient");
    assert.deepEqual(h.rows[0].config, prev.config, "the recorded config is the re-read — the old curve stays the latest");
    assert.deepEqual(out.config, prev.config, "the rest of the poll sees the re-read curve");
    assert.equal(out.changes, null);
  }

  // ── 7. Reverted curve, but a non-curve field changed for good → recorded + the ordinary drift notice, no curve page
  {
    const prev = prevOf(device(120, 118));
    const seen = device(141, 137, { htDif: 5 });
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: device(120, 118, { htDif: 5 }) });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.diagnosis?.verdict, "reverted");
    assert.deepEqual(h.rows[0].changes, { htDif: { old: 4, new: 5 } });
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].title, "HBX config changed (outside the planner)");
    assert.equal(h.pages[0].email, false);
  }

  // ── 8. Re-read FAILS → unconfirmed: nothing recorded, nobody paged; latestConfig stays, so the next poll re-checks
  {
    const prev = prevOf(device(120, 118));
    const seen = device(100, 96);
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("HTTP 503"), writes: [] });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.diagnosis?.verdict, "unconfirmed");
    assert.equal(out.diagnosis?.reread_confirmed, null);
    assert.match(out.diagnosis?.reread_error ?? "", /re-read failed: HTTP 503/);
    assert.equal(h.pages.length, 0, "a change not shown to persist pages nobody (#177: page only if it persists)");
    assert.equal(h.rows.length, 1, "an evidence row is kept (codex pass 3)…");
    assert.deepEqual(h.rows[0].config, prev.config, "…whose config is the UNCHANGED baseline — the baseline must not advance on one unconfirmed read");
    assert.equal(h.rows[0].changes, null, "changed_fields NULL: never a drift-chip hit or a TempIQ window closer");
    assert.equal(h.rows[0].verdict, "unconfirmed");
    assert.deepEqual(h.rows[0].raw, seen, "the first read is kept whole");
    assert.equal(out.changes, null);
    // nothing pending is announced while the change is still there: the next poll re-detects it and pages it itself
    assert.deepEqual(pendingUnconfirmedNotice(null, out), { pending: out.diagnosis, notice: null, resolved: false });
    // the next poll: same device, re-read works now → the full check runs and pages
    const h2 = harness({ nowIso: "2026-10-18T21:10:56.000Z", reread: seen, writes: [] });
    const out2 = await handlePolledConfig(prev, seen, h2.deps);
    assert.equal(out2.diagnosis?.verdict, "foreign");
    assert.equal(h2.pages.length, 1);
    assert.equal(h2.pages[0].priority, "high");
    assert.deepEqual(pendingUnconfirmedNotice(out.diagnosis, out2), { pending: null, notice: null, resolved: true }, "re-detected → its own page, no extra notice");
  }

  // ── 8b. Failed confirmation, then a planner write (boost expiry restore) replaces the curve before the next poll:
  // the observation is not lost — the next poll sends a default "could not be confirmed" notice (codex pass 3) ─────
  {
    const prev = prevOf(device(120, 118));
    const seen = device(100, 96);
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("HTTP 503"), latest: prev });
    const out1 = await handlePolledConfig(prev, seen, h.deps);
    let carry = pendingUnconfirmedNotice(null, out1);
    assert.equal(carry.pending?.verdict, "unconfirmed");
    // …same poll: boost expiry restores the as-found 165/140 and self-records it (the device now shows it)…
    const restored = prevOf(device(165, 140));
    // …next poll: the device and the latest version agree → no diff
    const h2 = harness({ nowIso: "2026-10-18T21:10:56.000Z" });
    const out2 = await handlePolledConfig(restored, device(165, 140), h2.deps);
    assert.equal(out2.kind, "unchanged");
    carry = pendingUnconfirmedNotice(carry.pending, out2);
    assert.equal(carry.pending, null);
    assert.equal(carry.notice?.title, UNCONFIRMED_TITLE);
    assert.match(carry.notice?.body ?? "", /dbt: 120 -> 100/, "the notice carries the evidence");
    assert.match(carry.notice?.body ?? "", /re-read failed: HTTP 503/);
    assert.doesNotMatch(carry.notice?.body ?? "", /single-writer/i);
    assert.equal(carry.resolved, true, "settled — index.ts persists that so a restart does not repeat it");
    assert.equal(pendingUnconfirmedNotice(null, out2).notice, null, "nothing pending → nothing to say");
    // after a RESTART the pending observation comes back from the DB (store.pendingUnconfirmed) — same outcome
    const reloaded = JSON.parse(JSON.stringify(out1.diagnosis));
    assert.equal(pendingUnconfirmedNotice(reloaded, out2).notice?.title, UNCONFIRMED_TITLE, "a reloaded pending observation is announced too");
    // a DIFFERENT change that reverts on the next poll must not swallow the pending one (codex pass 4)
    const h4 = harness({ nowIso: "2026-10-18T21:10:56.000Z", reread: device(165, 140) });
    const out4 = await handlePolledConfig(restored, device(141, 137), h4.deps);
    assert.equal(out4.diagnosis?.verdict, "reverted");
    const c4 = pendingUnconfirmedNotice(out1.diagnosis, out4);
    assert.equal(c4.notice?.title, UNCONFIRMED_TITLE, "reverted does not supersede — the notice goes out");
    assert.equal(c4.resolved, true);
    // a fresh unconfirmed one replaces it (still pending, nothing announced yet)
    const h5 = harness({ nowIso: "2026-10-18T21:10:56.000Z", reread: new Error("HTTP 503") });
    const out5 = await handlePolledConfig(restored, device(141, 137), h5.deps);
    assert.deepEqual(pendingUnconfirmedNotice(out1.diagnosis, out5), { pending: out5.diagnosis, notice: null, resolved: false });
    // a re-read failure while a planner write already moved the baseline: the evidence is STILL kept (codex pass 5),
    // on a row whose config is the NEW baseline — so it cannot undo our write, and a restart reloads it
    const h3 = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("HTTP 503"), latest: restored });
    const out3 = await handlePolledConfig(prev, seen, h3.deps);
    assert.equal(h3.rows.length, 1);
    assert.deepEqual(h3.rows[0].config, restored.config, "the evidence row carries the current baseline, never the stale one");
    assert.equal(h3.rows[0].changes, null);
    assert.equal(h3.rows[0].verdict, "unconfirmed");
    assert.deepEqual(h3.rows[0].raw, seen);
    assert.equal(out3.diagnosis?.baseline_moved, true);
    assert.equal(h3.rows[0].diagnosis, out3.diagnosis, "the persisted diagnosis is the pending one (what store.pendingUnconfirmed reloads)");
  }

  // ── 9. Shutdown during the wait → the re-read is skipped (never holds the poll past SIGTERM), nothing recorded ──
  {
    const prev = prevOf(device(120, 118));
    const seen = device(141, 137);
    let reread = 0;
    let looked = 0;
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", waitOk: false, writes: [write("2026-10-18T20:41:05.000Z", "set_target", { dbt: 142, mbt: 138 })] });
    h.deps.reread = async () => { reread++; return seen; };
    h.deps.lock = async (fn) => { looked++; return fn(); };
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(reread, 0, "no device read after shutdown began");
    assert.equal(looked, 0, "the device lock is never taken after shutdown began");
    assert.equal(out.diagnosis?.verdict, "unconfirmed");
    assert.match(out.diagnosis?.reread_error ?? "", /shutting down/);
    assert.equal(h.pages.length + h.rows.length, 0, "the successor's first poll re-detects it");
    assert.equal(out.diagnosis?.matches[0]?.written, 142, "the diagnosis still names the nearest planner write");
  }

  // ── 9a. `unsettled` marks exactly the outcomes with no durable evidence: index.ts fails the poll on it so no
  // controller supersedes the observation (codex pass 6) ──────────────────────────────────────────────────────────
  {
    const prev = prevOf(device(120, 118));
    const seen = device(141, 137);
    // re-read OK, but the latest-version lookup fails → nothing recorded → unsettled
    let h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: seen });
    h.deps.latest = async () => { throw new Error("query timeout"); };
    let out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.diagnosis?.verdict, "unconfirmed");
    assert.equal(h.rows.length, 0, "no baseline known → never write a row that might be stale");
    assert.equal(out.unsettled, true, "→ index.ts skips this poll's actuation");
    // re-read failed but the evidence row landed → settled enough: controllers may run
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("HTTP 503"), latest: prev });
    out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(h.rows.length, 1);
    assert.equal(out.unsettled, false);
    // re-read failed AND the evidence row could not be written → unsettled
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("HTTP 503"), latest: prev });
    h.deps.record = async () => { throw new Error("db down"); };
    out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.unsettled, true);
    // shutdown: unsettled too (index.ts ignores it while shutting down — the write barrier is already up)
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", waitOk: false });
    out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(out.unsettled, true);
    // confirmed / reverted / no-change outcomes are never unsettled
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: seen });
    assert.ok(!(await handlePolledConfig(prev, seen, h.deps)).unsettled);
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: device(120, 118) });
    assert.ok(!(await handlePolledConfig(prev, seen, h.deps)).unsettled);
  }

  // ── 9b. A re-read abandoned mid-request (index.ts abandonOnShutdown rejects) is unconfirmed too ─────────────────
  {
    const prev = prevOf(device(120, 118));
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: new Error("planner shutting down") });
    const out = await handlePolledConfig(prev, device(141, 137), h.deps);
    assert.equal(out.diagnosis?.verdict, "unconfirmed");
    assert.equal(h.pages.length + h.rows.length, 0);
  }

  // ── 10. A planner write that lands DURING the wait (dashboard boost) is the new baseline — not a curve change ────
  {
    const prev = prevOf(device(120, 118));
    const seen = device(141, 137);          // first read: the echo-shaped change
    const ours = device(134, 130);          // the dashboard boost self-recorded 134/130 during the 30 s
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z", reread: ours, latest: prevOf(ours), writes: [] });
    const out = await handlePolledConfig(prev, seen, h.deps);
    assert.equal(h.pages.length, 0, "our own write during the wait is never paged");
    assert.equal(out.diagnosis?.verdict, "reverted");
    assert.equal(out.diagnosis?.baseline_moved, true);
    assert.equal(h.rows[0].changes, null);
  }

  // ── 10b. The device lock serialises a planner write that starts DURING the re-read: it runs after the detector's
  // record, so the detector never judges a re-read against a baseline from a later moment (codex pass 1) ──────────
  {
    const order: string[] = [];
    let deviceNow = device(141, 137);
    let latestNow = prevOf(device(120, 118));
    const h = harness({ nowIso: "2026-10-18T21:05:56.000Z" });
    let writer: Promise<void> | null = null;
    h.deps.lock = withDeviceLock;
    h.deps.latest = async () => latestNow;
    h.deps.reread = async () => {
      const seen = deviceNow;
      // a dashboard boost arrives while the confirmation GET is on the wire
      writer = withDeviceLock(async () => { order.push("writer"); deviceNow = device(134, 130); latestNow = prevOf(deviceNow); });
      await new Promise((r) => setTimeout(r, 5));
      return seen;
    };
    const rec = h.deps.record;
    h.deps.record = async (r) => { order.push("detector"); await rec(r); };
    const out = await handlePolledConfig(latestNow, deviceNow, h.deps);
    await writer;
    assert.deepEqual(order, ["detector", "writer"], "the planner write waits for the detector's re-read → record");
    assert.deepEqual(h.rows[0].changes, diffConfig(extractConfig(device(120, 118)), extractConfig(device(141, 137))),
      "judged against the baseline of the re-read's own moment");
    assert.equal(out.diagnosis?.baseline_moved, false);
  }

  // ── 10c. Seed / non-curve drift re-check the baseline under the lock: a planner write that self-recorded since the
  // poll read `prev` wins — the stale observation is not recorded and not notified (codex pass 2) ────────────────
  {
    const prev = prevOf(device(120, 118));
    const ours = prevOf(device(134, 130));
    let h = harness({ nowIso: "2026-10-18T21:05:56.000Z", latest: ours });
    let out = await handlePolledConfig(prev, device(120, 118, { htDif: 6 }), h.deps);
    assert.equal(h.rows.length + h.pages.length, 0, "a stale non-curve observation never overwrites our newer version");
    assert.equal(out.changes, null);
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", latest: prev });
    out = await handlePolledConfig(prev, device(120, 118, { htDif: 6 }), h.deps);
    assert.equal(h.rows.length, 1, "unmoved baseline → recorded as before");
    assert.equal(out.kind, "config_drift");
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z", latest: ours });
    out = await handlePolledConfig(null, device(120, 118), h.deps);
    assert.equal(h.rows.length, 0, "no seed over a version that appeared meanwhile");
    // and both take the lock
    let locks = 0;
    h = harness({ nowIso: "2026-10-18T21:05:56.000Z" });
    h.deps.lock = async (fn) => { locks++; return fn(); };
    await handlePolledConfig(null, device(120, 118), h.deps);
    await handlePolledConfig(prev, device(120, 118, { htDif: 6 }), h.deps);
    assert.equal(locks, 2, "seed and non-curve records run under the device lock");
  }

  // ── 10d. Moved baseline + a 1 °F transform of the write made DURING the wait → echo, not a high foreign page:
  // the echo window ends at the re-read (codex pass 2) ──────────────────────────────────────────────────────────
  {
    const prev = prevOf(device(120, 118));
    const ours = device(134, 130);                                    // dashboard write at 21:06:06, inside the 30 s
    const h = harness({
      nowIso: "2026-10-18T21:05:56.000Z", reread: device(133, 129), latest: prevOf(ours),
      writes: [write("2026-10-18T21:06:06.000Z", "set_target", { dbt: 134, mbt: 130 })],
    });
    const out = await handlePolledConfig(prev, device(141, 137), h.deps);
    assert.equal(out.diagnosis?.baseline_moved, true);
    assert.equal(out.diagnosis?.verdict, "echo_suspected", "our own write made during the wait counts");
    assert.deepEqual(h.rows[0].changes, diffConfig(extractConfig(ours), extractConfig(device(133, 129))), "judged against the moved baseline");
    assert.equal(h.pages[0].priority, "default");
  }

  // ── 11. Seed, unchanged, and non-curve drift keep today's behaviour — and every row carries raw ─────────────────
  {
    const dev = device(120, 118);
    let h = harness({ nowIso: "2026-10-18T21:05:56.000Z" });
    let out = await handlePolledConfig(null, dev, h.deps);
    assert.equal(out.kind, "seeded");
    assert.deepEqual(h.rows[0], { config: extractConfig(dev), changes: null, raw: dev });
    assert.equal(h.waits.length, 0);

    h = harness({ nowIso: "2026-10-18T21:05:56.000Z" });
    out = await handlePolledConfig(prevOf(dev), device(120, 118, { temps: { temp1: { actual: 130, target: 128 } } }), h.deps);
    assert.equal(out.kind, "unchanged", "live telemetry moving is not drift");
    assert.equal(h.rows.length + h.pages.length + h.waits.length, 0);

    h = harness({ nowIso: "2026-10-18T21:05:56.000Z" });
    out = await handlePolledConfig(prevOf(dev), device(120, 118, { htDif: 6 }), h.deps);
    assert.equal(out.kind, "config_drift");
    assert.equal(h.waits.length, 0, "only a dbt/mbt diff waits for a re-read");
    assert.deepEqual(h.rows[0].raw, device(120, 118, { htDif: 6 }));
    assert.equal(h.pages[0].priority, "high");
    assert.equal(h.pages[0].email, false);
  }

  // ── 12. Provenance helpers ──────────────────────────────────────────────────────────────────────────────────────
  {
    const dev = device(120, 118);
    assert.deepEqual(deviceMeta(dev), { changeSource: "server", updatedAt: "2026-10-18T21:01:07.000Z", connectedAt: "2026-10-18T02:00:00.000Z" });
    assert.deepEqual(deviceMeta(null), {});
    assert.deepEqual(patchEcho(dev, { dbt: 120, mbt: 118 }),
      { dbt: 120, mbt: 118, dot: 26, wwsd: 125, changeSource: "server", updatedAt: "2026-10-18T21:01:07.000Z", connectedAt: "2026-10-18T02:00:00.000Z" });
  }
}

main().then(
  () => console.log("drift.test.ts: all assertions passed"),
  (e) => { console.error(e); process.exit(1); },
);
