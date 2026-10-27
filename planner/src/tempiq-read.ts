/**
 * @purpose TempIQ insights reader (plan §6.7 seam, TempIQ#1470 — SHIPPED 2026-07-14 as
 * TempIQv2 PR #1502; the read half of the seam whose push half is tempiq.ts). Every
 * READ_EVERY_MIN the planner pulls TempIQ's learned insights (surface-token bearer
 * auth) and persists them to the planner store:
 *   GET /api/insights/zones            → tempiq_zone_physics (per-zone UA BTU/hr/°F,
 *                                        thermal mass BTU/°F, emitter type, confidence
 *                                        + source — latest row per zone)
 *   GET /api/insights/cop-measurements → tempiq_cop_points (COP w/ outdoor + sink temps
 *                                        for the COP(outdoor, water) fit; UPSERT on
 *                                        measured_at + system, re-read from a rolling
 *                                        window ?since=<newest stored point − COP_OVERLAP_DAYS,
 *                                        else 7d>, paged backwards with ?before= so the
 *                                        endpoint's 2000-row cap never truncates — see
 *                                        walkCopPagesInto. TempIQv2#2124 made TempIQ's
 *                                        writer defer a point until the charge's end is
 *                                        observable and re-upsert its overlap day each
 *                                        run, so the newest mirrored point is not a safe
 *                                        cursor and a mirrored row can legitimately change.
 *                                        POST /api/tempiq/cop-refetch (index.ts) runs the
 *                                        same walk from an explicit since — the one-off that
 *                                        mirrors a backfill older than the window.)
 *   GET /api/insights/zone-energy      → tempiq_zone_energy (latest snapshot JSON,
 *                                        single-row upsert — shadow model picks fields)
 *   GET /api/insights/dhw-usage        → tempiq_dhw_usage (gtm#1431 — DHW-vs-space-ISOLATED
 *                                        usage aggregate; ADVISORY enrichment, single-row
 *                                        snapshot. Winter DHW load separation our local
 *                                        tank-drop inference can't do; NEVER gates control)
 * §6.7 doctrine: TempIQ already learns the zone physics (hydronic-system-learner —
 * effective thermal mass, per-zone loads, envelope UA), so the planner CONSUMES those
 * outputs and never re-derives them; the tank's behavioral model (C_eff, DHW windows,
 * standby loss) stays planner-owned and self-learned from its own 5-min data.
 * Fail-soft per endpoint: one endpoint failing never blocks the others and never
 * touches the control loop; we log, count the streak, and retry next tick. Re-fetching
 * overlaps is safe (zones/zone-energy upsert, cop points dedupe on the PK). Flag-gated:
 * inert unless TEMPIQ_READ_ENABLED=1 and TEMPIQ_SURFACE_TOKEN is set.
 */

import type { Store } from "./store";
import { fetchInsightSpatialGraph, summarizeWarmAdjacency } from "./spatial";

const DAY_MS = 24 * 60 * 60 * 1000;
const COP_BACKFILL_MS = 7 * DAY_MS; // first fetch (empty table) reaches back 7 days
const COP_PAGE_LIMIT = 2000; // the endpoint's cap: copMeasurementsHandler clamps limit to [1, 2000]
const COP_OVERLAP_DAYS_DEFAULT = 3; // TempIQ's writer re-upserts ~1 day behind its watermark; 3 covers a missed run or two
// Page bounds. Two pumps make ~13–17 charges a day and the session calculator keeps a fraction of those, so a
// 3-day tick is a few dozen rows and ONE page; the bounds exist so a misbehaving endpoint can never hold the
// reader (tick) or the HTTP caller (refetch) indefinitely. A walk stopped by its bound reports truncated: true.
const COP_TICK_MAX_PAGES = 10;
export const COP_REFETCH_MAX_PAGES = 50;
export const COP_REFETCH_MAX_AGE_DAYS = 400;

export interface TempiqReadStatus {
  enabled: boolean;
  lastFetchAt: string | null;
  lastResult: string | null;
  consecutiveFailures: number;
  /** Days behind the newest mirrored COP point each tick re-reads (COP_OVERLAP_DAYS). */
  copOverlapDays: number;
  /** The last POST /api/tempiq/cop-refetch on this instance (null until one ran). */
  lastCopRefetch: CopRefetchSummary | null;
}

/** What one walk of /api/insights/cop-measurements did. `fetched` counts rows as received, so a row from another
 *  system that shares a page-boundary timestamp is counted twice (it repeats by design — see walkCopPagesInto);
 *  inserted + updated ≤ fetched, and the difference is rows TempIQ re-sent unchanged. */
export interface CopFetchSummary {
  since: string;
  before: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  pages: number;
  oldest: string | null;
  newest: string | null;
  /** The page bound stopped the walk with a full page in hand — rows older than `oldest` were NOT fetched. */
  truncated: boolean;
}

export interface CopRefetchSummary extends CopFetchSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The first HTTP/store error, if the walk stopped on one; the counts above are what landed before it. */
  error: string | null;
}

export interface CopPoint {
  measuredAt: Date; system: string; outdoorTempF: number | null; sinkTempF: number | null;
  cop: number | null; thermalKwh: number | null; electricalKwh: number | null;
  quality: string | null; qualityScore: number | null;
}

interface ZonesResponse {
  zones?: Array<{
    zoneId?: string;
    zoneName?: string | null;
    deliveryType?: string | null;
    envelope?: {
      ua?: number | null;
      thermalMass?: number | null;
      confidence?: number | null;
      source?: string | null;
    } | null;
  }>;
}

interface CopMeasurementsResponse {
  measurements?: Array<{
    timestamp?: string;
    systemId?: string | null;
    systemType?: string | null;
    outdoorTempF?: number | null;
    sinkTempF?: number | null;
    cop?: number | null;
    thermalKwh?: number | null;
    electricalKwh?: number | null;
    confidence?: string | null;
    qualityScore?: number | null;
  }>;
}

// gtm#1431 (TempIQv2 PR #1816): DHW-vs-space-isolated usage aggregate. Daily estimate + rolling-rate
// projection — NOT a per-cycle event stream, and lastUpdatedAt is the estimate's recency, not a literal
// last-draw time (per-draw timing stays locally mined). `available:false` = no estimate yet.
interface DhwUsageResponse {
  propertyId?: string;
  available?: boolean;
  dhwVsSpaceApplied?: boolean;
  estimate?: {
    source?: string | null;
    dailyElectricalKwh?: number | null;
    totalWaterHeatingKwh?: number | null;
    thermalKwh?: number | null;
    hydronicCop?: number | null;
    cycleCount?: number | null;
    lastUpdatedAt?: string | null;
    hoursSinceUpdate?: number | null;
    stale?: boolean | null;
  } | null;
  rolling?: { window24hKwh?: number | null; window72hKwh?: number | null; basis?: string | null } | null;
}

// Winter scoreboard (TempIQ #2063, GET /api/insights/winter-scoreboard): this winter's kWh per HDD65 against last
// winter over the SAME week indices, plus the pooled comfort share. Narrow projection — every field optional; the
// whole body is persisted as jsonb for the digest. `available:false` carries a reason (not_migrated | no_rows |
// season_not_found) and is a normal answer before the first rated week of a season.
export interface WinterScoreboardResponse {
  available?: boolean;
  reason?: string | null;
  season?: string | null;
  baselineSeason?: string | null;
  weeks?: unknown[] | null;
  comparison?: {
    weeksCompared?: number | null;
    current?: { kwhPerHdd?: number | null; hdd65?: number | null; hvacKwh?: number | null; coldShare?: number | null } | null;
    baseline?: { season?: string | null; kwhPerHdd?: number | null; hdd65?: number | null; hvacKwh?: number | null; coldShare?: number | null } | null;
    intensityChangePct?: number | null;
    note?: string | null;
  } | null;
  generatedAt?: string | null;
}

/** Round half AWAY from zero (Math.round(-0.5) is -0, Math.round(0.5) is 1 — asymmetric). PURE. */
export function roundPct(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** "+7%", "-12%", or "flat" when |change| < 0.5 — never "-0%" (a sign on a zero reads as a verdict). PURE. */
export function formatChangePct(pct: number | null | undefined): string | null {
  const n = numOrNull(pct);
  if (n == null) return null;
  const r = roundPct(n);
  if (r === 0) return "flat";
  return `${r > 0 ? "+" : ""}${r}%`;
}

/** One-line human summary for lastResult / the log. PURE. The change is quoted only next to the baseline it is against. */
export function summarizeWinterScoreboard(body: WinterScoreboardResponse | null | undefined): string {
  if (!body || body.available === false) return `scoreboard: unavailable${body?.reason ? ` (${body.reason})` : ""}`;
  const c = body.comparison ?? null;
  const weeks = Array.isArray(body.weeks) ? body.weeks.length : 0;
  const cur = numOrNull(c?.current?.kwhPerHdd);
  const base = numOrNull(c?.baseline?.kwhPerHdd);
  const chg = base != null ? formatChangePct(c?.intensityChangePct) : null;
  const season = body.season ?? "?";
  if (cur == null) return `scoreboard: ${season}, ${weeks} wk, no rated week yet`;
  return `scoreboard: ${season} ${cur.toFixed(2)} kWh/HDD${base != null ? ` vs ${base.toFixed(2)} last winter` : ""}${chg != null ? ` (${chg})` : ""}, ${numOrNull(c?.weeksCompared) ?? 0} wk compared`;
}

/** The tick's lower bound: the newest mirrored point minus the overlap — never the newest point itself, because
 *  since TempIQv2#2124 TempIQ defers a point until the charge's end is observable and re-upserts its overlap day on
 *  every hourly run, so a point older than the newest can still appear or change. 7 days back on an empty table.
 *  PURE. */
export function copFetchSince(newest: Date | null, now: Date, overlapDays: number): Date {
  if (newest == null) return new Date(now.getTime() - COP_BACKFILL_MS);
  const days = Number.isFinite(overlapDays) ? Math.max(0, overlapDays) : COP_OVERLAP_DAYS_DEFAULT;
  return new Date(newest.getTime() - days * DAY_MS);
}

/** Validate a POST /api/tempiq/cop-refetch body: `since` (ISO, required, within the last COP_REFETCH_MAX_AGE_DAYS,
 *  not in the future) and an optional `before` (ISO, after since). PURE; the route turns ok:false into a 422. */
export function parseCopRefetchRequest(
  body: unknown, now: Date,
): { ok: true; since: Date; before: Date | null } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const since = parseIsoDate(b.since);
  if (since == null) return { ok: false, error: "since must be an ISO date (e.g. 2026-09-29 or 2026-09-29T00:00:00Z)" };
  if (since.getTime() > now.getTime()) return { ok: false, error: "since is in the future" };
  if (now.getTime() - since.getTime() > COP_REFETCH_MAX_AGE_DAYS * DAY_MS) {
    return { ok: false, error: `since must be within the last ${COP_REFETCH_MAX_AGE_DAYS} days` };
  }
  let before: Date | null = null;
  if (b.before !== undefined && b.before !== null) {
    before = parseIsoDate(b.before);
    if (before == null) return { ok: false, error: "before must be an ISO date" };
    if (before.getTime() <= since.getTime()) return { ok: false, error: "before must be after since" };
  }
  return { ok: true, since, before };
}

function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The lastResult / log line for a walk: "cop: +3 new / 2 updated / 41 seen", the page count when it took more
 *  than one, and a loud TRUNCATED when the page bound cut it short. PURE. */
export function summarizeCopFetch(s: CopFetchSummary): string {
  let out = `cop: +${s.inserted} new / ${s.updated} updated / ${s.fetched} seen`;
  if (s.pages > 1 || s.truncated) out += ` (${s.pages} pages${s.truncated ? `, TRUNCATED at the page bound — rows older than ${s.oldest ?? "?"} not fetched` : ""})`;
  return out;
}

/** The endpoint's rows → store points; a row without a parseable timestamp is dropped. PURE. */
export function toCopPoints(body: CopMeasurementsResponse | null | undefined): CopPoint[] {
  return (body?.measurements ?? [])
    .filter((m) => typeof m.timestamp === "string" && !Number.isNaN(new Date(m.timestamp).getTime()))
    .map((m) => ({
      measuredAt: new Date(m.timestamp as string),
      system: `${m.systemType ?? "unknown"}:${m.systemId ?? "unknown"}`,
      outdoorTempF: numOrNull(m.outdoorTempF),
      sinkTempF: numOrNull(m.sinkTempF),
      cop: numOrNull(m.cop),
      thermalKwh: numOrNull(m.thermalKwh),
      electricalKwh: numOrNull(m.electricalKwh),
      quality: m.confidence ?? null,
      qualityScore: numOrNull(m.qualityScore),
    }));
}

function emptyCopSummary(since: Date, before: Date | null): CopFetchSummary {
  return {
    since: since.toISOString(), before: before ? before.toISOString() : null,
    fetched: 0, inserted: 0, updated: 0, pages: 0, oldest: null, newest: null, truncated: false,
  };
}

export class TempiqReader {
  private lastFetchAt: string | null = null;
  private lastResult: string | null = null;
  private consecutiveFailures = 0;
  private readonly copOverlapDays: number;
  private copRefetchInFlight = false;
  private lastCopRefetch: CopRefetchSummary | null = null;

  constructor(
    private readonly store: Store,
    private readonly baseUrl: string,
    private readonly token: string,
    opts: { copOverlapDays?: number } = {},
  ) {
    const d = opts.copOverlapDays;
    this.copOverlapDays = typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : COP_OVERLAP_DAYS_DEFAULT;
  }

  status(): TempiqReadStatus {
    return {
      enabled: true,
      lastFetchAt: this.lastFetchAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      copOverlapDays: this.copOverlapDays,
      lastCopRefetch: this.lastCopRefetch,
    };
  }

  /** One read tick: pull the insight endpoints, persist each. Never throws. */
  async tick(): Promise<void> {
    const results: string[] = [];
    let failed = 0;

    try {
      results.push(await this.fetchZones());
    } catch (e) {
      failed++;
      results.push(`zones error: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      results.push(await this.fetchCopMeasurements());
    } catch (e) {
      failed++;
      results.push(`cop error: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      results.push(await this.fetchZoneEnergy());
    } catch (e) {
      failed++;
      results.push(`zone-energy error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ADVISORY (#33): spatial world-model. NOT one of the 3 critical endpoints — a hiccup logs but
    // must not inflate the failure streak / alerting, so it never touches `failed`.
    try {
      results.push(await this.fetchSpatialGraph());
    } catch (e) {
      results.push(`spatial error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ADVISORY (gtm#1431): DHW-vs-space-isolated usage aggregate. Pure enrichment — a 404 (endpoint not
    // deployed yet) or available:false must NOT inflate the failure streak, so it lives here, not above.
    try {
      results.push(await this.fetchDhwUsage());
    } catch (e) {
      results.push(`dhw error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ADVISORY (wave plan B2b): the winter scoreboard. Same contract as dhw — a 404 before TempIQ #2063 deploys or
    // available:false before the first rated week must not inflate the failure streak.
    try {
      results.push(await this.fetchWinterScoreboard());
    } catch (e) {
      results.push(`scoreboard error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (failed < 3) this.lastFetchAt = new Date().toISOString();
    this.lastResult = results.join(", ");
    if (failed === 0) {
      this.consecutiveFailures = 0;
      console.log(`[tempiq-read] ${this.lastResult}`);
    } else {
      // Hourly cadence — every failing tick is worth a line; the next tick retries
      // and overlapping re-fetches are idempotent (upserts + PK dedupe).
      this.consecutiveFailures++;
      console.error(`[tempiq-read] ${this.lastResult} (streak ${this.consecutiveFailures})`);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Per-zone learned envelope physics → tempiq_zone_physics (upsert latest per zone). */
  private async fetchZones(): Promise<string> {
    const body = await this.get<ZonesResponse>("/api/insights/zones");
    const rows = (body.zones ?? [])
      .filter((z) => typeof z.zoneId === "string" && z.zoneId.length > 0)
      .map((z) => ({
        zoneId: z.zoneId as string,
        name: z.zoneName ?? null,
        uaBtuHrF: numOrNull(z.envelope?.ua),
        thermalMassBtuF: numOrNull(z.envelope?.thermalMass),
        emitterType: z.deliveryType ?? null,
        confidence: numOrNull(z.envelope?.confidence),
        source: z.envelope?.source ?? null,
      }));
    await this.store.upsertTempiqZonePhysics(rows);
    return `zones: ${rows.length}`;
  }

  /** COP points from (newest stored − COP_OVERLAP_DAYS; 7d back on an empty table) → tempiq_cop_points, upserted,
   *  paged until the endpoint has nothing older in the window. */
  private async fetchCopMeasurements(): Promise<string> {
    const newest = await this.store.latestTempiqCopAt();
    const since = copFetchSince(newest, new Date(), this.copOverlapDays);
    const s = emptyCopSummary(since, null);
    await this.walkCopPagesInto(s, since, null, COP_TICK_MAX_PAGES);
    return summarizeCopFetch(s);
  }

  /** Walk GET /api/insights/cop-measurements over [since, before) newest-first, upserting each page as it arrives
   *  and accumulating into `s` (so a caller that catches an error mid-walk still has the counts that landed).
   *  The endpoint orders by timestamp desc, applies since inclusive / before exclusive, and caps a page at 2000
   *  rows — one call can therefore truncate silently, which is why we page: the next page's `before` is this
   *  page's oldest timestamp + 1 ms, so rows from another system that share the boundary timestamp REPEAT (and
   *  upsert as unchanged) rather than drop. Stops on an empty or short page (nothing older in the window), at
   *  `since`, when a page makes no progress (every row one timestamp), or at `maxPages` — then `truncated`. */
  private async walkCopPagesInto(s: CopFetchSummary, since: Date, beforeStart: Date | null, maxPages: number): Promise<void> {
    let before = beforeStart;
    let oldest: Date | null = s.oldest ? new Date(s.oldest) : null;
    let newest: Date | null = s.newest ? new Date(s.newest) : null;
    let more = false;
    while (s.pages < maxPages) {
      more = false;
      const q = `since=${encodeURIComponent(since.toISOString())}` +
        (before ? `&before=${encodeURIComponent(before.toISOString())}` : "") +
        `&limit=${COP_PAGE_LIMIT}`;
      const body = await this.get<CopMeasurementsResponse>(`/api/insights/cop-measurements?${q}`);
      s.pages++;
      const rows = body?.measurements ?? [];
      if (rows.length === 0) break;
      const points = toCopPoints(body);
      const r = await this.store.insertTempiqCopPoints(points);
      s.fetched += points.length;
      s.inserted += r.inserted;
      s.updated += r.updated;
      let pageOldest: Date | null = null;
      for (const p of points) {
        if (pageOldest == null || p.measuredAt.getTime() < pageOldest.getTime()) pageOldest = p.measuredAt;
        if (oldest == null || p.measuredAt.getTime() < oldest.getTime()) oldest = p.measuredAt;
        if (newest == null || p.measuredAt.getTime() > newest.getTime()) newest = p.measuredAt;
      }
      s.oldest = oldest ? oldest.toISOString() : null;
      s.newest = newest ? newest.toISOString() : null;
      if (rows.length < COP_PAGE_LIMIT) break; // a short page: the endpoint has nothing older in [since, before)
      if (pageOldest == null || pageOldest.getTime() <= since.getTime()) break; // reached the lower bound
      const next = new Date(pageOldest.getTime() + 1); // exclusive bound re-includes the boundary timestamp's rows
      if (before != null && next.getTime() >= before.getTime()) break; // no progress — a whole page at one timestamp
      before = next;
      more = true;
    }
    s.truncated = more;
  }

  /** Whether a one-off refetch is running on this instance (the route answers 409 rather than doubling the load). */
  refetchInFlight(): boolean {
    return this.copRefetchInFlight;
  }

  /** One-off (POST /api/tempiq/cop-refetch): the same walk from an explicit `since` (and optional exclusive
   *  `before`), bounded at COP_REFETCH_MAX_PAGES, run inline on the caller's request with the same 20 s per-request
   *  timeout as the tick. Never throws: an HTTP/store error ends the walk and is reported with the partial counts
   *  (the route answers 502 then). The summary is kept for /health.tempiq_read.lastCopRefetch. The hourly tick is
   *  unaffected — both paths upsert idempotently, so overlapping with it is harmless. */
  async refetchCop(since: Date, before: Date | null): Promise<CopRefetchSummary> {
    const startedAt = new Date();
    const s: CopRefetchSummary = {
      ...emptyCopSummary(since, before),
      startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), durationMs: 0, error: null,
    };
    this.copRefetchInFlight = true;
    try {
      await this.walkCopPagesInto(s, since, before, COP_REFETCH_MAX_PAGES);
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.copRefetchInFlight = false;
    }
    const finishedAt = new Date();
    s.finishedAt = finishedAt.toISOString();
    s.durationMs = finishedAt.getTime() - startedAt.getTime();
    this.lastCopRefetch = s;
    const line = `[tempiq-read] cop-refetch since=${s.since}${s.before ? ` before=${s.before}` : ""}: ${summarizeCopFetch(s)} in ${s.durationMs} ms`;
    if (s.error) console.error(`${line} — stopped: ${s.error}`);
    else console.log(line);
    return s;
  }

  /** Latest zone-energy snapshot (whole response JSON) → tempiq_zone_energy row 1. */
  private async fetchZoneEnergy(): Promise<string> {
    const body = await this.get<Record<string, unknown>>("/api/insights/zone-energy");
    await this.store.upsertTempiqZoneEnergy(body);
    return "zone-energy: snapshot";
  }

  /** ADVISORY (TempIQv2#1600 / kanban a2w-control#33): pull the spatial world-model and LOG the
   * "which zones share warmth" adjacency signal for safe-setback reasoning. Read-only observability —
   * it does NOT touch the demand-floor / buffer-control decision (that integration is a separate,
   * owner-reviewed step). Consumes GET /api/insights/spatial-graph (TempIQv2#1651). */
  private async fetchSpatialGraph(): Promise<string> {
    const graph = await fetchInsightSpatialGraph(this.baseUrl, this.token);
    console.log(`[tempiq-read] warm-adjacency (advisory): ${summarizeWarmAdjacency(graph)}`);
    return `spatial: ${graph.edges.length} edges`;
  }

  /** ADVISORY (gtm#1431): DHW-vs-space-ISOLATED usage aggregate → tempiq_dhw_usage (row-1 snapshot).
   * TempIQ's #1279 recharge-calorimetry already separates DHW energy from radiant/baseboard — which our
   * local tank-drop draw inference (dhw.ts) CAN'T do once winter space-heat calls also drop the buffer.
   * Enrichment + observability ONLY: it never feeds the I8 sanitize decision (that stays thermal) or any
   * control path. `available:false` (200) = no estimate yet; a 404 = TempIQ hasn't deployed PR #1816 yet
   * — both are fine (this endpoint is in the advisory tier, so neither inflates the failure streak). */
  private async fetchDhwUsage(): Promise<string> {
    const body = await this.get<DhwUsageResponse>("/api/insights/dhw-usage");
    await this.store.upsertTempiqDhwUsage({ ...body, fetchedAt: new Date().toISOString() });
    if (body?.available === false) return "dhw: unavailable";
    const e = body?.estimate ?? null;
    const daily = numOrNull(e?.dailyElectricalKwh);
    const cyc = numOrNull(e?.cycleCount);
    return `dhw: ${daily != null ? `${daily.toFixed(1)}kWh/d` : "?"}${cyc != null ? `, ${cyc} cyc` : ""}${e?.stale ? " (stale)" : ""}`;
  }

  /** Winter scoreboard (wave plan B2b) → tempiq_winter_scoreboard row 1. Whole body persisted; summary for the log. */
  private async fetchWinterScoreboard(): Promise<string> {
    const body = await this.get<WinterScoreboardResponse>("/api/insights/winter-scoreboard");
    await this.store.upsertTempiqWinterScoreboard({ ...body, fetchedAt: new Date().toISOString() });
    return summarizeWinterScoreboard(body);
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
