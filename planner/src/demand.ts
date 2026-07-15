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
  // TempIQ#1508 delivery_type provenance: null = unknown (pre-#1582 TempIQ deploy),
  // false = seeded/unconfirmed (the floor math may be wrong — flag it), true = owner-verified.
  deliveryTypeVerified: boolean | null;
  uaBtuHrF: number | null;
  thermalMassBtuF: number | null;
  confidence: number | null;
}

/** Live per-zone call state from TempIQ GET /api/insights/calls (TempIQ#1506). The
 * endpoint already filters to the property's hydronic zones, so a mini-split can never
 * appear here — but we still match by zoneId against the /zones feed, never by type. */
export interface InsightCall {
  zoneId: string;
  hvacStatus: string | null; // "OFF" | "HEATING" | null (no recent reading)
}

export interface ZoneFloor {
  zoneId: string;
  name: string;
  deliveryType: string;
  awtF: number | null;
  calling: boolean;
  verified: boolean | null; // TempIQ#1508: is this zone's delivery_type owner-verified?
}

export interface FloorResult {
  perZone: ZoneFloor[];
  bindingZone: string | null; // zone NAME with the highest active floor
  bindingAwtF: number | null;
  tankTargetF: number | null; // bindingAwtF + BUFFER_MARGIN_F, rounded to 1 decimal
  // TempIQ#1508: is the BINDING zone's delivery_type owner-verified? false = the tank floor
  // is being set from a seeded/unconfirmed emitter type (may be wrong by 15-25°F) — surface it.
  bindingVerified: boolean | null;
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
    return { zoneId: z.id, name: z.name, deliveryType: z.deliveryType, awtF, calling, verified: z.deliveryTypeVerified };
  });

  let binding: ZoneFloor | null = null;
  for (const zf of perZone) {
    if (!zf.calling || zf.awtF === null) continue;
    if (binding === null || zf.awtF > (binding.awtF as number)) binding = zf;
  }

  if (binding === null || binding.awtF === null) {
    return { perZone, bindingZone: null, bindingAwtF: null, tankTargetF: null, bindingVerified: null };
  }
  return {
    perZone,
    bindingZone: binding.name,
    bindingAwtF: binding.awtF,
    tankTargetF: Math.round((binding.awtF + BUFFER_MARGIN_F) * 10) / 10,
    bindingVerified: binding.verified,
  };
}

/**
 * TempIQv2#1508 RESOLVED at source (migration 0150 / PR #1577, 2026-07-15): TempIQ prod
 * now returns delivery_type=baseboard for "Living Room Baseboard" (e849e306) — verified
 * live via /api/insights/zones. The temporary override is removed; TempIQ is the single
 * source of truth. ("Xmas Room" 09e75519 is correctly mini_split — no override needed.)
 * Env escape hatches EMITTER_OVERRIDES / EMITTER_SYNTHETIC_ZONES remain for future fixes.
 */
export const DEFAULT_EMITTER_OVERRIDES: Record<string, string> = {
  // empty — #1508 corrected delivery_type at the TempIQ source (migration 0150)
};
export const DEFAULT_SYNTHETIC_ZONES: InsightZone[] = [
  // empty — "Living Room Baseboard" IS the Xmas Room zone; a synthetic Xmas zone would duplicate it
];

function envJson<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[demand] ${name} is not valid JSON — using built-in ground truth`);
    return fallback;
  }
}

/** Correct TempIQ's zone list against the owner-surveyed emitter map. */
export function applyEmitterGroundTruth(
  zones: InsightZone[],
  overrides: Record<string, string> = envJson("EMITTER_OVERRIDES", DEFAULT_EMITTER_OVERRIDES),
  synthetic: InsightZone[] = envJson("EMITTER_SYNTHETIC_ZONES", DEFAULT_SYNTHETIC_ZONES),
): InsightZone[] {
  const out = zones.map((z) =>
    overrides[z.name] ? { ...z, deliveryType: overrides[z.name] } : z,
  );
  for (const s of synthetic) {
    if (!out.some((z) => z.id === s.id || z.name === s.name)) out.push({ ...s });
  }
  return out;
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
    // live payload shape (verified 2026-07-14, cf. tempiq-read.ts): zoneId, zoneName,
    // deliveryType, envelope.{ua, thermalMass, confidence}; older spec names kept as
    // fallbacks so a payload change degrades to nulls, never throws
    const env = (o.envelope ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      id: typeof o.zoneId === "string" ? o.zoneId : typeof o.id === "string" ? o.id : String(o.id ?? ""),
      name: typeof o.zoneName === "string" ? o.zoneName : typeof o.name === "string" ? o.name : "",
      deliveryType: typeof o.deliveryType === "string" ? o.deliveryType : "",
      // TempIQ#1508: only an EXPLICIT boolean counts; absent (pre-#1582 deploy) → null =
      // unknown (don't flag), false → seeded/unconfirmed (flag), true → owner-verified.
      deliveryTypeVerified: typeof o.deliveryTypeVerified === "boolean" ? o.deliveryTypeVerified : null,
      uaBtuHrF: num(env.ua) ?? num(o.uaBtuHrF),
      thermalMassBtuF: num(env.thermalMass) ?? num(o.thermalMassBtuF),
      confidence: num(env.confidence) ?? num(o.confidence),
    };
  });
}

/** GET {baseUrl}/api/insights/calls — live hvacStatus for the property's hydronic zones
 * (TempIQ#1506). Same defensive posture as fetchInsightZones: shape drift degrades to
 * nulls/[], never throws past the HTTP guard. */
export async function fetchInsightCalls(baseUrl: string, token: string): Promise<InsightCall[]> {
  const res = await fetch(`${baseUrl}/api/insights/calls`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`tempiq calls: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const raw = Array.isArray(body)
    ? body
    : Array.isArray((body as { zones?: unknown[] })?.zones)
      ? (body as { zones: unknown[] }).zones
      : [];
  return raw.map((z) => {
    const o = (z ?? {}) as Record<string, unknown>;
    return {
      zoneId:
        typeof o.zoneId === "string" ? o.zoneId : typeof o.id === "string" ? o.id : String(o.id ?? ""),
      hvacStatus: typeof o.hvacStatus === "string" ? o.hvacStatus : null,
    };
  });
}

/** Pure: IDs of zones actively calling for heat. HEATING is matched case-insensitively;
 * everything else (OFF, null, unknown) is treated as not-calling. */
export function deriveCallingZoneIds(calls: InsightCall[]): string[] {
  return calls
    .filter((c) => (c.hvacStatus ?? "").toUpperCase() === "HEATING")
    .map((c) => c.zoneId)
    .filter((id) => id.length > 0);
}

/**
 * Cached TempIQ zone + call feeds, each with an independent 30-minute health window.
 * refresh() never throws. proposeFloor() returns null when the zone feed is unhealthy
 * (degraded mode, §6.9). The call feed is separate on purpose: a /calls hiccup must NOT
 * zero the floor — it falls back to the conservative all-zones posture (callingZoneIds()
 * returns null, never []), so A2W never under-heats the house when TempIQ blips.
 */
export class DemandFeed {
  private cached: InsightZone[] = [];
  private lastSuccessAt: Date | null = null;
  private calls: InsightCall[] = [];
  private callsLastSuccessAt: Date | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  async refresh(): Promise<void> {
    // Zones and calls refresh independently — one failing must not taint the other's
    // freshness stamp (that is what keeps the safety fallback correct).
    try {
      this.cached = applyEmitterGroundTruth(await fetchInsightZones(this.baseUrl, this.token));
      this.lastSuccessAt = new Date();
    } catch (err) {
      console.warn(`[demand] TempIQ zone refresh failed: ${(err as Error).message}`);
    }
    try {
      this.calls = await fetchInsightCalls(this.baseUrl, this.token);
      this.callsLastSuccessAt = new Date();
    } catch (err) {
      console.warn(`[demand] TempIQ calls refresh failed: ${(err as Error).message}`);
    }
  }

  isHealthy(): boolean {
    return (
      this.lastSuccessAt !== null && Date.now() - this.lastSuccessAt.getTime() < HEALTHY_WINDOW_MS
    );
  }

  callsHealthy(): boolean {
    return (
      this.callsLastSuccessAt !== null &&
      Date.now() - this.callsLastSuccessAt.getTime() < HEALTHY_WINDOW_MS
    );
  }

  /**
   * Live calling set for proposeFloor. Returns null (NOT []) whenever the call feed is
   * unavailable or stale — the three-state contract computeFloors relies on: null →
   * conservative all-zones, [] → nobody calling → curve mimic.
   */
  callingZoneIds(): string[] | null {
    if (!this.callsHealthy()) return null;
    return deriveCallingZoneIds(this.calls);
  }

  zones(): InsightZone[] {
    return this.cached;
  }

  proposeFloor(outdoorF: number, callingZoneIds?: string[] | null): FloorResult | null {
    if (!this.isHealthy()) return null; // degraded mode: A2W never depends on TempIQ
    // Explicit arg wins (tests); otherwise ride the live call feed, falling back to the
    // conservative all-zones posture (null) when /calls is unhealthy.
    const calling = callingZoneIds !== undefined ? callingZoneIds : this.callingZoneIds();
    return computeFloors(this.cached, calling ?? null, outdoorF);
  }

  status(): {
    healthy: boolean;
    zoneCount: number;
    lastSuccessAt: string | null;
    callsHealthy: boolean;
    callingCount: number | null;
    callsLastSuccessAt: string | null;
  } {
    return {
      healthy: this.isHealthy(),
      zoneCount: this.cached.length,
      lastSuccessAt: this.lastSuccessAt ? this.lastSuccessAt.toISOString() : null,
      callsHealthy: this.callsHealthy(),
      callingCount: this.callingZoneIds()?.length ?? null,
      callsLastSuccessAt: this.callsLastSuccessAt ? this.callsLastSuccessAt.toISOString() : null,
    };
  }
}
