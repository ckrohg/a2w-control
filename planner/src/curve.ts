/**
 * @purpose #133 (b): a demand-SHAPED reset curve instead of a flat target. setTarget emulates a fixed
 * target with a near-flat line, so when the planner dies the HBX holds one number for the whole
 * winter — the as-found weather compensation is gone. A shaped curve makes the fallback correct by
 * construction: the device compensates for outdoor on its own between planner writes and after a
 * planner death, and hour-of-day shaping (bank, soak, storm, identification probes) rides on top as
 * short bounded excursions that already exist (boost() with durable restore_at; identify.ts cleanup).
 *
 * The line has two device endpoints — dbt at `dot` (the design outdoor) and mbt at `wwsd` (warm-weather
 * shutdown, 125 °F on this HBX). wwsd is never moved (the device shuts heating OFF above it; the radiant
 * zones need heat at 50 °F). dot IS moved: the I4 envelope's lower bound is a steep line (135 °F at 5 °F
 * outdoor, 111 at 35, 95 at 55), so any endpoint parked at 5 °F is pinned to 135 and the straight line
 * to the floor at 125 °F runs 11 °F hot at 35 °F — a COP tax every mild day. Instead the design point
 * is set at the COLDEST OUTDOOR EXPECTED IN THE HORIZON minus a margin (`anchorOutdoorF` − ANCHOR_MARGIN_F,
 * the auto-pilot refreshes it from the forecast minimum), with dbt = demand there, floored and clamped to
 * the envelope AT that outdoor. Within the horizon the line sits within a few °F of demand; for weather
 * colder than the design point the device holds dbt (a bounded under-service, only in a snap colder than
 * forecast − margin while the planner is ALSO dead — a double failure, and still far better than a flat
 * 120). `anchorOutdoorF` = 5 gives the conservative all-winter curve (dbt pinned at 135).
 *
 * Every endpoint is floored by dhwFloorF and clamped to the I4 envelope AT ITS OWN OUTDOOR (bandFor
 * against the as-found baseline curve, exactly as setTarget does). Pure; no I/O.
 */
import { computeFloors, type InsightZone, type FloorPolicy } from "./demand";
import { bandFor, curveTargetF, DEFAULT_OPTS } from "./shadow";

export const MIN_CURVE_SPREAD_F = 2;   // the device ignores a degenerate curve (dbt == mbt)
export const ANCHOR_MARGIN_F = 10;     // the design point sits this far below the forecast minimum
export const MIN_DOT_F = 5;            // the device's floor for the design outdoor
export const MIN_DOT_WWSD_GAP_F = 20;  // keep a real slope between the endpoints

export interface ShapedCurve {
  dbt: number;
  mbt: number;
  dot: number;
  wwsd: number;
  basis: {
    anchorOutdoorF: number;         // the forecast minimum the caller asked the curve to serve
    designOutdoorF: number;         // = dot: anchor − ANCHOR_MARGIN_F, bounded to [MIN_DOT_F, wwsd − gap]
    dbtDemandF: number;             // demand at the design point before floor/envelope
    dbtBinding: string | null;      // the zone that set it (null = no calling buffer-served zone → floor)
    dbtClampedBy: "floor" | "envelope_lo" | "envelope_hi" | null;
    mbtDemandF: number;             // demand at wwsd (the floor, in practice)
    mbtClampedBy: "floor" | "envelope_lo" | "envelope_hi" | null;
    conservative: boolean;          // callingZoneIds null → every buffer-served zone counts
    spreadForced: boolean;
  };
}

export interface ShapeCurveArgs {
  zones: InsightZone[];
  callingZoneIds: string[] | null;
  /** The device's warm-weather shutdown — never moved. */
  wwsd: number;
  /** The coldest outdoor the line must serve (forecast minimum over the horizon). Defaults to MIN_DOT_F (conservative). */
  anchorOutdoorF?: number;
  /** The AS-FOUND curve endpoints (writes.ts uses the baseline for the I4 ceiling once the live curve is ours). */
  hbxBaseline: Record<string, any> | null;
  dhwFloorF?: number;
  capF?: number;
  learnedSupply?: boolean;
  policy?: FloorPolicy;
}

function clampToEnvelope(targetF: number, outdoorF: number, hbxBaseline: Record<string, any> | null, capF: number): { value: number; clampedBy: "envelope_lo" | "envelope_hi" | null } {
  const band = bandFor(outdoorF, hbxBaseline, capF);
  if (targetF > band.hi) return { value: band.hi, clampedBy: "envelope_hi" };
  if (targetF < band.lo) return { value: band.lo, clampedBy: "envelope_lo" };
  return { value: targetF, clampedBy: null };
}

/** Demand at one outdoor: the binding calling zone's required AWT + buffer margin, floored by the DHW floor. */
export function demandTargetF(a: ShapeCurveArgs, outdoorF: number): { targetF: number; binding: string | null; flooredBy: "floor" | null } {
  const dhwFloorF = a.dhwFloorF ?? DEFAULT_OPTS.dhwFloorF;
  const floors = computeFloors(a.zones, a.callingZoneIds, outdoorF, a.learnedSupply ?? false, a.policy ?? "escalate");
  const demand = floors.tankTargetF;
  if (demand == null || demand < dhwFloorF) return { targetF: dhwFloorF, binding: floors.bindingZone, flooredBy: "floor" };
  return { targetF: demand, binding: floors.bindingZone, flooredBy: null };
}

export function shapeCurve(a: ShapeCurveArgs): ShapedCurve {
  const capF = a.capF ?? DEFAULT_OPTS.strictCapF;
  const anchorOutdoorF = a.anchorOutdoorF ?? MIN_DOT_F;
  const dot = Math.round(Math.min(Math.max(anchorOutdoorF - ANCHOR_MARGIN_F, MIN_DOT_F), a.wwsd - MIN_DOT_WWSD_GAP_F));
  const dbtDemand = demandTargetF(a, dot);
  const dbtClamp = clampToEnvelope(dbtDemand.targetF, dot, a.hbxBaseline, capF);
  const mbtDemand = demandTargetF(a, a.wwsd);
  const mbtClamp = clampToEnvelope(mbtDemand.targetF, a.wwsd, a.hbxBaseline, capF);
  const dbt = Math.round(dbtClamp.value);
  let mbt = Math.round(mbtClamp.value);
  let spreadForced = false;
  if (dbt - mbt < MIN_CURVE_SPREAD_F) {
    // A flat line is ignored by the device. Lower mbt rather than lift dbt: dbt is what demand (or the
    // envelope) says the cold end needs, and a slightly cooler warm-weather end costs nothing.
    mbt = dbt - MIN_CURVE_SPREAD_F;
    spreadForced = true;
  }
  return {
    dbt, mbt, dot, wwsd: a.wwsd,
    basis: {
      anchorOutdoorF, designOutdoorF: dot,
      dbtDemandF: Math.round(dbtDemand.targetF * 10) / 10, dbtBinding: dbtDemand.binding,
      dbtClampedBy: dbtClamp.clampedBy ?? dbtDemand.flooredBy,
      mbtDemandF: Math.round(mbtDemand.targetF * 10) / 10,
      mbtClampedBy: mbtClamp.clampedBy ?? mbtDemand.flooredBy,
      conservative: a.callingZoneIds === null,
      spreadForced,
    },
  };
}

/** The shaped curve's output at an outdoor temperature — what the HBX will drive to. */
export function curveOutputF(c: Pick<ShapedCurve, "dbt" | "mbt" | "dot" | "wwsd">, outdoorF: number): number {
  return curveTargetF({ dot: c.dot, wwsd: c.wwsd, dbt: c.dbt, mbt: c.mbt }, outdoorF) ?? c.mbt;
}

/** Two curves are the same command when both endpoints agree within the adoption tolerance. */
export function sameCurve(x: Pick<ShapedCurve, "dbt" | "mbt">, y: Pick<ShapedCurve, "dbt" | "mbt"> | null, toleranceF = 2): boolean {
  return y != null && Math.abs(x.dbt - y.dbt) <= toleranceF && Math.abs(x.mbt - y.mbt) <= toleranceF;
}
