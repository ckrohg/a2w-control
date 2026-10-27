/**
 * TempiqReader: the ADVISORY tier never inflates the failure streak, and the winter scoreboard mirror (wave plan
 * 2026-10-01 B2b) persists the whole body with a fetchedAt stamp. Fakes `globalThis.fetch` (forecast.test.ts idiom)
 * and a narrow Store.
 * Since TempIQv2#2124 (TempIQ defers a COP point until the charge's end is observable, re-upserts its overlap day,
 * and backfilled Sep 29 → Oct 27 with timestamps older than the mirror's cursor) the COP mirror re-reads a rolling
 * overlap window, pages backwards with `before`, UPSERTs, and has a one-off refetch — tests 9–16 cover those against
 * a fake of copMeasurementsHandler's semantics (newest-first, since inclusive, before exclusive, limit ≤ 2000).
 */
import assert from "node:assert/strict";
import {
  TempiqReader, summarizeWinterScoreboard, formatChangePct, roundPct,
  copFetchSince, parseCopRefetchRequest, summarizeCopFetch, COP_REFETCH_MAX_PAGES, COP_REFETCH_MAX_AGE_DAYS,
} from "./tempiq-read";
import type { CopPoint } from "./tempiq-read";
import type { Store } from "./store";

type Reply = { status: number; body: unknown };
type Route = Reply | ((url: URL) => Reply);
function fakeFetch(routes: Record<string, Route>, calls: string[], urls: URL[] = []) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.pathname);
    urls.push(url);
    const route = routes[url.pathname];
    const r: Reply = route == null ? { status: 404, body: { error: "not found" } } : typeof route === "function" ? route(url) : route;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}
const copKey = (p: { measuredAt: Date; system: string }) => `${p.measuredAt.toISOString()}|${p.system}`;
const COP_FIELDS = ["outdoorTempF", "sinkTempF", "cop", "thermalKwh", "electricalKwh", "quality", "qualityScore"] as const;
function fakeStore(opts: { newest?: Date | null } = {}) {
  const upserts: Record<string, unknown[]> = { scoreboard: [], dhw: [], zoneEnergy: [], zonePhysics: [] };
  const cop = new Map<string, CopPoint>();
  const store = {
    upsertTempiqZonePhysics: async (rows: unknown) => { upserts.zonePhysics.push(rows); },
    latestTempiqCopAt: async () => {
      if (opts.newest !== undefined) return opts.newest;
      let max: Date | null = null;
      for (const p of cop.values()) if (max == null || p.measuredAt > max) max = p.measuredAt;
      return max;
    },
    // the store's upsert contract: a new PK inserts, a changed row updates, an identical row is neither
    insertTempiqCopPoints: async (points: CopPoint[]) => {
      let inserted = 0, updated = 0;
      for (const p of points) {
        const cur = cop.get(copKey(p));
        if (!cur) { cop.set(copKey(p), p); inserted++; }
        else if (COP_FIELDS.some((f) => cur[f] !== p[f])) { cop.set(copKey(p), p); updated++; }
      }
      return { inserted, updated };
    },
    upsertTempiqZoneEnergy: async (b: unknown) => { upserts.zoneEnergy.push(b); },
    upsertTempiqDhwUsage: async (b: unknown) => { upserts.dhw.push(b); },
    upsertTempiqWinterScoreboard: async (b: unknown) => { upserts.scoreboard.push(b); },
  } as unknown as Store;
  return { store, upserts, cop };
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
async function withFetch(routes: Record<string, Route>, fn: (calls: string[], urls: URL[]) => Promise<void>) {
  const calls: string[] = [];
  const urls: URL[] = [];
  globalThis.fetch = fakeFetch(routes, calls, urls) as typeof fetch;
  try { await fn(calls, urls); } finally { globalThis.fetch = realFetch; }
}

// ── a fake of TempIQ's copMeasurementsHandler: newest-first, since ≥, before <, limit clamped to [1, 2000] ──
type CopRow = { timestamp: string; systemId: string; systemType: string; outdoorTempF: number; sinkTempF: number; cop: number; thermalKwh: number; electricalKwh: number; confidence: string; qualityScore: number };
const DAY = 86_400_000;
function row(ts: string, systemId: string, i: number, over: Partial<CopRow> = {}): CopRow {
  return { timestamp: ts, systemId, systemType: "heat_pump", outdoorTempF: 40 + (i % 7), sinkTempF: 125, cop: 2 + (i % 5) / 10,
    thermalKwh: 4, electricalKwh: 2, confidence: "high", qualityScore: 0.8, ...over };
}
/** n timestamps from `start`, `stepS` apart; hp1 at every one, hp2 at the even ones — so page edges fall mid-timestamp. */
function dataset(n: number, start: Date, stepS: number): CopRow[] {
  const rows: CopRow[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(start.getTime() + i * stepS * 1000).toISOString();
    rows.push(row(ts, "hp1", i));
    if (i % 2 === 0) rows.push(row(ts, "hp2", i));
  }
  return rows;
}
const rowKey = (r: CopRow) => `${new Date(r.timestamp).toISOString()}|${r.systemType}:${r.systemId}`;
function copServer(rows: CopRow[], opts: { failPage?: number } = {}) {
  let page = 0;
  const handler = (url: URL): Reply => {
    page++;
    if (opts.failPage != null && page === opts.failPage) return { status: 500, body: { error: "boom" } };
    const since = url.searchParams.get("since"), before = url.searchParams.get("before");
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "500")), 2000);
    const sinceMs = since ? Date.parse(since) : -Infinity, beforeMs = before ? Date.parse(before) : Infinity;
    const sel = rows
      .filter((r) => { const t = Date.parse(r.timestamp); return t >= sinceMs && t < beforeMs; })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.systemId.localeCompare(b.systemId))
      .slice(0, limit);
    return { status: 200, body: { propertyId: "p", count: sel.length, measurements: sel } };
  };
  return handler;
}
const copParam = (u: URL, k: string) => u.searchParams.get(k);
const copUrls = (urls: URL[]) => urls.filter((u) => u.pathname === "/api/insights/cop-measurements");

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
    assert.match(st.lastResult ?? "", /cop: \+0 new \/ 0 updated \/ 0 seen/, "an empty cop page is one page, nothing seen");
    assert.equal(st.copOverlapDays, 3, "default overlap");
    assert.equal(st.lastCopRefetch, null, "no refetch ran");
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
  // 6. rounding: a change that rounds to zero is "flat" (never "-0%"); the change is never quoted without its baseline
  assert.equal(formatChangePct(-0.4), "flat");
  assert.equal(formatChangePct(-0), "flat");
  assert.equal(formatChangePct(0.49), "flat");
  assert.equal(formatChangePct(-0.49), "flat");
  // half rounds AWAY from zero on both sides (Math.round alone gives -0.5 → -0 but 0.5 → 1)
  assert.equal(formatChangePct(-0.5), "-1%");
  assert.equal(formatChangePct(0.5), "+1%");
  assert.equal(roundPct(-0.5), -1); assert.equal(roundPct(0.5), 1); assert.equal(roundPct(-2.5), -3); assert.equal(roundPct(2.5), 3);
  assert.ok(Object.is(roundPct(-0.4), -0) || roundPct(-0.4) === 0); // still equal to 0 for the flat test
  assert.equal(formatChangePct(-1.6), "-2%");
  assert.equal(formatChangePct(NaN), null);
  assert.equal(formatChangePct(null), null);
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [], comparison: { weeksCompared: 2, current: { kwhPerHdd: 3 }, baseline: { kwhPerHdd: 3.01 }, intensityChangePct: -0.4 } }), "scoreboard: 2026-27 3.00 kWh/HDD vs 3.01 last winter (flat), 2 wk compared");
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [], comparison: { weeksCompared: 2, current: { kwhPerHdd: 3 }, baseline: null, intensityChangePct: -12 } }), "scoreboard: 2026-27 3.00 kWh/HDD, 2 wk compared");
  // 7. odd shapes: weeks not an array, comparison null, NaN numbers
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: "x" as unknown as unknown[], comparison: null }), "scoreboard: 2026-27, 0 wk, no rated week yet");
  assert.equal(summarizeWinterScoreboard({ available: true, season: "2026-27", weeks: [], comparison: { current: { kwhPerHdd: NaN } } }), "scoreboard: 2026-27, 0 wk, no rated week yet");
  // 8. a non-JSON 200 on the scoreboard route stays inside the advisory try (tick resolves, streak 0, nothing persisted)
  {
    const { store, upserts } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    const calls: string[] = [];
    const inner = fakeFetch({ ...critical }, calls);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === "/api/insights/winter-scoreboard") return new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } });
      return inner(input);
    }) as typeof fetch;
    try { await r.tick(); } finally { globalThis.fetch = realFetch; }
    assert.equal(r.status().consecutiveFailures, 0);
    assert.match(r.status().lastResult ?? "", /scoreboard error: /);
    assert.equal(upserts.scoreboard.length, 0);
  }

  // ── TempIQv2#2124: the COP mirror's rolling overlap window, pagination, upsert and one-off refetch ──

  // 9. the overlap window: since = newest stored − COP_OVERLAP_DAYS (default 3), never the newest point; 7 d back on an empty table
  {
    const now = new Date("2026-10-27T12:00:00Z");
    const newest = new Date("2026-10-27T00:10:00Z");
    assert.equal(copFetchSince(newest, now, 3).toISOString(), "2026-10-24T00:10:00.000Z");
    assert.equal(copFetchSince(newest, now, 1).toISOString(), "2026-10-26T00:10:00.000Z");
    assert.equal(copFetchSince(newest, now, 0).toISOString(), newest.toISOString(), "0 = the pre-#2124 cursor");
    assert.equal(copFetchSince(newest, now, -5).toISOString(), newest.toISOString(), "a negative overlap clamps to 0");
    assert.equal(copFetchSince(newest, now, NaN).toISOString(), "2026-10-24T00:10:00.000Z", "NaN falls back to the default");
    assert.equal(copFetchSince(null, now, 3).toISOString(), "2026-10-20T12:00:00.000Z", "empty table: 7 d back from now");
    // and the tick sends exactly that, with the endpoint's maximum page size and no `before` on the first page
    const { store } = fakeStore({ newest });
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical }, async (_calls, urls) => {
      await r.tick();
      const u = copUrls(urls);
      assert.equal(u.length, 1);
      assert.equal(copParam(u[0], "since"), "2026-10-24T00:10:00.000Z");
      assert.equal(copParam(u[0], "limit"), "2000");
      assert.equal(copParam(u[0], "before"), null);
    });
    const r1 = new TempiqReader(fakeStore({ newest }).store, "https://tempiq.test", "tok", { copOverlapDays: 1 });
    await withFetch({ ...critical }, async (_calls, urls) => {
      await r1.tick();
      assert.equal(copParam(copUrls(urls)[0], "since"), "2026-10-26T00:10:00.000Z", "COP_OVERLAP_DAYS=1 honoured");
      assert.equal(r1.status().copOverlapDays, 1);
    });
    const rBad = new TempiqReader(fakeStore({ newest }).store, "https://tempiq.test", "tok", { copOverlapDays: NaN });
    assert.equal(rBad.status().copOverlapDays, 3, "a bad env value falls back to the default, not to 0");
    const rNull = new TempiqReader(fakeStore({ newest: null }).store, "https://tempiq.test", "tok");
    await withFetch({ ...critical }, async (_calls, urls) => {
      const before = Date.now();
      await rNull.tick();
      const since = Date.parse(copParam(copUrls(urls)[0], "since")!);
      assert.ok(Math.abs(since - (before - 7 * DAY)) < 5_000, "first run keeps the 7-day backfill");
    });
  }
  // 10. pagination with `before`: 4500 rows (3 pages at the 2000 cap) all land; the next page's before is the page's
  //     oldest + 1 ms, so the other pump's row at a boundary timestamp repeats (seen twice) instead of dropping
  {
    const rows = dataset(3000, new Date(Date.now() - 6 * DAY), Math.floor(6 * DAY / 1000 / 3000));
    assert.equal(rows.length, 4500);
    const { store, cop } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async (_calls, urls) => {
      await r.tick();
      const u = copUrls(urls);
      assert.equal(u.length, 3, `3 pages, got ${u.length}`);
      assert.equal(copParam(u[0], "before"), null);
      for (let i = 1; i < u.length; i++) {
        const prev = Date.parse(copParam(u[i - 1], "before") ?? "9999-01-01");
        const cur = Date.parse(copParam(u[i], "before")!);
        assert.ok(cur < prev, "before walks backwards");
        assert.equal(copParam(u[i], "since"), copParam(u[0], "since"), "since is fixed for the whole walk");
      }
    });
    assert.equal(cop.size, 4500, "every row of the dataset is stored exactly once");
    assert.deepEqual(new Set(cop.keys()), new Set(rows.map(rowKey)));
    const m = /cop: \+(\d+) new \/ (\d+) updated \/ (\d+) seen \((\d+) pages\)/.exec(r.status().lastResult ?? "");
    assert.ok(m, `lastResult: ${r.status().lastResult}`);
    assert.equal(Number(m![1]), 4500);
    assert.equal(Number(m![2]), 0);
    assert.ok(Number(m![3]) >= 4500 && Number(m![3]) <= 4504, `seen counts the boundary repeats: ${m![3]}`);
    assert.equal(Number(m![4]), 3);
    assert.equal(r.status().consecutiveFailures, 0);
    // the next tick re-reads the overlap: everything in it is unchanged — nothing inserted, nothing updated, no streak
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async () => { await r.tick(); });
    assert.match(r.status().lastResult ?? "", /cop: \+0 new \/ 0 updated \/ \d+ seen/);
    assert.equal(cop.size, 4500);
  }
  // 11. upsert semantics through the reader: a row TempIQ completed later (deferred charge, more thermal energy, a better
  //     score) is UPDATED; an identical row is neither; a new one is inserted — and lastResult shows all three counts
  {
    const start = new Date(Date.now() - 2 * DAY);
    const t = (h: number) => new Date(start.getTime() + h * 3_600_000).toISOString();
    const { store, cop } = fakeStore();
    // the mirror already holds the first two rows — the second one in its SHORT, provisional form
    const seeded: CopPoint[] = [
      { measuredAt: new Date(t(0)), system: "heat_pump:hp1", outdoorTempF: 40, sinkTempF: 125, cop: 2.0, thermalKwh: 4, electricalKwh: 2, quality: "high", qualityScore: 0.8 },
      { measuredAt: new Date(t(1)), system: "heat_pump:hp1", outdoorTempF: 41, sinkTempF: 125, cop: 1.2, thermalKwh: 1.2, electricalKwh: 1, quality: "low", qualityScore: 0.4 },
    ];
    for (const p of seeded) cop.set(copKey(p), p);
    const rows: CopRow[] = [
      row(t(0), "hp1", 0, { outdoorTempF: 40, cop: 2.0 }),                                                         // unchanged
      row(t(1), "hp1", 1, { outdoorTempF: 41, cop: 3.0, thermalKwh: 6, electricalKwh: 2, confidence: "high", qualityScore: 0.9 }), // completed
      row(t(2), "hp2", 2, { outdoorTempF: 42, cop: 2.2 }),                                                         // new
    ];
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async () => { await r.tick(); });
    assert.match(r.status().lastResult ?? "", /cop: \+1 new \/ 1 updated \/ 3 seen/, r.status().lastResult ?? "");
    const completed = cop.get(`${t(1)}|heat_pump:hp1`)!;
    assert.equal(completed.cop, 3.0);
    assert.equal(completed.thermalKwh, 6);
    assert.equal(completed.quality, "high");
    assert.equal(completed.qualityScore, 0.9);
    assert.equal(cop.size, 3);
    assert.equal(summarizeCopFetch({ since: "s", before: null, fetched: 41, inserted: 3, updated: 2, pages: 1, oldest: null, newest: null, truncated: false }), "cop: +3 new / 2 updated / 41 seen");
  }
  // 12. the page bound: a tick stops at 10 pages and SAYS so (truncated, loud in lastResult); the one-off refetch has a
  //     50-page bound and finishes the same window
  {
    const rows = dataset(14_000, new Date(Date.now() - 6 * DAY), Math.floor(6 * DAY / 1000 / 14_000));
    assert.equal(rows.length, 21_000);
    const { store, cop } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    let sinceUsed = "";
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async (_calls, urls) => {
      await r.tick();
      const u = copUrls(urls);
      assert.equal(u.length, 10, `bounded at 10 pages, got ${u.length}`);
      sinceUsed = copParam(u[0], "since")!;
    });
    assert.match(r.status().lastResult ?? "", /cop: \+\d+ new \/ 0 updated \/ \d+ seen \(10 pages, TRUNCATED at the page bound — rows older than \S+ not fetched\)/, r.status().lastResult ?? "");
    // 10 × 2000 rows seen; each of the 9 page edges re-sends the 1–2 rows at its boundary timestamp
    assert.ok(cop.size >= 20_000 - 2 * 9 && cop.size <= 20_000 - 9, `10 full pages minus boundary repeats: ${cop.size}`);
    assert.match(r.status().lastResult ?? "", /\/ 20000 seen/);
    assert.equal(r.status().consecutiveFailures, 0, "a truncated walk is not a failure — it is reported");
    assert.equal(COP_REFETCH_MAX_PAGES, 50);
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async (_calls, urls) => {
      const s = await r.refetchCop(new Date(sinceUsed), null);
      assert.equal(s.truncated, false);
      assert.equal(s.error, null);
      assert.equal(s.pages, copUrls(urls).length);
      assert.ok(s.pages >= 11 && s.pages <= 12, `whole window in ${s.pages} pages`);
      assert.equal(s.inserted, 21_000 - cop.size + s.inserted, "the refetch inserted exactly what the tick left");
    });
    assert.equal(cop.size, 21_000);
  }
  // 13. refetch request bounds (the route's 422s): since required + ISO + ≤ 400 days old + not in the future; before optional, ISO, after since
  {
    const now = new Date("2026-10-27T12:00:00Z");
    const bad = (body: unknown, re: RegExp) => {
      const p = parseCopRefetchRequest(body, now);
      assert.equal(p.ok, false, JSON.stringify(body));
      if (!p.ok) assert.match(p.error, re, `${JSON.stringify(body)} → ${p.error}`);
    };
    bad({}, /since must be an ISO date/);
    bad(null, /since must be an ISO date/);
    bad("2026-09-29", /since must be an ISO date/);
    bad({ since: "" }, /since must be an ISO date/);
    bad({ since: "yesterday" }, /since must be an ISO date/);
    bad({ since: 1_600_000_000_000 }, /since must be an ISO date/);
    bad({ since: "2026-10-28T00:00:00Z" }, /future/);
    bad({ since: "2025-09-01" }, new RegExp(`within the last ${COP_REFETCH_MAX_AGE_DAYS} days`));
    bad({ since: "2026-09-29", before: "nope" }, /before must be an ISO date/);
    bad({ since: "2026-09-29", before: "2026-09-29" }, /before must be after since/);
    bad({ since: "2026-09-29", before: "2026-09-01" }, /before must be after since/);
    const ok = parseCopRefetchRequest({ since: "2026-09-29" }, now);
    assert.ok(ok.ok);
    if (ok.ok) { assert.equal(ok.since.toISOString(), "2026-09-29T00:00:00.000Z"); assert.equal(ok.before, null); }
    const okB = parseCopRefetchRequest({ since: "2026-09-29T00:00:00Z", before: "2026-10-27T00:00:00Z" }, now);
    assert.ok(okB.ok);
    if (okB.ok) assert.equal(okB.before?.toISOString(), "2026-10-27T00:00:00.000Z");
    const okNullBefore = parseCopRefetchRequest({ since: "2026-09-29", before: null }, now);
    assert.ok(okNullBefore.ok && okNullBefore.before === null, "before: null is 'no before'");
    const edge = parseCopRefetchRequest({ since: new Date(now.getTime() - COP_REFETCH_MAX_AGE_DAYS * DAY).toISOString() }, now);
    assert.ok(edge.ok, "exactly 400 days is allowed");
  }
  // 14. the one-off refetch: honours [since, before), returns {fetched, inserted, updated, pages, oldest, newest}, keeps
  //     the summary on status().lastCopRefetch, and the tick is untouched by it
  {
    const start = new Date(Date.now() - 30 * DAY);
    const rows = dataset(200, start, 3600); // 200 h of rows, 300 rows
    const since = new Date(start.getTime() + 50 * 3_600_000);
    const before = new Date(start.getTime() + 150 * 3_600_000);
    const inWindow = rows.filter((x) => Date.parse(x.timestamp) >= since.getTime() && Date.parse(x.timestamp) < before.getTime());
    const { store, cop } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    assert.equal(r.refetchInFlight(), false);
    let s!: Awaited<ReturnType<TempiqReader["refetchCop"]>>;
    await withFetch({ "/api/insights/cop-measurements": copServer(rows) }, async (_calls, urls) => {
      s = await r.refetchCop(since, before);
      const u = copUrls(urls);
      assert.equal(u.length, 1);
      assert.equal(copParam(u[0], "since"), since.toISOString());
      assert.equal(copParam(u[0], "before"), before.toISOString(), "the caller's before is the first page's upper bound");
    });
    assert.equal(r.refetchInFlight(), false);
    assert.deepEqual(
      { fetched: s.fetched, inserted: s.inserted, updated: s.updated, pages: s.pages, truncated: s.truncated, error: s.error },
      { fetched: inWindow.length, inserted: inWindow.length, updated: 0, pages: 1, truncated: false, error: null },
    );
    assert.equal(s.oldest, new Date(Math.min(...inWindow.map((x) => Date.parse(x.timestamp)))).toISOString());
    assert.equal(s.newest, new Date(Math.max(...inWindow.map((x) => Date.parse(x.timestamp)))).toISOString());
    assert.equal(s.since, since.toISOString());
    assert.equal(s.before, before.toISOString());
    assert.ok(Date.parse(s.finishedAt) >= Date.parse(s.startedAt) && s.durationMs >= 0);
    assert.equal(cop.size, inWindow.length, "nothing outside [since, before) was touched");
    assert.deepEqual(r.status().lastCopRefetch, s, "/health.tempiq_read.lastCopRefetch is the summary");
    assert.equal(r.status().lastFetchAt, null, "a refetch is not a tick: lastFetchAt / lastResult / the streak are untouched");
    assert.equal(r.status().lastResult, null);
    // a second refetch over the same window: everything already mirrored
    await withFetch({ "/api/insights/cop-measurements": copServer(rows) }, async () => {
      const s2 = await r.refetchCop(since, before);
      assert.equal(s2.inserted, 0);
      assert.equal(s2.updated, 0);
      assert.equal(s2.fetched, inWindow.length);
    });
  }
  // 15. a page failing mid-walk: the refetch NEVER throws — it reports the error with the partial counts (the route answers
  //     502); the same failure inside a tick is a critical error that counts on the streak
  {
    const rows = dataset(3000, new Date(Date.now() - 6 * DAY), Math.floor(6 * DAY / 1000 / 3000));
    const { store, cop } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows, { failPage: 2 }) }, async () => {
      const s = await r.refetchCop(new Date(Date.now() - 7 * DAY), null);
      assert.match(s.error ?? "", /GET \/api\/insights\/cop-measurements: HTTP 500/);
      assert.equal(s.pages, 1, "pages counts what LANDED — the failed request is the error, not a page");
      assert.equal(s.inserted, 2000, "page 1 landed before the failure");
      assert.equal(s.truncated, false);
      assert.ok(s.oldest != null && s.newest != null);
      assert.equal(r.status().lastCopRefetch?.error, s.error);
    });
    assert.equal(r.refetchInFlight(), false, "the in-flight flag is cleared on failure too");
    assert.equal(cop.size, 2000);
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows, { failPage: 1 }) }, async () => { await r.tick(); });
    assert.equal(r.status().consecutiveFailures, 1, "a cop page failure inside the tick is critical");
    assert.match(r.status().lastResult ?? "", /cop error: GET \/api\/insights\/cop-measurements: HTTP 500/);
  }
  // 16. a full page of ONE timestamp cannot spin the walk: before = oldest + 1 ms makes no progress → stop after the repeat
  {
    const ts = new Date(Date.now() - DAY).toISOString();
    const rows: CopRow[] = [];
    for (let i = 0; i < 2000; i++) rows.push(row(ts, `sys${i}`, i));
    const { store, cop } = fakeStore();
    const r = new TempiqReader(store, "https://tempiq.test", "tok");
    await withFetch({ ...critical, "/api/insights/cop-measurements": copServer(rows) }, async (_calls, urls) => {
      await r.tick();
      assert.equal(copUrls(urls).length, 2, "one full page, one repeat, then stop");
    });
    assert.equal(cop.size, 2000);
    assert.match(r.status().lastResult ?? "", /cop: \+2000 new \/ 0 updated \/ 4000 seen \(2 pages\)/, r.status().lastResult ?? "");
  }
  console.log("ok tempiq-read (advisory tier + winter scoreboard mirror + COP overlap / pagination / upsert / refetch)");
})().catch((e) => { console.error(e); process.exit(1); });
