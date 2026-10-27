// @purpose Post-boost tank coast projection for the Optimize Boost card: how long a tank charged to T °F takes, on
// standing loss alone, to fall to the point where the HBX reheats it again. Same physics as the planner's
// /health.thermal.coast_h (index.ts): hours = ln((T − 65) / (end − 65)) / tank_ua, 65 °F being the ambient tank_ua is
// defined against (winterdp.ts).
//
// The END POINT is not always the DHW floor (the #130 re-review, 2026-10-26): when the boost's timer ends the
// auto-pilot commands its plan target again, and the HBX reheats once the tank falls ht_dif/2 below that. So the coast
// ends at max(dhw_floor_f, restored_target − ht_dif/2). In October the plan commands the 120 °F floor and the two
// agree (135 → 120 ≈ 12.6 h at the live ua); on a 130 °F winter curve a 135 °F boost coasts to 128 (≈ 5.5 h), not to
// 120. The restored target is /health.phase_b.lead.plan_f — what the auto-pilot COMMANDS for the block in force,
// stale-report aware (#222/#223) — falling back to curve.plan_implies.output_at_live_outdoor_f, then the floor. NEVER
// the writer status's target_f: that is the raw SensorLinx report, which freezes after a soak (#215; 140.1 °F on the
// night of 2026-10-25 while the device drove to 120) and would print 0 h.
//
// Draws are NOT modelled (a shower is ~9 °F), so it is a ceiling. Anything missing, stale or non-physical returns
// null and the card shows nothing — never a guess.

export const AMBIENT_F = 65;
/** /health.thermal.at older than this = the planner has stopped reading the tank (poll is ~minutes). */
export const THERMAL_MAX_AGE_MS = 30 * 60_000;
/** The HBX hot-tank differential when the writer status has none on record (writes.ts: null until the first config version). */
export const DEFAULT_HT_DIF_F = 4;

/** The /health.thermal fields this module reads, all untrusted. */
export type Thermal = { at?: unknown; tank_f?: unknown; dhw_floor_f?: unknown; tank_ua?: unknown };
/** The /health.phase_b.lead fields this module reads (phaseb.ts lastLead), all untrusted. Only plan_f is an input. */
export type Lead = { plan_f?: unknown; plan_basis?: unknown; operative_f?: unknown; operative_basis?: unknown };
/** GET /api/planner/thermal's body: the thermal block, the Phase B lead, the plan curve's output at the live outdoor. */
export type ThermalRead = { thermal?: Thermal | null; lead?: Lead | null; plan_implies_f?: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Hours from `targetF` down to `endF` at loss rate `ua` (1/h); null when it has no physical answer. */
export function coastHours(targetF: number, endF: number, ua: number | null | undefined): number | null {
  if (ua == null || !(ua > 0) || !Number.isFinite(targetF) || !Number.isFinite(endF)) return null;
  if (!(endF > AMBIENT_F) || !(targetF > endF)) return null; // at/under the end point: nothing to project
  return Math.log((targetF - AMBIENT_F) / (endF - AMBIENT_F)) / ua;
}

/**
 * Where the coast ends — the next reheat: max(floorF, restoredTargetF − htDif/2). No restored target known → the
 * floor. `atFloor` picks the caller's wording ("above the … hot-water floor" vs "to the next reheat at …").
 */
export function coastEndF(floorF: number, restoredTargetF: number | null, htDifF: number | null): { endF: number; atFloor: boolean } {
  const dif = htDifF != null && htDifF >= 0 ? htDifF : DEFAULT_HT_DIF_F;
  const reheatF = restoredTargetF != null ? restoredTargetF - dif / 2 : -Infinity;
  return reheatF > floorF ? { endF: reheatF, atFloor: false } : { endF: floorF, atFloor: true };
}

/** The target the auto-pilot restores after the boost: the Phase B plan lead, else the plan curve's output, else null. */
export function restoredTargetF(read: ThermalRead): number | null {
  return num(read.lead?.plan_f) ?? num(read.plan_implies_f);
}

/**
 * The one line for the Boost card and its confirm text, or null (hide) when the thermal read is missing/stale.
 * `htDifF` is the writer status's ht_dif_f (GET /api/planner/target) — the only thing read from that status.
 */
export function coastLine(read: ThermalRead | null | undefined, targetF: number, nowMs: number, htDifF?: unknown): string | null {
  const thermal = read?.thermal;
  if (!read || !thermal || typeof thermal !== "object") return null;
  const atMs = typeof thermal.at === "string" ? Date.parse(thermal.at) : NaN;
  if (!Number.isFinite(atMs) || nowMs - atMs > THERMAL_MAX_AGE_MS || atMs - nowMs > 60_000) return null;
  const floorF = num(thermal.dhw_floor_f);
  if (floorF == null) return null;
  const { endF, atFloor } = coastEndF(floorF, restoredTargetF(read), num(htDifF));
  const h = coastHours(targetF, endF, num(thermal.tank_ua));
  if (h == null) return null;
  const to = atFloor ? `above the ${Math.round(floorF)} °F hot-water floor` : `to the next reheat at ${Math.round(endF)} °F`;
  return `after the boost to ${Math.round(targetF)} °F: coasts ≈ ${h.toFixed(1)} h ${to}`;
}

export const COAST_CAVEAT = "standing loss only — a shower is ≈ 9 °F";
