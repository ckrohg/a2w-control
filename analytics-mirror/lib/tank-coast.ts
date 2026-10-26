// @purpose Post-boost tank coast projection for the Optimize Boost card: how long a tank charged to T °F
// takes to fall to the DHW floor on standing loss alone. Same physics as the planner's /health.thermal.coast_h
// (index.ts): hours = ln((T − 65) / (floor − 65)) / tank_ua, 65 °F being the ambient tank_ua is defined against
// (winterdp.ts). Draws are NOT modelled (a shower is ~9 °F), so it is a ceiling. Anything missing, stale or
// non-physical returns null and the card shows nothing — never a guess.

export const AMBIENT_F = 65;
/** /health.thermal.at older than this = the planner has stopped reading the tank (poll is ~minutes). */
export const THERMAL_MAX_AGE_MS = 30 * 60_000;

/** The /health.thermal fields this module reads, all untrusted. */
export type Thermal = { at?: unknown; tank_f?: unknown; dhw_floor_f?: unknown; tank_ua?: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Hours from `targetF` down to `floorF` at loss rate `ua` (1/h); null when it has no physical answer. */
export function coastHours(targetF: number, floorF: number, ua: number | null | undefined): number | null {
  if (ua == null || !(ua > 0) || !Number.isFinite(targetF) || !Number.isFinite(floorF)) return null;
  if (!(floorF > AMBIENT_F) || !(targetF > floorF)) return null; // at/under the floor: nothing to project
  return Math.log((targetF - AMBIENT_F) / (floorF - AMBIENT_F)) / ua;
}

/** The one line for the Boost card and its confirm text, or null (hide) when thermal data is missing/stale. */
export function coastLine(thermal: Thermal | null | undefined, targetF: number, nowMs: number): string | null {
  if (!thermal || typeof thermal !== "object") return null;
  const atMs = typeof thermal.at === "string" ? Date.parse(thermal.at) : NaN;
  if (!Number.isFinite(atMs) || nowMs - atMs > THERMAL_MAX_AGE_MS || atMs - nowMs > 60_000) return null;
  const tankF = num(thermal.tank_f);
  const h = coastHours(targetF, num(thermal.dhw_floor_f) ?? NaN, num(thermal.tank_ua));
  if (tankF == null || h == null) return null;
  return `Tank now ${Math.round(tankF)} °F → boosted to ${Math.round(targetF)} °F; lasts about ${h.toFixed(1)} h on standing loss alone`;
}

export const COAST_CAVEAT = "standing loss only; a shower uses about 9 °F";
