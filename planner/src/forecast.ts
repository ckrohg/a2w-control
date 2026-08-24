/**
 * @purpose A-8 demand-forecast client (issue #87; contract:
 * knowledge/reference/tempiq-demand-forecast-contract.md; TempIQ build: TempIQv2#2009).
 * Consumes TempIQ's PREDICTED per-zone calls so the planner can pre-heat before a
 * high-temp zone wakes up, instead of discovering the demand reactively an hour late.
 *
 * Same posture as demand.ts, and the same three-state discipline: the feed never throws,
 * goes unhealthy on staleness, and every consumer must behave exactly as it does today
 * when the forecast is absent. Two extra invariants specific to prediction:
 *
 *   1. RAISES ONLY. A prediction may lift a future block's target; it may never lower or
 *      suppress the reactive floor a live call produces. A wrong prediction costs a few
 *      kWh — never comfort.
 *   2. VERIFIED ZONES ONLY. Pre-heating on a seeded/unconfirmed delivery type could be
 *      wrong by 15-25°F (TempIQ#1508), so an unverified zone can predict, but can never
 *      command heat.
 */

import { BUFFER_MARGIN_F } from "./demand";
import type { ShadowBlock } from "./shadow";

/** One predicted hour for one zone (contract Phase 1). */
export interface DemandForecastHour {
  start: string; // ISO, hour-aligned
  pCall: number; // 0..1 probability the zone calls during this hour
  expectedRuntimeMin: number | null;
  // The zone's required supply temp at the FORECAST outdoor for THAT hour — the key
  // difference from TempIQ#1632's requiredSupplyF, which is now-conditions only.
  requiredSupplyF: number | null;
  basis: string; // "history" | "schedule" | "recovery"
  confidence: number; // 0..1 model confidence for this zone/hour
}

export interface ForecastZone {
  id: string;
  name: string;
  hours: DemandForecastHour[];
}

export interface DemandForecast {
  generatedAt: string;
  basisWindowDays: number | null;
  zones: ForecastZone[];
}

/** A predicted floor for one hour: which zone drives it and how confident we are. */
export interface PredictedFloor {
  tankTargetF: number;
  zoneId: string;
  zoneName: string;
  requiredSupplyF: number;
  pCall: number;
  confidence: number;
  basis: string;
}

const HORIZON_HOURS = 24;
// Predictions age out faster than the zone feed: a forecast generated more than 2 h ago
// has been overtaken by weather and occupancy (contract "degraded mode").
const STALE_MS = 2 * 60 * 60_000;

function hourKey(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 3_600_000);
}

/** Tolerant parse: an endpoint still in development must degrade, never throw. */
export function parseForecast(raw: unknown): DemandForecast | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const zonesRaw = Array.isArray(r.zones) ? r.zones : null;
  if (!zonesRaw) return null;
  const zones: ForecastZone[] = [];
  for (const z of zonesRaw as Record<string, unknown>[]) {
    if (!z || typeof z.id !== "string") continue;
    const hoursRaw = Array.isArray(z.hours) ? (z.hours as Record<string, unknown>[]) : [];
    const hours: DemandForecastHour[] = [];
    for (const h of hoursRaw) {
      if (!h || typeof h.start !== "string" || Number.isNaN(hourKey(h.start))) continue;
      const pCall = typeof h.p_call === "number" ? h.p_call : typeof h.pCall === "number" ? h.pCall : NaN;
      if (!Number.isFinite(pCall)) continue;
      const req = h.required_supply_f ?? h.requiredSupplyF;
      const conf = h.confidence;
      const runtime = h.expected_runtime_min ?? h.expectedRuntimeMin;
      hours.push({
        start: h.start,
        pCall: Math.min(1, Math.max(0, pCall)),
        expectedRuntimeMin: typeof runtime === "number" ? runtime : null,
        requiredSupplyF: typeof req === "number" ? req : null,
        basis: typeof h.basis === "string" ? h.basis : "history",
        // Absent confidence is treated as fully confident ONLY in the sense that the
        // pCall gate still governs; an endpoint that omits it is taken at its word.
        confidence: typeof conf === "number" ? Math.min(1, Math.max(0, conf)) : 1,
      });
    }
    zones.push({ id: z.id, name: typeof z.name === "string" ? z.name : z.id, hours });
  }
  return {
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : new Date().toISOString(),
    basisWindowDays: typeof r.basis_window_days === "number" ? r.basis_window_days : null,
    zones,
  };
}

export async function fetchDemandForecast(
  baseUrl: string,
  token: string,
  hours = HORIZON_HOURS,
): Promise<DemandForecast | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/insights/demand-forecast?hours=${hours}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`demand-forecast HTTP ${res.status}`);
  return parseForecast(await res.json());
}

/**
 * The predicted floor for one hour: the hottest zone whose predicted call clears the
 * confidence gate. Returns null when nothing clears — the caller then does exactly what
 * it does today.
 *
 * `verifiedZoneIds` is the TempIQ#1508 gate: pass the set of owner-verified hydronic
 * zones and an unverified zone can never command a pre-heat. Pass null to skip the gate
 * (shadow accounting only — never for a path that writes).
 */
export function predictedFloorForHour(
  forecast: DemandForecast,
  hourIso: string,
  opts: { threshold: number; verifiedZoneIds: Set<string> | null },
): PredictedFloor | null {
  const key = hourKey(hourIso);
  if (Number.isNaN(key)) return null;
  let best: PredictedFloor | null = null;
  for (const z of forecast.zones) {
    if (opts.verifiedZoneIds && !opts.verifiedZoneIds.has(z.id)) continue;
    for (const h of z.hours) {
      if (hourKey(h.start) !== key) continue;
      if (h.requiredSupplyF === null) continue;
      if (h.pCall * h.confidence < opts.threshold) continue;
      if (best && h.requiredSupplyF <= best.requiredSupplyF) continue;
      best = {
        tankTargetF: Math.round((h.requiredSupplyF + BUFFER_MARGIN_F) * 10) / 10,
        zoneId: z.id,
        zoneName: z.name,
        requiredSupplyF: h.requiredSupplyF,
        pCall: h.pCall,
        confidence: h.confidence,
        basis: h.basis,
      };
    }
  }
  return best;
}

/**
 * Earliest predicted hour whose required tank temp exceeds the everyday cap — the
 * afternoon warning that tonight will want more than strictCapF, instead of discovering
 * it at 2 am through the reactive 3-hour-pinned streak (#59 cap watch).
 */
export function predictedCapRisk(
  forecast: DemandForecast,
  capF: number,
  opts: { threshold: number; verifiedZoneIds: Set<string> | null },
): PredictedFloor & { start: string } | null {
  let earliest: (PredictedFloor & { start: string }) | null = null;
  for (const z of forecast.zones) {
    if (opts.verifiedZoneIds && !opts.verifiedZoneIds.has(z.id)) continue;
    for (const h of z.hours) {
      if (h.requiredSupplyF === null) continue;
      if (h.pCall * h.confidence < opts.threshold) continue;
      const need = Math.round((h.requiredSupplyF + BUFFER_MARGIN_F) * 10) / 10;
      if (need <= capF) continue;
      if (earliest && hourKey(h.start) >= hourKey(earliest.start)) continue;
      earliest = {
        start: h.start, tankTargetF: need, zoneId: z.id, zoneName: z.name,
        requiredSupplyF: h.requiredSupplyF, pCall: h.pCall, confidence: h.confidence, basis: h.basis,
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
  private cached: DemandForecast | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
    private horizonHours = HORIZON_HOURS,
  ) {}

  async refresh(): Promise<void> {
    try {
      const f = await fetchDemandForecast(this.baseUrl, this.token, this.horizonHours);
      if (f) {
        this.cached = f;
        this.lastSuccessAt = new Date();
        this.lastError = null;
      } else {
        this.lastError = "unparseable payload";
      }
    } catch (err) {
      // Expected until TempIQv2#2009 Phase 1 ships — a 404 must stay a quiet degraded
      // mode, not a recurring alarm.
      this.lastError = (err as Error).message;
    }
  }

  isHealthy(): boolean {
    return this.cached !== null && this.lastSuccessAt !== null
      && Date.now() - this.lastSuccessAt.getTime() < STALE_MS;
  }

  forecast(): DemandForecast | null {
    return this.isHealthy() ? this.cached : null;
  }

  status(): Record<string, unknown> {
    return {
      healthy: this.isHealthy(),
      lastSuccessAt: this.lastSuccessAt ? this.lastSuccessAt.toISOString() : null,
      lastError: this.lastError,
      zoneCount: this.cached?.zones.length ?? 0,
      generatedAt: this.cached?.generatedAt ?? null,
    };
  }
}

/** One pre-heat decision, recorded whether or not it was applied (shadow-first). */
export interface PreheatDecision {
  ts: string;          // plan block that would be / was lifted
  fromF: number;
  toF: number;
  zoneName: string;
  pCall: number;
  basis: string;
  lead: boolean;       // true = lifted as the LEAD hour for a call predicted next hour
  applied: boolean;
  skipped?: string;    // why it was not applied
}

/**
 * Predicted floors + their lead hour, applied to a plan.
 *
 * For block i the requirement is max(predicted floor for hour i, predicted floor for hour
 * i+1): the first term carries the hour the call is predicted in, the second pre-heats the
 * hour BEFORE it so the tank is already there when the zone wakes up (the up-to-an-hour
 * floor-raise latency this whole feature exists to remove). Doing both in one pass also
 * avoids a sawtooth — lifting only the lead hour would drop the target again exactly when
 * the call starts.
 *
 * RAISES ONLY, and never past the block's band ceiling. Sanitize blocks are left alone —
 * the soak already outranks every other raise. With apply=false nothing is mutated and the
 * decisions are returned for shadow accounting.
 */
export function planPreheat(
  plan: ShadowBlock[],
  forecast: DemandForecast,
  opts: {
    threshold: number;
    verifiedZoneIds: Set<string> | null;
    ceilingFor: (block: ShadowBlock) => number;
    setpointFor: (targetF: number) => number;
    apply: boolean;
  },
): PreheatDecision[] {
  const decisions: PreheatDecision[] = [];
  const gate = { threshold: opts.threshold, verifiedZoneIds: opts.verifiedZoneIds };
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
      pCall: driver.pCall, basis: driver.basis, lead: driver === next && driver !== own,
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
    // Same leading-setpoint treatment as the bank/DP/storm raises: the advisory HP line
    // must cover the raised target or the plan draws an I1-violating hour.
    block.hp1_setpoint_f = opts.setpointFor(block.tank_target_f);
    block.reason = base.lead
      ? `pre-heat: ${driver.zoneName} predicted to call next hour (${Math.round(driver.pCall * 100)}%, ${driver.basis})`
      : `predicted demand: ${driver.zoneName} needs ${Math.round(driver.requiredSupplyF)}°F (${Math.round(driver.pCall * 100)}%, ${driver.basis})`;
    decisions.push({ ...base, toF: block.tank_target_f, applied: true });
  }
  return decisions;
}
