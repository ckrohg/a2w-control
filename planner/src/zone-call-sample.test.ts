/**
 * @purpose Assertions for DemandFeed.callSample (demand.ts): the one zone_call_samples row each refresh
 * leaves behind. Pins the three provenance states — "calls" when /calls answered on this refresh,
 * "cached" when it failed but the previous answer is still inside the health window (ids = that
 * previous answer), "stale" when no healthy answer exists (ids null, the all-zones posture) — and
 * that nZones is the payload's zone count, not the calling count. The TempIQ seam is a stubbed
 * global fetch. Run with: npx tsx planner/src/zone-call-sample.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { DemandFeed } from "./demand";

const json = (body: unknown, status = 200) =>
  ({ status, json: async () => body }) as unknown as Response;

(async () => {
  const real = globalThis.fetch;
  let callsOk = true;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/api/insights/zones")) return json({ zones: [] });
    if (u.endsWith("/api/insights/calls")) {
      if (!callsOk) return json({ error: "boom" }, 503);
      return json([
        { zoneId: "z-lr", hvacStatus: "HEATING" },
        { zoneId: "z-mb", hvacStatus: "OFF" },
        { zoneId: "z-din", hvacStatus: null },
      ]);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof globalThis.fetch;

  try {
    const feed = new DemandFeed("http://tempiq.test", "tok");

    // 1. Before any refresh: nothing fetched, nothing healthy → "stale", ids null, zero zones.
    assert.deepEqual(feed.callSample(), { callingZoneIds: null, nZones: 0, source: "stale" });

    // 2. A refresh where /calls answers: fresh ids, the payload's 3 zones (1 calling), "calls".
    await feed.refresh();
    assert.deepEqual(feed.callSample(), { callingZoneIds: ["z-lr"], nZones: 3, source: "calls" });

    // 3. The next refresh fails on /calls only: the previous answer is still inside the 30-min
    //    health window, so the ids are carried but the row says so — "cached", never "calls".
    callsOk = false;
    await feed.refresh();
    assert.deepEqual(feed.callSample(), { callingZoneIds: ["z-lr"], nZones: 3, source: "cached" });

    // 4. /calls recovers: back to "calls" on the very next refresh.
    callsOk = true;
    await feed.refresh();
    assert.equal(feed.callSample().source, "calls");

    // 5. A payload with zones but nobody calling is an EMPTY set from a healthy feed — not null,
    //    and nZones still says how many zones the empty set was derived from.
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/api/insights/calls")
        ? json([{ zoneId: "z-lr", hvacStatus: "OFF" }, { zoneId: "z-mb", hvacStatus: "OFF" }])
        : json({ zones: [] })) as typeof globalThis.fetch;
    await feed.refresh();
    assert.deepEqual(feed.callSample(), { callingZoneIds: [], nZones: 2, source: "calls" });
  } finally {
    globalThis.fetch = real;
  }
  console.log("zone-call-sample.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
