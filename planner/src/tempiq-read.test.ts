/**
 * TempiqReader: the ADVISORY tier never inflates the failure streak, and the winter scoreboard mirror (wave plan
 * 2026-10-01 B2b) persists the whole body with a fetchedAt stamp. Fakes `globalThis.fetch` (forecast.test.ts idiom)
 * and a narrow Store.
 */
import assert from "node:assert/strict";
import { TempiqReader, summarizeWinterScoreboard } from "./tempiq-read";
import type { Store } from "./store";

type Route = { status: number; body: unknown };
function fakeFetch(routes: Record<string, Route>, calls: string[]) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const path = new URL(url).pathname;
    calls.push(path);
    const r = routes[path] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}
function fakeStore() {
  const upserts: Record<string, unknown[]> = { scoreboard: [], dhw: [], zoneEnergy: [], zonePhysics: [] };
  const store = {
    upsertTempiqZonePhysics: async (rows: unknown) => { upserts.zonePhysics.push(rows); },
    latestTempiqCopAt: async () => null,
    insertTempiqCopPoints: async () => 0,
    upsertTempiqZoneEnergy: async (b: unknown) => { upserts.zoneEnergy.push(b); },
    upsertTempiqDhwUsage: async (b: unknown) => { upserts.dhw.push(b); },
    upsertTempiqWinterScoreboard: async (b: unknown) => { upserts.scoreboard.push(b); },
  } as unknown as Store;
  return { store, upserts };
}
const critical: Record<string, Route> = {
  "/api/insights/zones": { status: 200, body: { zones: [] } },
  "/api/insights/cop-measurements": { status: 200, body: [] },
  "/api/insights/zone-energy": { status: 200, body: { zones: [] } },
};
const scoreboardBody = {
  available: true, propertyId: "p", season: "2026-27", baselineSeason: "2025-26", seasons: ["2025-26", "2026-27"],
  weeks: [{ weekIndex: 0 }, { weekIndex: 1 }], baselineWeeks: [],
  comparison: { weeksCompared: 2, intensityChangePct: -12.4, note: null,
    current: { hvacKwh: 400, hdd65: 160, kwhPerHdd: 2.5, coldHours: 3, sampledHours: 300, coldShare: 0.01 },
    baseline: { season: "2025-26", hvacKwh: 500, hdd65: 175, kwhPerHdd: 2.857, coldHours: 9, sampledHours: 280, coldShare: 0.032 } },
  generatedAt: "2026-12-15T12:00:00Z",
};

const realFetch = globalThis.fetch;
async function withFetch(routes: Record<string, Route>, fn: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  globalThis.fetch = fakeFetch(routes, calls) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

(async () => {
  // 1. scoreboard mirrored with a fetchedAt stamp; summary in lastResult; no failure counted
  {
    const { store, upserts } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical, "/api/insights/winter-scoreboard": { status: 200, body: scoreboardBody } }, async (calls) => {
      await r.tick();
      assert.ok(calls.includes("/api/insights/winter-scoreboard"), "the tick fetches the scoreboard");
    });
    assert.equal(upserts.scoreboard.length, 1);
    const saved = upserts.scoreboard[0] as Record<string, unknown>;
    assert.equal(saved.season, "2026-27");
    assert.ok(typeof saved.fetchedAt === "string" && !Number.isNaN(Date.parse(saved.fetchedAt as string)), "fetchedAt stamped");
    const st = r.status();
    assert.equal(st.consecutiveFailures, 0, "spatial 404 + dhw 404 are advisory — streak stays 0");
    assert.match(st.lastResult ?? "", /scoreboard: 2026-27 2\.50 kWh\/HDD vs 2\.86 last winter \(-12%\), 2 wk compared/);
    assert.match(st.lastResult ?? "", /spatial error: .*404/);
  }
  // 2. the scoreboard endpoint 404s (TempIQ #2063 not deployed yet): advisory — streak 0, lastFetchAt set, nothing persisted
  {
    const { store, upserts } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical }, async () => { await r.tick(); });
    const st = r.status();
    assert.equal(st.consecutiveFailures, 0);
    assert.ok(st.lastFetchAt != null);
    assert.match(st.lastResult ?? "", /scoreboard error: GET \/api\/insights\/winter-scoreboard: HTTP 404/);
    assert.equal(upserts.scoreboard.length, 0);
  }
  // 3. available:false IS persisted (the digest sees the reason) and summarised, still no failure
  {
    const { store, upserts } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    const body = { available: false, reason: "no_rows", propertyId: "p", seasons: [] };
    await withFetch({ ...critical, "/api/insights/winter-scoreboard": { status: 200, body } }, async () => { await r.tick(); });
    assert.equal(upserts.scoreboard.length, 1);
    assert.equal((upserts.scoreboard[0] as Record<string, unknown>).reason, "no_rows");
    assert.match(r.status().lastResult ?? "", /scoreboard: unavailable \(no_rows\)/);
    assert.equal(r.status().consecutiveFailures, 0);
  }
  // 4. a critical endpoint failing still counts (the advisory tier did not weaken the streak)
  {
    const { store } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    const routes = { ...critical, "/api/insights/winter-scoreboard": { status: 200, body: scoreboardBody } };
    delete (routes as Record<string, Route>)["/api/insights/zones"];
    await withFetch(routes, async () => { await r.tick(); });
    assert.equal(r.status().consecutiveFailures, 1);
  }
  // 5. the pure summary: no rated week yet, baseline missing, positive change sign
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [{}], comparison: { current: { kwhPerHdd: null } } }), "scoreboard: 2026-27, 1 wk, no rated week yet");
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [], comparison: { weeksCompared: 1, current: { kwhPerHdd: 3.1 }, baseline: null, intensityChangePct: null } }), "scoreboard: 2026-27 3.10 kWh/HDD, 1 wk compared");
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [], comparison: { weeksCompared: 3, current: { kwhPerHdd: 3.1 }, baseline: { kwhPerHdd: 2.9 }, intensityChangePct: 6.9 } }), "scoreboard: 2026-27 3.10 kWh/HDD vs 2.90 last winter (+7%), 3 wk compared");
  assert.equal(summarizeWinterScoreboard(null), "scoreboard: unavailable");
  console.log("ok tempiq-read (advisory tier + winter scoreboard mirror)");
})().catch((e) => { console.error(e); process.exit(1); });
