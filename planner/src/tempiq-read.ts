/**
 * @purpose TempIQ insights reader (plan §6.7 seam, TempIQ#1470 — SHIPPED 2026-07-14 as
 * TempIQv2 PR #1502; the read half of the seam whose push half is tempiq.ts). Every
 * READ_EVERY_MIN the planner pulls TempIQ's learned insights (surface-token bearer
 * auth) and persists them to the planner store:
 *   GET /api/insights/zones            → tempiq_zone_physics (per-zone UA BTU/hr/°F,
 *                                        thermal mass BTU/°F, emitter type, confidence
 *                                        + source — latest row per zone)
 *   GET /api/insights/cop-measurements → tempiq_cop_points (COP w/ outdoor + sink temps
 *                                        for the COP(outdoor, water) fit; insert-only,
 *                                        deduped on measured_at + system, incremental
 *                                        via ?since=<newest stored point, else 7d>)
 *   GET /api/insights/zone-energy      → tempiq_zone_energy (latest snapshot JSON,
 *                                        single-row upsert — shadow model picks fields)
 *   GET /api/insights/dhw-usage        → tempiq_dhw_usage (gtm#1431 — DHW-vs-space-ISOLATED
 *                                        usage aggregate; ADVISORY enrichment, single-row
 *                                        snapshot. Winter DHW load separation our local
 *                                        tank-drop inference can't do; NEVER gates control)
 *                                      → tempiq_dhw_events (gtm#1442 — the per-draw recharge
 *                                        stream on the SAME response; insert-only history so
 *                                        the quiet gaps between draws survive the snapshot)
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

const COP_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000; // first fetch reaches back 7 days
const COP_PAGE_LIMIT = 2000;
const DHW_DRAW_WINDOW_DAYS = 14; // draw-gap window — long enough to see a multi-day quiet spell

/** DHW draw-gap summary, surfaced on /health so the stagnation half of the Legionella condition is
 *  verifiable with one curl. Observability only — never gates the soak (issue #51 rule 4). */
export interface DhwDrawStatus {
  windowDays: number;
  eventCount: number;
  lastDrawAt: string | null;
  hoursSinceLastDraw: number | null;
  maxGapH: number | null;
}

export interface TempiqReadStatus {
  enabled: boolean;
  lastFetchAt: string | null;
  lastResult: string | null;
  consecutiveFailures: number;
  dhwDraws: DhwDrawStatus | null;
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
  // gtm#1442 (TempIQv2 PR #1827), added AFTER the #1816 aggregate this reader was built for: a real
  // per-draw recharge stream, newest-first, max 100. `at` is the draw ONSET — the only per-draw timing
  // on the whole insights surface. Energy only; TempIQ's gallons are post-mix tap volume from the
  // Streamlabs meter and are not exposed here (and coil-side gallons would need an unmeasured coil
  // outlet temp, whereas thermalKwh IS the coil-side draw with the mixing-valve term already cancelled).
  events?: Array<{ at?: string; energyKwh?: number | null; thermalKwh?: number | null }>;
}

export class TempiqReader {
  private lastFetchAt: string | null = null;
  private lastResult: string | null = null;
  private consecutiveFailures = 0;
  private dhwDraws: {
    lastDrawAt: Date | null; hoursSinceLastDraw: number | null;
    maxGapH: number | null; eventCount: number;
  } | null = null;

  constructor(
    private readonly store: Store,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  status(): TempiqReadStatus {
    const d = this.dhwDraws;
    return {
      enabled: true,
      lastFetchAt: this.lastFetchAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      dhwDraws: d
        ? {
            windowDays: DHW_DRAW_WINDOW_DAYS,
            eventCount: d.eventCount,
            lastDrawAt: d.lastDrawAt ? d.lastDrawAt.toISOString() : null,
            hoursSinceLastDraw: d.hoursSinceLastDraw == null ? null : Math.round(d.hoursSinceLastDraw * 10) / 10,
            maxGapH: d.maxGapH == null ? null : Math.round(d.maxGapH * 10) / 10,
          }
        : null,
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

  /** COP points since the newest stored one (7d back on first run) → tempiq_cop_points. */
  private async fetchCopMeasurements(): Promise<string> {
    const newest = await this.store.latestTempiqCopAt();
    const since = newest ?? new Date(Date.now() - COP_BACKFILL_MS);
    const body = await this.get<CopMeasurementsResponse>(
      `/api/insights/cop-measurements?since=${encodeURIComponent(since.toISOString())}&limit=${COP_PAGE_LIMIT}`,
    );
    const points = (body.measurements ?? [])
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
    const inserted = await this.store.insertTempiqCopPoints(points);
    return `cop: +${inserted}/${points.length}`;
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
    // Per-draw events → insert-only history, so the quiet GAPS between draws survive the single-row
    // snapshot above. Failing here must not lose the aggregate we just stored, hence the inner catch.
    let drew = "";
    const raw = Array.isArray(body?.events) ? body.events : [];
    const events = raw
      .map((ev) => ({
        at: ev?.at ? new Date(ev.at) : null,
        thermalKwh: numOrNull(ev?.thermalKwh),
        electricalKwh: numOrNull(ev?.energyKwh),
      }))
      .filter((ev): ev is { at: Date; thermalKwh: number | null; electricalKwh: number | null } =>
        ev.at != null && !isNaN(ev.at.getTime()));
    if (events.length) {
      try {
        const n = await this.store.insertTempiqDhwEvents(events);
        drew = `, draws +${n}/${events.length - n}dup`;
      } catch (e) {
        drew = `, draws failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    try {
      this.dhwDraws = await this.store.dhwDrawStats(DHW_DRAW_WINDOW_DAYS);
    } catch { /* observability only — never fail the tick over it */ }
    if (body?.available === false) return `dhw: unavailable${drew}`;
    const e = body?.estimate ?? null;
    const daily = numOrNull(e?.dailyElectricalKwh);
    const cyc = numOrNull(e?.cycleCount);
    return `dhw: ${daily != null ? `${daily.toFixed(1)}kWh/d` : "?"}${cyc != null ? `, ${cyc} cyc` : ""}${e?.stale ? " (stale)" : ""}${drew}`;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
