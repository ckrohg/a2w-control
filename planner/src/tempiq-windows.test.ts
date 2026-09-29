/**
 * @purpose a2w#137: assertions for the TempIQ perturbation-window poster. a2w-control has no JS test
 * runner (CI is tsc build + the planner assertion loop), so run with: npx tsx planner/src/tempiq-windows.test.ts
 * — exits non-zero on failure. The load-bearing parts are the episode rules (what opens, what closes,
 * what is never claimed exogenous) and the fail-soft posting contract, so those are pinned here.
 */
import assert from "node:assert/strict";
import {
  buildPayload, callingZoneIds, classifyKind, externalIdFor, parseCommandedTargetF,
  TempiqWindowPoster, WINDOW_SOURCE,
  type PendingCurveWrite, type WindowPost, type WindowStats, type WindowStore,
} from "./tempiq-windows";

// The planner compiles as CJS (tsconfig module node16, no "type": "module"), so tsx refuses
// top-level await here — everything runs inside main().
async function main(): Promise<void> {
// ── parseCommandedTargetF ─────────────────────────────────────────────────────────────────────────
{
  // The accepted detail names the target exactly; the curve midpoint is only ±2 °F, so detail wins.
  assert.equal(parseCommandedTargetF("target 128°F commanded (curve 131/127 → 128°F output at 41°F outdoor; adopts on the next reheat cycle)", { dbt: 131, mbt: 127 }), 128);
  // No detail → curve midpoint (rounded).
  assert.equal(parseCommandedTargetF(null, { dbt: 131, mbt: 128 }), 130);
  // A rejected write's {target_f} shape is honoured.
  assert.equal(parseCommandedTargetF("target 150°F outside the I4 envelope [118–135]°F at 55°F outdoor", { target_f: 150 }), 150);
  // Restore detail + baseline endpoints → midpoint of the as-found curve (informational only).
  assert.equal(parseCommandedTargetF("as-found curve restored (165/140°F)", { dbt: 165, mbt: 140 }), 153);
  assert.equal(parseCommandedTargetF(null, null), null);
  assert.equal(parseCommandedTargetF(null, { dbt: "131", mbt: 127 }), null);
}

// ── classifyKind: the plan reason names what the learner must treat differently ───────────────────
{
  const ap = (reason: string | null, commandedTargetF: number | null = 128) =>
    classifyKind({ source: "autopilot", reason, stormActive: false, boostMatched: false, commandedTargetF });
  assert.equal(ap("daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)"), "sanitize");
  assert.equal(ap("OVERDUE sanitize to 140°F = 60°C (I8 window lapsed — earliest hour, not the warmest)"), "sanitize");
  // "storm mode: banking heat" names both — the storm is the cause, so storm wins over bank.
  assert.equal(ap("storm mode: banking heat (extreme-cold)"), "storm");
  assert.equal(ap("afternoon bank to 128°F (warmest hour, 71°F outdoor)"), "bank");
  assert.equal(ap("DP: bank to 130°F at 28°F outdoor (min ahead 14°F)"), "bank");
  assert.equal(ap("pre-charge for 06:00 window (warmest lead hour, 62°F)"), "bank");
  assert.equal(ap("binding zone: Living Room Baseboard needs 124°F (winter solver shadow)"), "autopilot");
  assert.equal(ap("DHW window floor"), "autopilot");
  assert.equal(ap("DP: hold floor 120°F"), "autopilot");
  // No correlated log row: only the soak sits above strictCap, so the target alone separates it.
  assert.equal(ap(null, 140), "sanitize");
  assert.equal(ap(null, 128), "autopilot");
  // A reason IS present and says nothing about sanitize → not sanitize even above the cap (the reason
  // is the record; the target heuristic is only the fallback for a missing one).
  assert.equal(ap("DP: bank to 138°F at 10°F outdoor (min ahead 2°F)", 138), "bank");

  const dash = (stormActive: boolean, boostMatched: boolean) =>
    classifyKind({ source: "dashboard", reason: null, stormActive, boostMatched, commandedTargetF: 130 });
  // The storm-precharge cron arms FIRST, then boosts — the armed window is the label.
  assert.equal(dash(true, true), "storm");
  assert.equal(dash(false, true), "boost");
  assert.equal(dash(false, false), "manual");
  // Any other non-autopilot source (a future script) falls into the same human/cron rules.
  assert.equal(classifyKind({ source: "cron", reason: null, stormActive: false, boostMatched: false, commandedTargetF: 130 }), "manual");
}

// ── callingZoneIds: calling AND buffer-served, from the floor snapshot's zones jsonb ──────────────
{
  const zones = [
    { zoneId: "z-lr", name: "Living Room Baseboard", calling: true, awtF: 124 },
    { zoneId: "z-kit", name: "Kitchen Radiant", calling: false, awtF: 110 },   // not calling
    { zoneId: "z-ms", name: "Office Mini-Split", calling: true, awtF: null },   // not buffer-served
    { zoneId: "", calling: true, awtF: 120 },                                    // no id
    null, 42,
  ];
  assert.deepEqual(callingZoneIds(zones), ["z-lr"]);
  assert.deepEqual(callingZoneIds(null), []);
  assert.deepEqual(callingZoneIds({ not: "an array" }), []);
}

// ── buildPayload: quarantine-only, range-guarded, open vs closed ──────────────────────────────────
{
  const stats: WindowStats = { achievedAwtF: 126.44, compliance: 0.9137, outdoorLowF: 41.24, outdoorHighF: 55.01, samples: 120 };
  const open = buildPayload({ id: 7, ts: new Date("2026-09-29T12:00:00Z"), closedAt: null }, "autopilot", 128, stats, ["z-lr"]);
  assert.equal(open.externalId, externalIdFor(7));
  assert.equal(open.externalId, "a2w-hbx-write-7");
  assert.equal(open.assignment, null, "a2w never claims an assignment — commanded is not exogenous");
  assert.equal(open.endedAt, null, "open window = active until now");
  assert.equal(open.startedAt, "2026-09-29T12:00:00.000Z");
  assert.equal(open.kind, "autopilot");
  assert.equal(open.source, WINDOW_SOURCE);
  assert.equal(open.washoutMin, 30);
  assert.deepEqual(open.zoneIds, ["z-lr"]);
  assert.equal(open.commandedTargetF, 128);
  assert.equal(open.achievedAwtF, 126.4);
  assert.equal(open.compliance, 0.914);
  assert.equal(open.outdoorBandLowF, 41.2);
  assert.equal(open.outdoorBandHighF, 55);

  const closed = buildPayload({ id: 8, ts: new Date("2026-09-29T12:00:00Z"), closedAt: new Date("2026-09-29T14:30:00Z") }, "sanitize", 140, stats, []);
  assert.equal(closed.endedAt, "2026-09-29T14:30:00.000Z");
  assert.equal(closed.kind, "sanitize");

  // An out-of-range stat would 400 the WHOLE batch on TempIQ's side, so it is dropped, not sent.
  const bad: WindowStats = { achievedAwtF: 0, compliance: 1.2, outdoorLowF: -80, outdoorHighF: NaN, samples: 3 };
  const guarded = buildPayload({ id: 9, ts: new Date(), closedAt: null }, "manual", 250, bad, []);
  assert.equal(guarded.commandedTargetF, undefined);
  assert.equal(guarded.achievedAwtF, undefined);
  assert.equal(guarded.compliance, undefined);
  assert.equal(guarded.outdoorBandLowF, undefined);
  assert.equal(guarded.outdoorBandHighF, undefined);
  // Nulls (no samples yet) are simply absent.
  const empty = buildPayload({ id: 10, ts: new Date(), closedAt: null }, "manual", null,
    { achievedAwtF: null, compliance: null, outdoorLowF: null, outdoorHighF: null, samples: 0 }, []);
  assert.equal("achievedAwtF" in empty, false);
  assert.equal("commandedTargetF" in empty, false);
}

// ── The poster tick against a fake store + fake fetch ─────────────────────────────────────────────
type Call = { url: string; body: any };
function fakeStore(pending: PendingCurveWrite[][]) {
  const marks: WindowPost[][] = [];
  const store: WindowStore = {
    async pendingCurveWrites() { return pending.shift() ?? []; },
    async windowStats(_from, _to, commanded) {
      return { achievedAwtF: 125, compliance: commanded == null ? null : 0.8, outdoorLowF: 40, outdoorHighF: 50, samples: 10 };
    },
    async zoneFloorSnapshotNear() { return [{ zoneId: "z-lr", calling: true, awtF: 124 }]; },
    async markWindowPosts(p) { marks.push(p); },
  };
  return { store, marks };
}
function fakeFetch(responses: Array<{ status: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const r = responses.shift();
    if (!r) throw new Error("fetch failed: ECONNRESET");
    return { status: r.status, ok: r.status < 300, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}
const T0 = new Date("2026-09-29T12:00:00Z");
const write = (over: Partial<PendingCurveWrite>): PendingCurveWrite => ({
  id: 1, ts: T0, source: "autopilot", action: "set_target", requested: { dbt: 130, mbt: 126 },
  detail: "target 128°F commanded (curve 130/126 → 128°F output at 45°F outdoor; adopts on the next reheat cycle)",
  commandedTargetF: 128, closedAt: null, reason: "DHW window floor", stormActive: false, boostMatched: false, ...over,
});

// 1. Open autopilot window + a restore in one batch: the window is posted OPEN with assignment null;
//    the restore is marked closed locally and NEVER posted (it opens nothing).
await (async () => {
  const { store, marks } = fakeStore([[
    write({ id: 1 }),
    write({ id: 2, ts: new Date("2026-09-29T13:00:00Z"), action: "restore", source: "boost-expiry", detail: "as-found curve restored (165/140°F)", requested: { dbt: 165, mbt: 140 }, commandedTargetF: null }),
  ]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch([{ status: 200, body: { upserted: 1, rejected: [] } }], calls));
  await poster.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://tempiq.test/api/insights/experiment-windows");
  assert.equal(calls[0].body.windows.length, 1, "the restore is not a window");
  const w = calls[0].body.windows[0];
  assert.equal(w.externalId, "a2w-hbx-write-1");
  assert.equal(w.kind, "autopilot");
  assert.equal(w.endedAt, null);
  assert.equal(w.assignment, null);
  assert.deepEqual(w.zoneIds, ["z-lr"]);
  assert.equal(w.compliance, 0.8);
  assert.equal(marks.length, 1);
  const byId = new Map(marks[0].map((m) => [m.writeId, m]));
  assert.equal(byId.get(1)!.closedAt, null, "posted open → stays pending until a closer appears");
  assert.equal(byId.get(2)!.kind, "restore");
  assert.equal(byId.get(2)!.closedAt?.toISOString(), "2026-09-29T13:00:00.000Z");
  assert.equal(byId.get(2)!.lastError, null);
  const st = poster.status();
  assert.equal(st.openedTotal, 1);
  assert.equal(st.closedTotal, 0);
  assert.equal(st.consecutiveFailures, 0);
  assert.match(st.lastResult ?? "", /opened 1, closed 0, rejected 0, restores 1/);
})();

// 1b. An identification write (any 'identification…' source — the driver's per-window tokens) is never a
//     quarantine window: marked, not posted; it still closes the previous episode.
await (async () => {
  const { store, marks } = fakeStore([[
    write({ id: 1, closedAt: new Date("2026-09-29T12:30:00Z") }),
    write({ id: 2, ts: new Date("2026-09-29T12:30:00Z"), source: "identification#4", detail: "target 143°F commanded (curve 145/141 → 143°F output at 20°F outdoor; adopts on the next reheat cycle)", commandedTargetF: 143, closedAt: new Date("2026-09-29T14:30:00Z") }),
    write({ id: 3, ts: new Date("2026-09-29T14:30:00Z"), source: "identification-end#4", commandedTargetF: 135, closedAt: null }),
  ]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch([{ status: 200, body: { upserted: 1, rejected: [] } }], calls));
  await poster.tick();
  assert.equal(calls[0].body.windows.length, 1, "only the autopilot episode is a quarantine window");
  assert.equal(calls[0].body.windows[0].externalId, "a2w-hbx-write-1");
  const byId = new Map(marks[0].map((m) => [m.writeId, m]));
  assert.equal(byId.get(2)!.kind, "identification");
  assert.equal(byId.get(3)!.kind, "identification");
})();

// 2. A closed window (the closer exists) is posted with endedAt and marked closed.
await (async () => {
  const { store, marks } = fakeStore([[write({ id: 1, closedAt: new Date("2026-09-29T13:00:00Z") })]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch([{ status: 200, body: { upserted: 1, rejected: [] } }], calls));
  await poster.tick();
  assert.equal(calls[0].body.windows[0].endedAt, "2026-09-29T13:00:00.000Z");
  assert.equal(marks[0][0].closedAt?.toISOString(), "2026-09-29T13:00:00.000Z");
  assert.equal(poster.status().closedTotal, 1);
})();

// 3. A per-window rejection is recorded closed-with-error and NOT retried (deterministic), while the
//    valid sibling is marked normally.
await (async () => {
  const { store, marks } = fakeStore([[write({ id: 1 }), write({ id: 2, ts: new Date("2026-09-29T12:30:00Z") })]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok",
    fakeFetch([{ status: 200, body: { upserted: 1, rejected: [{ externalId: "a2w-hbx-write-1", reason: "ended_before_started" }] } }], calls));
  const origError = console.error; const errs: string[] = []; console.error = (m: any) => { errs.push(String(m)); };
  try { await poster.tick(); } finally { console.error = origError; }
  const byId = new Map(marks[0].map((m) => [m.writeId, m]));
  assert.equal(byId.get(1)!.lastError, "ended_before_started");
  assert.ok(byId.get(1)!.closedAt instanceof Date, "rejected → leaves the pending set");
  assert.equal(byId.get(2)!.lastError, null);
  assert.equal(byId.get(2)!.closedAt, null);
  assert.equal(poster.status().rejectedTotal, 1);
  assert.equal(poster.status().openedTotal, 1);
  assert.ok(errs.some((e) => e.includes("a2w-hbx-write-1 rejected by TempIQ: ended_before_started")), "loud");
})();

// 4. A 400 WITH a rejected list (every window refused) is still a per-window verdict, not a transport error.
await (async () => {
  const { store, marks } = fakeStore([[write({ id: 1 })]]);
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok",
    fakeFetch([{ status: 400, body: { upserted: 0, rejected: [{ externalId: "a2w-hbx-write-1", reason: "identification_requires_assignment" }] } }], []));
  const origError = console.error; console.error = () => {};
  try { await poster.tick(); } finally { console.error = origError; }
  assert.equal(marks[0][0].lastError, "identification_requires_assignment");
  assert.equal(poster.status().consecutiveFailures, 0);
})();

// 5. Transport / contract failures (5xx, 401, a 400 with no list, a thrown fetch) mark NOTHING and count
//    a streak — the next tick retries the same writes, so no window is lost.
for (const resp of [
  [{ status: 500, body: { error: "boom" } }],
  [{ status: 401, body: { error: "invalid token" } }],
  [{ status: 400, body: { error: "malformed" } }],
  [] as Array<{ status: number; body: unknown }>, // fetch throws
]) {
  const { store, marks } = fakeStore([[write({ id: 1 })]]);
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch(resp, []));
  const origError = console.error; console.error = () => {};
  try { await poster.tick(); } finally { console.error = origError; }
  assert.equal(marks.length, 0, `nothing marked on ${JSON.stringify(resp[0]?.status ?? "throw")}`);
  assert.equal(poster.status().consecutiveFailures, 1);
  assert.match(poster.status().lastResult ?? "", /^error: /);
}

// 6. An empty pending set is an idle tick (no fetch), and a batch smaller than the ceiling ends the loop.
await (async () => {
  const { store } = fakeStore([[]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch([], calls));
  await poster.tick();
  assert.equal(calls.length, 0);
  assert.equal(poster.status().lastResult, "idle: nothing to post");
})();

// 7. Kinds flow from the correlates: a dashboard boost inside an armed storm is a storm window; a
//    dashboard set with nothing correlated is manual.
await (async () => {
  const { store } = fakeStore([[
    write({ id: 1, source: "dashboard", reason: null, stormActive: true, boostMatched: true }),
    write({ id: 2, ts: new Date("2026-09-29T12:20:00Z"), source: "dashboard", reason: null }),
    write({ id: 3, ts: new Date("2026-09-29T12:40:00Z"), reason: null, commandedTargetF: 140, detail: "target 140°F commanded (curve 142/138 → 140°F output at 70°F outdoor; adopts on the next reheat cycle)" }),
  ]]);
  const calls: Call[] = [];
  const poster = new TempiqWindowPoster(store, "https://tempiq.test", "tok", fakeFetch([{ status: 200, body: { upserted: 3, rejected: [] } }], calls));
  await poster.tick();
  const kinds = calls[0].body.windows.map((w: any) => w.kind);
  assert.deepEqual(kinds, ["storm", "manual", "sanitize"]);
  assert.equal(calls[0].body.windows[2].commandedTargetF, 140);
})();

console.log("tempiq-windows.test.ts: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

// #135: the pre-boost is filed as a bank — a deliberate DHW charge the learner must quarantine as such.
(() => {
  const k = classifyKind({ source: "autopilot", reason: "pre-boost to 126°F for 17:00 window (sag p75 6.2°F over 11 draws; warmest lead hour, 44°F)", stormActive: false, boostMatched: false, commandedTargetF: 126 });
  assert.equal(k, "bank");
  console.log("tempiq-windows.test.ts (#135 pre-boost kind): all assertions passed");
})();
