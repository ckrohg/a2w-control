/**
 * @purpose Consume TempIQ's per-zone required-supply FORECAST (issue #87; TempIQ gtm#1591,
 * shipped TempIQv2#2017) so the planner can pre-heat for a call already in progress instead
 * of chasing its ramp an hour late.
 *
 * ## What we built for, and what actually shipped
 *
 * This file was originally written against the A-8 contract's `/api/insights/demand-forecast`:
 * per zone-hour `p_call`, expected runtime, and a required supply temp. **That endpoint was
 * never built.** TempIQ's Phase 0 backtest gated it and returned STOP — scored against
 * persistence, 1 of 7 zones showed skill and it was the wrong one (Master Bathroom, 74.9%
 * duty, unverified), while Living Room Baseboard, the motivating zone, had zero structure at
 * any horizon. So call PREDICTION does not exist and is not coming.
 *
 * The survivor is `GET /api/insights/zones/required-supply-forecast`: for each owner-verified
 * hydronic zone, the same reset curve `/zones` already emits, evaluated at the FORECAST
 * outdoor of each persisted hour (48 h live, refreshed 6-hourly). It answers "how hot must
 * the water be at 03:00 IF this zone calls" — and says nothing whatever about whether it will.
 *
 * ## Why the confidence gate could not just be deleted
 *
 * The old code gated every floor on `pCall * confidence >= threshold`. That gate was not
 * decoration: it was the only thing stopping EVERY verified zone from setting a floor for
 * EVERY hour. Dropping it and keeping the rest would silently turn pre-heat into the
 * conservative all-zones future floor — the hottest verified emitter's requirement, 24 h a
 * day — whose idle-baseboard cost is already a stated blocker for the winter DP going live
 * (`knowledge/reference/winter-dp-commissioning.md`, criterion 5). A cost regression wearing
 * a feature's clothes.
 *
 * So the probability gate is replaced by LIVE EVIDENCE, which is the #90 doctrine applied to
 * the time axis: **only a zone that is CALLING NOW earns a forecast-driven raise, and only
 * for its own requirement.** That is not predicting a call; it is anticipating the ramp of a
 * call already in progress. With nothing calling — or with the call feed unhealthy — nothing
 * is raised and the planner behaves exactly as it does today.
 *
 * Note the deliberate asymmetry with `computeFloors`, where a null call feed conservatively
 * treats every zone as calling: there the fallback direction is SAFE (a live requirement,
 * clamped). Here the raise is speculative, so a null call feed must mean "raise nothing".
 *
 * The two original invariants survive unchanged:
 *
 *   1. RAISES ONLY. A forecast may lift a future block's target; it may never lower or
 *      suppress the reactive floor a live call produces.
 *   2. VERIFIED ZONES ONLY. TempIQ now omits unverified zones itself (`omittedReason:
 *      "unverified"`), but we keep our own gate as defence in depth — pre-heating on a
 *      seeded delivery type could be wrong by 15-25°F (TempIQ#1508).
 */

import { BUFFER_MARGIN_F } from "./demand";
import type { ShadowBlock } from "./shadow";

/** One forecast hour for one zone. */
export interface ForecastHour {
  start: string;              // ISO, hour-aligned (payload: targetTimestamp)
  outdoorF: number | null;    // the forecast outdoor this requirement was evaluated at
  requiredSupplyF: number | null;
  vintage: string | null;     // when the weather forecast behind this hour was generated
}

export interface ForecastZone {
  id: string;
  name: string;
  deliveryType: string;
  /** TempIQ's own reason for emitting no hours: "no-curve" (non-hydronic) | "unverified". */
  omittedReason: string | null;
  hours: ForecastHour[];
}

export interface SupplyForecast {
  generatedAt: string;        // when TempIQ BUILT the response — not the weather vintage
  newestVintage: string | null;
  oldestVintage: string | null;
  hoursAvailable: number | null;
  degradeReason: string | null;
  zones: ForecastZone[];
}

/** A required-supply figure for one hour, and which zone drove it. */
export interface PredictedFloor {
  tankTargetF: number;
  zoneId: string;
  zoneName: string;
  requiredSupplyF: number;
}

const HORIZON_HOURS = 24;
/** Our own fetch freshness — we poll every cycle, so anything older is a fetch problem. */
const STALE_MS = 2 * 60 * 60_000;
/**
 * Weather-vintage tolerance. The upstream forecast refreshes 6-hourly, so a vintage of up
 * to ~6 h is NORMAL and must not read as unhealthy — the old 2 h window applied to
 * `generatedAt` would have been wrong here in a way that only showed up as permanent
 * degraded mode. 8 h = one refresh interval plus slack.
 */
const MAX_VINTAGE_MS = 8 * 60 * 60_000;

function hourKey(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 3_600_000);
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Tolerant parse: a shape change must degrade to null/[], never throw. */
export function parseForecast(raw: unknown): SupplyForecast | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const zonesRaw = Array.isArray(r.zones) ? (r.zones as Record<string, unknown>[]) : null;
  if (!zonesRaw) return null;
  const meta = (r.forecast ?? {}) as Record<string, unknown>;

  const zones: ForecastZone[] = [];
  for (const z of zonesRaw) {
    if (!z || typeof z !== "object") continue;
    const id = str(z.zoneId) ?? str(z.id);
    if (!id) continue;
    const hoursRaw = Array.isArray(z.hours) ? (z.hours as Record<string, unknown>[]) : [];
    const hours: ForecastHour[] = [];
    for (const h of hoursRaw) {
      if (!h || typeof h !== "object") continue;
      const start = str(h.targetTimestamp) ?? str(h.start);
      if (!start || Number.isNaN(hourKey(start))) continue;
      hours.push({
        start,
        outdoorF: num(h.outdoorF),
        requiredSupplyF: num(h.requiredSupplyWaterTempF) ?? num(h.requiredSupplyF),
        vintage: str(h.forecastGeneratedAt),
      });
    }
    zones.push({
      id,
      name: str(z.zoneName) ?? str(z.name) ?? id,
      deliveryType: str(z.deliveryType) ?? "",
      omittedReason: str(z.omittedReason),
      hours,
    });
  }
  return {
    generatedAt: str(r.generatedAt) ?? new Date().toISOString(),
    newestVintage: str(meta.newestVintage),
    oldestVintage: str(meta.oldestVintage),
    hoursAvailable: num(meta.hoursAvailable),
    degradeReason: str(meta.degradeReason),
    zones,
  };
}

export async function fetchSupplyForecast(
  baseUrl: string,
  token: string,
  hours = HORIZON_HOURS,
): Promise<SupplyForecast | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/insights/zones/required-supply-forecast?hours=${hours}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`required-supply-forecast HTTP ${res.status}`);
  return parseForecast(await res.json());
}

/**
 * The hottest required supply for one hour among the zones that pass both filters.
 *
 * `verifiedZoneIds` is the TempIQ#1508 provenance gate. `zoneIds` is the EVIDENCE filter —
 * pass the zones calling now to get a pre-heat requirement, or null to ask the unconditional
 * capacity question (what the hottest verified zone would need), which is monitoring only and
 * must never drive a commanded target.
 */
export function predictedFloorForHour(
  forecast: SupplyForecast,
  hourIso: string,
  opts: { verifiedZoneIds: Set<string> | null; zoneIds: Set<string> | null },
): PredictedFloor | null {
  const key = hourKey(hourIso);
  if (Number.isNaN(key)) return null;
  let best: PredictedFloor | null = null;
  for (const z of forecast.zones) {
    if (opts.verifiedZoneIds && !opts.verifiedZoneIds.has(z.id)) continue;
    if (opts.zoneIds && !opts.zoneIds.has(z.id)) continue;
    for (const h of z.hours) {
      if (h.requiredSupplyF === null) continue;
      if (hourKey(h.start) !== key) continue;
      if (best && h.requiredSupplyF <= best.requiredSupplyF) continue;
      best = {
        tankTargetF: Math.round((h.requiredSupplyF + BUFFER_MARGIN_F) * 10) / 10,
        zoneId: z.id,
        zoneName: z.name,
        requiredSupplyF: h.requiredSupplyF,
      };
    }
  }
  return best;
}

/**
 * Earliest forecast hour whose required tank temp exceeds the everyday cap — the afternoon
 * warning that tonight will want more than strictCapF, instead of discovering it at 2 am via
 * the reactive 3-hour-pinned streak (#59 cap watch).
 *
 * Deliberately UNGATED by live calls: this is a capacity question ("if these emitters are
 * asked to work tonight, the cap is short"), it commands nothing, and gating it on what
 * happens to be calling this minute would silence the warning precisely in the mild hours
 * when it is still actionable.
 */
export function predictedCapRisk(
  forecast: SupplyForecast,
  capF: number,
  opts: { verifiedZoneIds: Set<string> | null },
): (PredictedFloor & { start: string }) | null {
  let earliest: (PredictedFloor & { start: string }) | null = null;
  for (const z of forecast.zones) {
    if (opts.verifiedZoneIds && !opts.verifiedZoneIds.has(z.id)) continue;
    for (const h of z.hours) {
      if (h.requiredSupplyF === null) continue;
      const need = Math.round((h.requiredSupplyF + BUFFER_MARGIN_F) * 10) / 10;
      if (need <= capF) continue;
      if (earliest && hourKey(h.start) >= hourKey(earliest.start)) continue;
      earliest = {
        start: h.start, tankTargetF: need, zoneId: z.id, zoneName: z.name,
        requiredSupplyF: h.requiredSupplyF,
      };
    }
  }
  return earliest;
}

/**
 * Cached forecast with an independent health window, mirroring DemandFeed: refresh never
 * throws, and every consumer treats "unhealthy" as "behave exactly as today".
 */
export class ForecastFeed {
  private cached: SupplyForecast | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
    private horizonHours = HORIZON_HOURS,
  ) {}

  async refresh(): Promise<void> {
    try {
      const f = await fetchSupplyForecast(this.baseUrl, this.token, this.horizonHours);
      if (f) {
        this.cached = f;
        this.lastSuccessAt = new Date();
        this.lastError = null;
      } else {
        this.lastError = "unparseable payload";
      }
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  /** Weather vintage age in ms, or null when the payload does not say. */
  vintageAgeMs(now = Date.now()): number | null {
    const v = this.cached?.newestVintage ?? this.cached?.oldestVintage ?? null;
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : now - ms;
  }

  isHealthy(): boolean {
    if (!this.cached || !this.lastSuccessAt) return false;
    if (Date.now() - this.lastSuccessAt.getTime() >= STALE_MS) return false;
    const age = this.vintageAgeMs();
    if (age !== null && age >= MAX_VINTAGE_MS) return false;
    return this.cached.zones.some((z) => z.hours.length > 0);
  }

  forecast(): SupplyForecast | null {
    return this.isHealthy() ? this.cached : null;
  }

  status(): Record<string, unknown> {
    const age = this.vintageAgeMs();
    return {
      healthy: this.isHealthy(),
      lastSuccessAt: this.lastSuccessAt ? this.lastSuccessAt.toISOString() : null,
      lastError: this.lastError,
      zoneCount: this.cached?.zones.length ?? 0,
      zonesWithHours: this.cached?.zones.filter((z) => z.hours.length > 0).length ?? 0,
      generatedAt: this.cached?.generatedAt ?? null,
      vintageAgeH: age === null ? null : Math.round((age / 3_600_000) * 10) / 10,
      degradeReason: this.cached?.degradeReason ?? null,
    };
  }
}

/** One pre-heat decision, recorded whether or not it was applied (shadow-first). */
export interface PreheatDecision {
  ts: string;          // plan block that would be / was lifted
  fromF: number;
  toF: number;
  zoneName: string;
  requiredSupplyF: number;
  lead: boolean;       // true = lifted as the LEAD hour for the next hour's requirement
  applied: boolean;
  skipped?: string;    // why it was not applied
}

/**
 * Forecast requirements for the CALLING zones, applied to a plan.
 *
 * For block i the requirement is max(hour i, hour i+1): the first term carries the hour
 * itself, the second pre-heats the hour BEFORE the requirement rises, so the tank is already
 * there when it does. Doing both in one pass avoids a sawtooth — lifting only the lead hour
 * would drop the target again exactly when it is needed.
 *
 * `callingZoneIds` is the evidence gate. Null (call feed unhealthy) or empty (nothing
 * calling) means NO raises: a speculative raise on unknown demand is exactly the cost this
 * design refuses. RAISES ONLY, never past the block's band ceiling, sanitize blocks left
 * alone. With apply=false nothing is mutated and the decisions are returned for shadow
 * accounting.
 */
export function planPreheat(
  plan: ShadowBlock[],
  forecast: SupplyForecast,
  opts: {
    verifiedZoneIds: Set<string> | null;
    callingZoneIds: string[] | null;
    ceilingFor: (block: ShadowBlock) => number;
    setpointFor: (targetF: number) => number;
    apply: boolean;
  },
): PreheatDecision[] {
  if (!opts.callingZoneIds || opts.callingZoneIds.length === 0) return [];
  const gate = {
    verifiedZoneIds: opts.verifiedZoneIds,
    zoneIds: new Set(opts.callingZoneIds),
  };
  const decisions: PreheatDecision[] = [];
  for (let i = 0; i < plan.length; i++) {
    const block = plan[i];
    const own = predictedFloorForHour(forecast, block.ts, gate);
    const next = i + 1 < plan.length ? predictedFloorForHour(forecast, plan[i + 1].ts, gate) : null;
    const driver = (own?.tankTargetF ?? 0) >= (next?.tankTargetF ?? 0) ? own : next;
    if (!driver) continue;
    const needed = driver.tankTargetF;
    if (needed <= block.tank_target_f) continue;
    const base = {
      ts: block.ts, fromF: block.tank_target_f, toF: needed, zoneName: driver.zoneName,
      requiredSupplyF: driver.requiredSupplyF, lead: driver === next && driver !== own,
    };
    if (/sanitize/i.test(block.reason)) {
      decisions.push({ ...base, applied: false, skipped: "sanitize block outranks" });
      continue;
    }
    const raised = Math.min(needed, opts.ceilingFor(block));
    if (raised <= block.tank_target_f) {
      decisions.push({ ...base, toF: raised, applied: false, skipped: "at band ceiling" });
      continue;
    }
    if (!opts.apply) {
      decisions.push({ ...base, toF: raised, applied: false, skipped: "shadow mode" });
      continue;
    }
    block.tank_target_f = Math.round(raised);
    // Same leading-setpoint treatment as the bank/DP/storm raises: the advisory HP line must
    // cover the raised target or the plan draws an I1-violating hour.
    block.hp1_setpoint_f = opts.setpointFor(block.tank_target_f);
    block.reason = base.lead
      ? `pre-heat: ${driver.zoneName} is calling and needs ${Math.round(driver.requiredSupplyF)}°F next hour`
      : `forecast demand: ${driver.zoneName} is calling and needs ${Math.round(driver.requiredSupplyF)}°F`;
    decisions.push({ ...base, toF: block.tank_target_f, applied: true });
  }
  return decisions;
}
