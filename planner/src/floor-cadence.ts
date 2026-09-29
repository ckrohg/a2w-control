/**
 * @purpose #136: decouple demand-floor DETECTION from the hourly REPLAN.
 *
 * The demand floor (demand.ts) was computed once per shadow cycle (60 min), so a zone that starts
 * calling at :05 could not move the tank target until the next replan — up to an hour — and then
 * escalated +6 °F per CYCLE. Two pure pieces make a 5-minute re-check safe:
 *
 *  1. `advanceCallMinutes` keeps per-zone UNBROKEN CALLING MINUTES from whatever cadence the samples
 *     arrive at (demand.ts escalates per elapsed hour, so shortening the cadence cannot change the
 *     slope — the issue's prerequisite, not a follow-up).
 *  2. `decideFloorRaise` compares the freshly computed floor with the plan's CURRENT block and says
 *     whether to raise that block in place: RAISES ONLY (never lower off-cycle — no downward
 *     oscillation), only where the hourly plan would have applied the floor (below the winter
 *     guard), never over a soak, clamped to the I4 band, and only when the gap is worth a write
 *     (≥ FLOOR_RAISE_MIN_F; the HBX write path is rate-limited to one per 15 min).
 *
 * The full hourly replan (DP, bank, soak, storm shaping, pre-boost) is untouched: this only lets the
 * current hour catch up with the house.
 */

/** A recomputed floor must exceed the current block by at least this much to be worth an off-cycle write. */
export const FLOOR_RAISE_MIN_F = 3;
/** Elapsed time between call samples is credited up to this cap — a telemetry gap is not evidence of calling. */
export const CALL_SAMPLE_GAP_CAP_MIN = 15;

/**
 * Advance the unbroken-calling clock: every zone calling now gains the elapsed minutes since the last
 * sample (capped); every zone not calling is forgotten. A null `callingNow` (no live call feed) leaves
 * the map untouched — unknown is not "stopped". Mutates and returns `minutes`.
 */
export function advanceCallMinutes(
  minutes: Map<string, number>,
  callingNow: string[] | null,
  elapsedMin: number,
  capMin: number = CALL_SAMPLE_GAP_CAP_MIN,
): Map<string, number> {
  if (callingNow === null) return minutes;
  const credit = Math.max(0, Math.min(capMin, Number.isFinite(elapsedMin) ? elapsedMin : 0));
  for (const id of callingNow) minutes.set(id, (minutes.get(id) ?? 0) + credit);
  for (const id of [...minutes.keys()]) if (!callingNow.includes(id)) minutes.delete(id);
  return minutes;
}

export interface FloorRaiseBlock {
  ts: string;
  tank_target_f: number;
  reason: string;
  sani?: boolean;
  bank?: boolean;
  boost?: boolean;
}

export type FloorRaiseDecision =
  | { raise: false; why: string }
  | { raise: true; ts: string; fromF: number; toF: number; reason: string };

export function decideFloorRaise(args: {
  block: FloorRaiseBlock | null | undefined;
  floorF: number | null | undefined;
  bindingZone: string | null | undefined;
  awtF: number | null | undefined;
  outdoorF: number | null | undefined;
  winterGuardF: number;
  /** I4 upper bound at this outdoor (bandFor(...).hi) — the raise never exceeds it. */
  bandHiF: number;
  minRaiseF?: number;
  now?: Date;
}): FloorRaiseDecision {
  const minRaiseF = args.minRaiseF ?? FLOOR_RAISE_MIN_F;
  const b = args.block;
  if (!b || !Number.isFinite(Number(b.tank_target_f))) return { raise: false, why: "no current plan block" };
  if (args.floorF == null || !Number.isFinite(args.floorF)) return { raise: false, why: "no demand floor (feed degraded)" };
  if (args.outdoorF == null || !Number.isFinite(args.outdoorF)) return { raise: false, why: "no outdoor reading" };
  if (args.outdoorF >= args.winterGuardF) return { raise: false, why: `outdoor ${args.outdoorF.toFixed(0)}°F ≥ winter guard ${args.winterGuardF}°F — the hourly plan applies no floor here either` };
  if (b.sani) return { raise: false, why: "current block is the sanitize soak (never subsumed)" };
  const fromF = Number(b.tank_target_f);
  const toF = Math.round(Math.min(args.floorF, args.bandHiF));
  if (toF < fromF + minRaiseF) return { raise: false, why: `floor ${args.floorF.toFixed(0)}°F is within ${minRaiseF}°F of the block's ${fromF}°F (band hi ${args.bandHiF.toFixed(0)})` };
  const hhmm = (args.now ?? new Date()).toISOString().slice(11, 16);
  const zone = args.bindingZone ?? "binding zone";
  const awt = args.awtF != null && Number.isFinite(args.awtF) ? ` needs ${Math.round(args.awtF)}°F` : "";
  return {
    raise: true, ts: b.ts, fromF, toF,
    reason: `binding zone: ${zone}${awt} (winter solver shadow; floor re-check ${hhmm}Z raised the block from ${fromF}°F)`,
  };
}
