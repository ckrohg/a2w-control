/**
 * @purpose W0-2 demand engine (plan §6.9) — TempIQ insights client + per-zone service-floor
 * math. Turns TempIQ's learned zone models (UA, thermal mass, delivery type) into the
 * minimum average water temperature each zone needs at the current outdoor temp, then
 * picks the binding (hottest) calling zone and adds the buffer→emitter margin to get a
 * tank target. DEGRADED MODE IS THE DEFAULT POSTURE: when the TempIQ feed is stale or has
 * never succeeded, proposeFloor returns null and callers fall back to the HBX reset curve
 * — A2W never depends on TempIQ to heat the house.
 */

export interface InsightZone {
  id: string;
  name: string;
  deliveryType: string; // "baseboard" | "radiant_floor" | "mini_split" | "dhw" | ...
  uaBtuHrF: number | null;
  thermalMassBtuF: number | null;
  confidence: number | null;
}

export interface ZoneFloor {
  zoneId: string;
  name: string;
  deliveryType: string;
  awtF: number | null;
  calling: boolean;
}

export interface FloorResult {
  perZone: ZoneFloor[];
  bindingZone: string | null; // zone NAME with the highest active floor
  bindingAwtF: number | null;
  tankTargetF: number | null; // bindingAwtF + BUFFER_MARGIN_F, rounded to 1 decimal
}

/** Buffer→emitter margin, °F (plan §6.9; measure via reg 2051 later). */
export const BUFFER_MARGIN_F = 4.5;

const HEALTHY_WINDOW_MS = 30 * 60_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Minimum average water temp (°F) the delivery type needs at this outdoor temp, or null
 * for emitters that don't draw on the buffer tank (mini-splits) or whose floors live
 * elsewhere (DHW/sanitize → shadow.ts).
 */
export function requiredAwtF(deliveryType: string, outdoorF: number, roomF = 68): number | null {
  switch (deliveryType) {
    case "baseboard": {
      const f = clamp((65 - outdoorF) / 60, 0, 1);
      const awt = roomF + (135 - roomF) * Math.pow(f, 1 / 1.35);
      return Math.max(awt, 108); // fin-tube convection floor
    }
    case "radiant_floor":
    case "underfloor":
      return 95 + ((55 - clamp(outdoorF, 5, 55)) / 50) * 15;
    default:
      return null;
  }
}

/**
 * Per-zone floors + binding zone. callingZoneIds === null means no live call feed yet
 * (TempIQ#1506): conservatively treat every zone with a non-null floor as calling.
 */
export function computeFloors(
  zones: InsightZone[],
  callingZoneIds: string[] | null,
  outdoorF: number,
): FloorResult {
  const perZone: ZoneFloor[] = zones.map((z) => {
    const awtF = requiredAwtF(z.deliveryType, outdoorF);
    const calling = callingZoneIds === null ? awtF !== null : callingZoneIds.includes(z.id);
    return { zoneId: z.id, name: z.name, deliveryType: z.deliveryType, awtF, calling };
  });

  let binding: ZoneFloor | null = null;
  for (const zf of perZone) {
    if (!zf.calling || zf.awtF === null) continue;
    if (binding === null || zf.awtF > (binding.awtF as number)) binding = zf;
  }

  if (binding === null || binding.awtF === null) {
    return { perZone, bindingZone: null, bindingAwtF: null, tankTargetF: null };
  }
  return {
    perZone,
    bindingZone: binding.name,
    bindingAwtF: binding.awtF,
    tankTargetF: Math.round((binding.awtF + BUFFER_MARGIN_F) * 10) / 10,
  };
}

/** GET {baseUrl}/api/insights/zones with a bearer token; defensive field mapping. */
export async function fetchInsightZones(baseUrl: string, token: string): Promise<InsightZone[]> {
  const res = await fetch(`${baseUrl}/api/insights/zones`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`tempiq insights: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const raw = Array.isArray(body)
    ? body
    : Array.isArray((body as { zones?: unknown[] })?.zones)
      ? (body as { zones: unknown[] }).zones
      : [];
  return raw.map((z) => {
    const o = (z ?? {}) as Record<string, unknown>;
    return {
      id: typeof o.id === "string" ? o.id : String(o.id ?? ""),
      name: typeof o.name === "string" ? o.name : "",
      deliveryType: typeof o.deliveryType === "string" ? o.deliveryType : "",
      uaBtuHrF: typeof o.uaBtuHrF === "number" ? o.uaBtuHrF : null,
      thermalMassBtuF: typeof o.thermalMassBtuF === "number" ? o.thermalMassBtuF : null,
      confidence: typeof o.confidence === "number" ? o.confidence : null,
    };
  });
}

/**
 * Cached TempIQ zone feed with a 30-minute health window. refresh() never throws;
 * proposeFloor() returns null whenever the feed is unhealthy (degraded mode, §6.9).
 */
export class DemandFeed {
  private cached: InsightZone[] = [];
  private lastSuccessAt: Date | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  async refresh(): Promise<void> {
    try {
      this.cached = await fetchInsightZones(this.baseUrl, this.token);
      this.lastSuccessAt = new Date();
    } catch (err) {
      console.warn(`[demand] TempIQ zone refresh failed: ${(err as Error).message}`);
    }
  }

  isHealthy(): boolean {
    return (
      this.lastSuccessAt !== null && Date.now() - this.lastSuccessAt.getTime() < HEALTHY_WINDOW_MS
    );
  }

  zones(): InsightZone[] {
    return this.cached;
  }

  proposeFloor(outdoorF: number, callingZoneIds?: string[] | null): FloorResult | null {
    if (!this.isHealthy()) return null; // degraded mode: A2W never depends on TempIQ
    return computeFloors(this.cached, callingZoneIds ?? null, outdoorF);
  }

  status(): { healthy: boolean; zoneCount: number; lastSuccessAt: string | null } {
    return {
      healthy: this.isHealthy(),
      zoneCount: this.cached.length,
      lastSuccessAt: this.lastSuccessAt ? this.lastSuccessAt.toISOString() : null,
    };
  }
}
