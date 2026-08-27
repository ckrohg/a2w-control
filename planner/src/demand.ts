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
  // TempIQ#1632 (live since TempIQ PR #1703): the zone's required supply-water temp at the
  // CURRENT outdoor, from TempIQ's per-zone reset curve (design outdoor, WWSD, design
  // supply anchor). Only emitted for owner-verified hydronic zones with fresh outdoor data
  // — null otherwise. NOW-conditions only: never reuse it for future hours.
  requiredSupplyF: number | null;
  // TempIQ gtm#1593 (live 2026-08-27): where the reset curve's design anchor came from —
  // "demonstrated_max" (this plant's measured p99), "measured" (a per-zone fitted
  // requirement, the U4 learner — no readers on their side yet), or "type_curve_default"
  // (a GENERIC textbook curve for the emitter type, measured nothing). null = pre-gtm#1593
  // payload. Read it before treating the ceiling as though it knows this house: see #89.
  ceilingSource: string | null;
  // Live room state from the payload's `demand` block — the EVIDENCE that decides how far
  // up the local→learned range we actually need to be (#89 / #90 cost-first policy).
  roomF: number | null;
  setpointF: number | null;
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
  learned: boolean; // TempIQ#1632: awtF came from TempIQ's learned reset curve, not the local model
  // #90: how much the ROOM's deficit added on top of the cheap local number, and the
  // deficit that bought it. escalatedF 0 with a live ceiling = the cheap number sufficed.
  escalatedF: number;
  deficitF: number;
  localF: number | null;   // what the local parametric model wanted
  ceilingF: number | null; // what TempIQ's capacity model wanted (the ceiling)
  // gtm#1593 provenance of ceilingF, persisted into zone_floor_snapshots so the winter
  // review can tell a MEASURED ceiling from a generic textbook one (#89). null when the
  // zone has no ceiling, or when TempIQ's payload predates gtm#1593.
  ceilingSource: string | null;
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

// The feed refreshes only at the top of each shadow cycle (SHADOW_EVERY_MIN, default 60),
// so "fresh" must cover a full cycle plus grace — a fixed 30 min window made
// /health.winter_solver read "degraded" for the back half of every hour even though every
// floor computation runs immediately after a refresh. The October commissioning playbook
// keys its daily check off that field (2026-08-23 winter-readiness audit).
const SHADOW_EVERY_MIN = Number(process.env.SHADOW_EVERY_MIN ?? "60");
const HEALTHY_WINDOW_MS = Math.max(35, SHADOW_EVERY_MIN + 5) * 60_000;

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
 * Cost-first supply temp for one zone (#90; owner direction 2026-08-24: "TempIQ's model is
 * not going to be optimized for the A2W operating costs — push back the excessive heating…
 * be conservative, no cold showers, house not cold, save as much money as possible").
 *
 * TempIQ's requiredSupplyWaterTempF is a CAPACITY model. This comment used to say its design
 * anchor was "this house's own demonstrated max — its as-found 154-165°F operation". That was
 * WRONG, twice over, and the correction matters because it changes what the number is:
 *
 *   - TempIQ's anchor query was broken (it named a non-existent column), so the anchor was
 *     never the measured max for ANY property — it silently fell back to a generic textbook
 *     curve, 180°F design supply for baseboard (their gtm#1592).
 *   - That bug is fixed and deployed, and the anchor is STILL the generic 180°F here: the
 *     corrected query cannot finish inside their 10s request-path query timeout, so it
 *     errors on every request and falls back exactly as before (gtm#1599, verified
 *     2026-08-27 against their prod DB — the real p99 is 164.7°F over 202,521 rows).
 *
 * So the ceiling we are served is an UNMEASURED generic curve for the emitter type, and
 * `ceilingSource` says so per-zone (gtm#1593). Consuming it directly would buy as-found
 * running costs on the strength of a textbook default. But our local parametric model is
 * equally unmeasured in the other direction, so we do not simply swap one guess for the
 * other — and if their anchor ever does start working it will then ratchet DOWNWARD off
 * our own control (#89), which is a different problem, not a reason to trust it now.
 *
 * The policy: START at the cheap local number, treat TempIQ's as a CEILING, and let the
 * ROOM decide where between them we actually sit. Every °F the room sits below its setpoint
 * buys ESCALATE_F_PER_DEG °F of extra supply temp, never past the learned ceiling. So a
 * zone that is keeping up costs us the cheap number; a zone that is genuinely falling
 * behind gets real heat within a cycle, on evidence rather than on a curve's assumption.
 *
 * Comfort is protected structurally, not by this function's judgment: the DHW floor is
 * unconditional and separate (no cold showers can come from here), escalation is upward,
 * and the HBX + backup element remain untouched underneath.
 */
export const ESCALATE_DEADBAND_F = 0.5; // ignore sub-half-degree noise around setpoint
export const ESCALATE_F_PER_DEG = 6;    // supply °F granted per °F of room deficit
export const ESCALATE_STEP_F = 6;       // supply °F per extra cycle of unbroken calling

/**
 * TWO independent kinds of evidence, because either can be missing:
 *
 *  - room deficit (setpoint − room). Precise, but the live payload's `demand.setpointF` is
 *    null whenever a zone is off, and we have never seen it populated in a heating season.
 *    Never assume it will be there.
 *  - call persistence. A zone still calling after N consecutive planner cycles is BY
 *    DEFINITION not keeping up, whatever the telemetry says. This is the backstop that
 *    makes the policy safe when room data is absent, stale, or null.
 *
 * Whichever asks for more heat wins. With neither available the zone simply pays the cheap
 * local number, and the unconditional DHW floor plus HBX/backup-element remain underneath.
 */
export function costFirstAwtF(
  localF: number | null,
  learnedF: number | null,
  roomF: number | null,
  setpointF: number | null,
  callStreak = 0, // consecutive cycles this zone has been calling (0 = not calling / unknown)
): { awtF: number | null; escalatedF: number; deficitF: number } {
  // No local model (non-hydronic) → nothing to floor on either path.
  if (localF === null) return { awtF: null, escalatedF: 0, deficitF: 0 };
  // No learned ceiling → the local model is all we have; never escalate past itself.
  const ceilingF = learnedF ?? localF;
  const deficitF = roomF != null && setpointF != null ? setpointF - roomF : 0;
  const fromDeficit = deficitF > ESCALATE_DEADBAND_F ? deficitF * ESCALATE_F_PER_DEG : 0;
  // First cycle of calling is free — that is just normal operation. Each ADDITIONAL
  // unbroken cycle says the current supply temp is not getting the room there.
  const fromStreak = Math.max(0, callStreak - 1) * ESCALATE_STEP_F;
  const bump = Math.max(fromDeficit, fromStreak);
  if (bump <= 0) {
    return { awtF: Math.min(localF, ceilingF), escalatedF: 0, deficitF: Math.max(0, deficitF) };
  }
  const awtF = Math.min(localF + bump, Math.max(localF, ceilingF));
  return { awtF, escalatedF: Math.max(0, awtF - localF), deficitF: Math.max(0, deficitF) };
}

/**
 * Per-zone floors + binding zone. callingZoneIds === null means no live call feed yet
 * (TempIQ#1506): conservatively treat every zone with a non-null floor as calling.
 * learnedSupply=true (TempIQ#1632) prefers the zone's TempIQ-learned required supply temp
 * over the local parametric model — ONLY valid when outdoorF is the CURRENT outdoor (the
 * learned value is computed at now-conditions); per-hour future floors must pass false.
 */
/** #90: how the learned (TempIQ) supply temp is used. "escalate" = cost-first default. */
export type FloorPolicy = "escalate" | "learned" | "local";

export function computeFloors(
  zones: InsightZone[],
  callingZoneIds: string[] | null,
  outdoorF: number,
  learnedSupply = false,
  policy: FloorPolicy = "escalate",
  callStreaks?: Map<string, number> | null,
): FloorResult {
  const perZone: ZoneFloor[] = zones.map((z) => {
    const localF = requiredAwtF(z.deliveryType, outdoorF);
    // The learned value only substitutes where the local model also considers the zone a
    // buffer-served emitter (localF !== null) — a mini-split can never gain a floor from it.
    const useLearned = learnedSupply && localF !== null && z.requiredSupplyF != null;
    // #90 cost-first: in "escalate" mode the learned number becomes a CEILING and the room's
    // own deficit decides how far toward it we go. "learned" reproduces the pre-#90 behavior
    // (consume TempIQ's number outright); "local" ignores it entirely.
    let awtF: number | null;
    let escalatedF = 0;
    let deficitF = 0;
    if (useLearned && policy === "escalate") {
      const r = costFirstAwtF(localF, z.requiredSupplyF, z.roomF, z.setpointF, callStreaks?.get(z.id) ?? 0);
      awtF = r.awtF; escalatedF = r.escalatedF; deficitF = r.deficitF;
    } else if (useLearned && policy === "learned") {
      awtF = z.requiredSupplyF as number;
    } else {
      awtF = localF;
    }
    const calling = callingZoneIds === null ? awtF !== null : callingZoneIds.includes(z.id);
    return { zoneId: z.id, name: z.name, deliveryType: z.deliveryType, awtF, calling,
      verified: z.deliveryTypeVerified, learned: useLearned,
      escalatedF, deficitF, localF, ceilingF: useLearned ? z.requiredSupplyF : null,
      ceilingSource: useLearned ? z.ceilingSource : null };
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
    const dem = (o.demand ?? {}) as Record<string, unknown>;
    const rc = (o.resetCurve ?? {}) as Record<string, unknown>;
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
      requiredSupplyF: num(o.requiredSupplyWaterTempF),
      ceilingSource: typeof rc.designSupplyFSource === "string" ? rc.designSupplyFSource : null,
      roomF: num(dem.currentTempF) ?? num(o.currentTempF),
      setpointF: num(dem.setpointF) ?? num(o.setpointF),
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

  proposeFloor(outdoorF: number, callingZoneIds?: string[] | null, learnedSupply = false, policy: FloorPolicy = "escalate", callStreaks?: Map<string, number> | null): FloorResult | null {
    if (!this.isHealthy()) return null; // degraded mode: A2W never depends on TempIQ
    // Explicit arg wins (tests); otherwise ride the live call feed, falling back to the
    // conservative all-zones posture (null) when /calls is unhealthy.
    const calling = callingZoneIds !== undefined ? callingZoneIds : this.callingZoneIds();
    return computeFloors(this.cached, calling ?? null, outdoorF, learnedSupply, policy, callStreaks);
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
