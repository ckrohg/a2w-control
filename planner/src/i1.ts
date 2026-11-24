/**
 * @purpose The two pure computations inside index.ts checkI1, lifted out so a test can reach them (they were
 * exercised by no test; phaseb-stale.test.ts only mirrors the rule). I1 (plan §3) is the deadlock guard against the
 * 16.5 kW element: every ONLINE pump's setpoint must sit at or above tank target + margin, or the tank sensor can
 * never terminate a call. piClockOffsetS is the #165 live Pi-clock offset (planner now − the frame's Pi time) that
 * decides which dropout windows /health.pi trusts (pilink.ts). Neither function touches state, the hub, the store or
 * the alert flow — checkI1 keeps all of that; the strings and numbers these return are byte-identical to what the
 * inline code produced.
 */
import type { HubPump, HubState } from "./hub";

const cToF = (c: number) => (c * 9) / 5 + 32;

/**
 * Planner now − the Pi's frame time, in seconds; null when the Pi is not connected or the frame carries no usable
 * time (ts missing, null, non-numeric or ≤ 0). The Pi stamps UNIX SECONDS (hub_client.py:227); a stamp above 1e11
 * can only be milliseconds and is divided down. Only `pi_connected` and `ts` are read.
 */
export function piClockOffsetS(state: Pick<HubState, "pi_connected" | "ts">, nowMs: number): number | null {
  const ts: unknown = state.ts;
  if (!state.pi_connected || typeof ts !== "number" || !(ts > 0)) return null;
  return nowMs / 1000 - (ts > 1e11 ? ts / 1000 : ts);
}

export interface I1Offenders {
  /** one line per offending pump: `${id} setpoint X°F < required Y°F` (toFixed(1) on both) */
  offenders: string[];
  /** tankTargetF + marginF — the bar every online setpoint must reach */
  required: number;
}

/**
 * The online pumps whose setpoint (°C → °F, unrounded) sits strictly BELOW tank target + margin. Offline pumps and
 * pumps with no setpoint are ignored; a setpoint exactly at the bar is not an offender. Order follows `pumps`.
 */
export function i1Offenders(
  pumps: ReadonlyArray<Pick<HubPump, "id" | "online" | "setpoint_c">>,
  tankTargetF: number,
  marginF: number,
): I1Offenders {
  const required = tankTargetF + marginF;
  const offenders = pumps
    .filter((p) => p.online && p.setpoint_c != null && cToF(p.setpoint_c) < required)
    .map((p) => `${p.id} setpoint ${cToF(p.setpoint_c as number).toFixed(1)}°F < required ${required.toFixed(1)}°F`);
  return { offenders, required };
}
