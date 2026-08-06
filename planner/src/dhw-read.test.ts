/**
 * @purpose Seam assertions for the DHW per-draw event reader (gtm#1442). a2w-control has no JS test
 * runner (CI is tsc build + bridge pytest), so run locally with: npx tsx planner/src/dhw-read.test.ts
 * — it exits non-zero on failure.
 *
 * The pure gap math is pinned in hygiene.test.ts; this covers what that can't reach — the
 * fetch/parse/persist path — by serving a trimmed copy of the REAL /api/insights/dhw-usage response
 * from a local stub. The hazard it exists to catch: TempIQ names the ELECTRICAL field `energyKwh` and
 * the thermal one `thermalKwh`, which are easy to map backwards into our (thermal_kwh, electrical_kwh)
 * columns — a swap that typechecks fine and silently corrupts the history.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { TempiqReader } from "./tempiq-read";
import { drawGapStats } from "./hygiene";

// Trimmed from the live 6BB response, 2026-08-06. Newest-first, as TempIQ returns it.
const PAYLOAD = {
  propertyId: "test",
  units: { energyKwh: "kWh" },
  available: true,
  dhwVsSpaceApplied: true,
  estimate: { source: "recharge", dailyElectricalKwh: 0.8393, thermalKwh: 34.31, hydronicCop: 2.92, cycleCount: 13, stale: false },
  rolling: { window24hKwh: 0.8393, window72hKwh: 2.518, basis: "daily_rate_projection" },
  events: [
    { at: "2026-08-05T12:47:46.289Z", energyKwh: 2.1771, thermalKwh: 6.3577 },
    { at: "2026-08-04T13:24:47.160Z", energyKwh: 0.8349, thermalKwh: 2.438 },
    { at: "2026-08-01T12:04:02.901Z", energyKwh: 1.8971, thermalKwh: 5.54 },
    { at: "2026-07-29T14:23:27.129Z", energyKwh: 0.1494, thermalKwh: 0.4363 },
  ],
};

type Captured = { at: Date; thermalKwh: number | null; electricalKwh: number | null };

function makeStore(captured: Captured[], snap: { body: any }) {
  return {
    upsertTempiqDhwUsage: async (p: unknown) => { snap.body = p; },
    insertTempiqDhwEvents: async (evs: Captured[]) => {
      const fresh = evs.filter((e) => !captured.some((c) => c.at.getTime() === e.at.getTime()));
      captured.push(...fresh);
      return fresh.length;
    },
    dhwDrawStats: async () =>
      drawGapStats([...captured].sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => e.at), Date.now()),
  } as any;
}

/** Serve `body` on /api/insights/dhw-usage; 404 everything else (the other endpoints fail soft). */
async function withStub(body: unknown, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    const ok = req.url?.startsWith("/api/insights/dhw-usage");
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? body : { error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as any).port}`);
  } finally {
    server.close();
  }
}

async function main() {
  // 1. Every event persists, with the field mapping the right way round.
  {
    const captured: Captured[] = [];
    const snap = { body: null as any };
    await withStub(PAYLOAD, async (base) => {
      const reader = new TempiqReader(makeStore(captured, snap), base, "test-token");
      await reader.tick();
      const draws = reader.status().dhwDraws;
      assert.ok(draws, "draw stats surfaced on status()");
      assert.equal(draws!.eventCount, 4, "all 4 events counted");
      // 08-01T12:04 → 08-04T13:24 = 73.35 h. NB this gap is an artifact of trimming the fixture (the
      // real record has draws on 08-03 inside it) — it pins the plumbing, not the house's behavior.
      // The real 2.90-day quiet stretch is pinned against the untrimmed record in hygiene.test.ts.
      assert.ok(Math.abs(draws!.maxGapH! - 73.35) < 0.1, `maxGapH ≈ 73.35, got ${draws!.maxGapH}`);
      assert.equal(draws!.lastDrawAt, "2026-08-05T12:47:46.289Z", "newest event is the last draw");
    });
    assert.equal(captured.length, 4, "every event persisted");

    const big = captured.find((e) => e.at.toISOString() === "2026-08-05T12:47:46.289Z")!;
    assert.equal(big.thermalKwh, 6.3577, "thermalKwh maps straight through");
    assert.equal(big.electricalKwh, 2.1771, "energyKwh → electrical_kwh, NOT thermal");
    assert.ok(big.thermalKwh! > big.electricalKwh!, "thermal > electrical (COP>1) — mapping not swapped");
    assert.ok(Array.isArray(snap.body?.events), "aggregate snapshot still stores the whole body");
  }

  // 2. Re-fetching the same rolling window is a no-op — TempIQ resends overlaps every tick.
  {
    const captured: Captured[] = [];
    const snap = { body: null as any };
    const store = makeStore(captured, snap);
    await withStub(PAYLOAD, async (base) => {
      const reader = new TempiqReader(store, base, "t");
      await reader.tick();
      await reader.tick();
      assert.match(reader.status().lastResult ?? "", /draws \+0\/4dup/, "second tick inserts nothing");
    });
    assert.equal(captured.length, 4, "no duplicates after a repeat tick");
  }

  // 3. available:false with no events must not throw or fabricate stats — TempIQ's normal
  //    "no estimate yet" answer, and the shape we saw before their endpoint had data.
  {
    const captured: Captured[] = [];
    const snap = { body: null as any };
    await withStub({ available: false, estimate: null, rolling: null, events: [] }, async (base) => {
      const reader = new TempiqReader(makeStore(captured, snap), base, "t");
      await reader.tick();
      assert.match(reader.status().lastResult ?? "", /dhw: unavailable/, "reports unavailable");
    });
    assert.equal(captured.length, 0, "empty events ⇒ nothing inserted");
  }

  // 4. Junk entries are dropped, not persisted as Invalid Date (which would poison the PK).
  {
    const captured: Captured[] = [];
    const snap = { body: null as any };
    const junk = { available: true, estimate: null, rolling: null, events: [
      { at: "not-a-date", energyKwh: 1, thermalKwh: 2 },
      { energyKwh: 1, thermalKwh: 2 },
      { at: "2026-08-05T12:47:46.289Z", energyKwh: 2.1771, thermalKwh: 6.3577 },
    ] };
    await withStub(junk, async (base) => {
      const reader = new TempiqReader(makeStore(captured, snap), base, "t");
      await reader.tick();
    });
    assert.equal(captured.length, 1, "only the well-formed event survives");
    assert.ok(!isNaN(captured[0].at.getTime()), "no Invalid Date reaches the store");
  }

  console.log("dhw-read.test.ts: all assertions passed ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
