/**
 * @purpose #59 winter solver v1 — a small 24 h dynamic program over the tank-target trajectory.
 * Decides WHEN to buy heat and HOW DEEP to charge, minimizing electric kWh, on top of hard
 * comfort floors that are never traded: every hour's tank target must cover max(DHW floor,
 * per-hour demand floor). The DP prices three measured effects the floor-following plan cannot:
 * COP(outdoor, LWT) timing (charge in the warm hours, from tempiq_cop_points anchor +
 * Carnot-shaped extrapolation), tank standby loss (UA from tank_decay_fits × ΔT), and the
 * ~1 kWh per-cycle charge overhead (favors fewer, deeper charges — C_eff work, 2026-07).
 * PURE MODULE: callers assemble per-hour inputs; this file does no I/O. Degraded modes are
 * explicit: no COP anchor → modelCop fallback; no UA → the 0.017 cross-checked default; no
 * zone UAs → load=0 (floors + standby still priced). SHADOW-FIRST: the caller stores the
 * trajectory for comparison and only applies it (raise-only, band-clamped) behind
 * WINTER_DP_ENABLED — floors, I1, I4, strictCap and the writer guardrails are all upstream
 * or downstream of this module and none are relaxed by it.
 */

import { carnotFactor, modelCop } from "./realized";

/** Tank thermal capacity: C_eff = 110 gal measured (energy accounting, [90,125]) × 8.34 lb/gal. */
export const C_EFF_BTU_PER_F = 110 * 8.34;
/** Cross-checked quiet-window standby UA (°F/hr per °F above 65 °F ambient) — tank-ua-push.ts. */
export const DEFAULT_TANK_UA = 0.017;
/** Measured per-cycle charge overhead (electric kWh) — favors deep charges (C_eff work). */
export const CYCLE_OVERHEAD_KWH = 1.0;
const AMBIENT_F = 65; // mechanical-room ambient the UA is defined against (tank-ua-push.ts)
const LEAD_F = 5; // I1 margin: LWT during a charge ≈ target + lead
const BTU_PER_KWH = 3412;

/** Measured COP anchor (energy-weighted over quality-filtered tempiq_cop_points). */
export interface CopAnchor {
  cop: number;
  sinkF: number;
  outdoorF: number;
}

/**
 * COP at (outdoor, sink): measured anchor scaled by the Carnot-factor ratio (the same
 * ratio realized.ts uses for as-found counterfactuals), clamped to sane hardware bounds.
 * No anchor → the modelCop Carnot-fraction fallback (same shape as the /curve hero model).
 */
export function copAt(anchor: CopAnchor | null, outdoorF: number, sinkF: number): number {
  if (!anchor) return modelCop(outdoorF, sinkF);
  const ratio = carnotFactor(sinkF, outdoorF) / carnotFactor(anchor.sinkF, anchor.outdoorF);
  return Math.min(6, Math.max(0.8, anchor.cop * ratio));
}

/** One hour of DP input. floorF is the HARD comfort floor (max of DHW + demand floors, already
 *  band-sane); capF the hard ceiling (strictCap ∧ I4 band hi) — both computed by the caller so
 *  this module never re-derives policy. loadBtu is expected space-heat + DHW draw for the hour. */
export interface DpHour {
  ts: string; // ISO hour start (passed through to the output)
  outdoorF: number;
  floorF: number;
  capF: number;
  loadBtu: number;
}

export interface DpBlock {
  ts: string;
  targetF: number; // tank temp to hold at hour end == the commanded target for the hour
  charge: boolean; // does this hour buy heat?
  reason: string;
}

export interface DpResult {
  blocks: DpBlock[];
  totalKwh: number; // modeled electric cost of the chosen trajectory
  floorKwh: number; // modeled cost of naive floor-following (the comparison baseline)
  savedPct: number; // (floorKwh − totalKwh) / floorKwh, rounded; ≥ 0 by construction
}

export interface DpOpts {
  anchor: CopAnchor | null;
  tankUa: number; // °F/hr per °F ΔT above AMBIENT_F
  startTankF: number;
  cycleOverheadKwh?: number;
  stepF?: number; // state grid resolution
}

/** Electric kWh to raise the tank by deltaBtu of thermal at this hour's conditions. */
function chargeKwh(anchor: CopAnchor | null, outdoorF: number, sinkF: number, deltaBtu: number): number {
  return deltaBtu / BTU_PER_KWH / copAt(anchor, outdoorF, sinkF);
}

/**
 * Solve the 24 h trajectory by backward induction. State = tank °F on the step grid ×
 * whether the previous hour was charging (for the cycle-start overhead). Action = tank °F
 * at hour end, constrained to [floorF, capF]. Physics per hour: free-coast end temp
 * E_free = S − (load + standby)/C; any action above it buys C×(E − E_free) BTU at
 * COP(outdoor, max(S,E)+lead). Terminal: residual heat above the last floor is credited at
 * the trajectory-mean COP so the horizon edge neither hoards nor dumps.
 */
export function solveWinterDp(hours: DpHour[], opts: DpOpts): DpResult | null {
  if (!hours.length) return null;
  const step = opts.stepF ?? 1;
  const overhead = opts.cycleOverheadKwh ?? CYCLE_OVERHEAD_KWH;
  const uaBtuPerHrF = opts.tankUa * C_EFF_BTU_PER_F; // °F/hr·°F → BTU/hr·°F

  const gridLo = Math.floor(Math.min(...hours.map((h) => h.floorF)));
  const gridHi = Math.ceil(Math.max(...hours.map((h) => h.capF)));
  if (gridHi <= gridLo) return null;
  const nStates = Math.floor((gridHi - gridLo) / step) + 1;
  const tempOf = (i: number) => gridLo + i * step;
  const idxOf = (t: number) => Math.min(nStates - 1, Math.max(0, Math.round((t - gridLo) / step)));

  // Mean COP across the horizon at floor-level sink — the terminal price of stored heat.
  const meanCop =
    hours.reduce((s, h) => s + copAt(opts.anchor, h.outdoorF, h.floorF + LEAD_F), 0) / hours.length;
  const last = hours[hours.length - 1];

  // value[i][c] = min future kWh from state (tank=tempOf(i), wasCharging=c) at stage h.
  const H = hours.length;
  let next: number[][] = Array.from({ length: nStates }, (_, i) => {
    const credit = (C_EFF_BTU_PER_F * Math.max(0, tempOf(i) - last.floorF)) / BTU_PER_KWH / meanCop;
    return [-credit, -credit];
  });
  // choice[h][i][c] = action index chosen (for path reconstruction)
  const choice: Int16Array[][] = Array.from({ length: H }, () =>
    Array.from({ length: nStates }, () => new Int16Array(2)),
  );

  for (let h = H - 1; h >= 0; h--) {
    const hr = hours[h];
    const cur: number[][] = Array.from({ length: nStates }, () => [Infinity, Infinity]);
    const drainBtu = (S: number) => hr.loadBtu + uaBtuPerHrF * Math.max(0, S - AMBIENT_F);
    for (let i = 0; i < nStates; i++) {
      const S = tempOf(i);
      const eFree = S - drainBtu(S) / C_EFF_BTU_PER_F;
      for (const c of [0, 1]) {
        let best = Infinity;
        let bestJ = -1;
        for (let j = 0; j < nStates; j++) {
          const E = tempOf(j);
          if (E < hr.floorF || E > hr.capF) continue;
          if (E < eFree - step) continue; // cannot dump heat — coast is the lowest reachable end
          const boughtBtu = Math.max(0, (E - Math.min(eFree, E)) * C_EFF_BTU_PER_F);
          const charging = boughtBtu > 1;
          const sinkF = Math.max(S, E) + LEAD_F;
          const cost =
            (charging ? chargeKwh(opts.anchor, hr.outdoorF, sinkF, boughtBtu) : 0) +
            (charging && !c ? overhead : 0) +
            next[j][charging ? 1 : 0];
          if (cost < best) {
            best = cost;
            bestJ = j;
          }
        }
        // Floor unreachable by coasting alone never happens (charging is always available);
        // bestJ === -1 only if floorF > capF for the hour — treat as clamp-to-cap upstream.
        cur[i][c] = bestJ === -1 ? next[idxOf(hr.floorF)][c] : best;
        choice[h][i][c] = bestJ === -1 ? idxOf(Math.min(hr.floorF, hr.capF)) : bestJ;
      }
    }
    next = cur;
  }

  // Reconstruct the chosen path from the real starting tank state.
  const blocks: DpBlock[] = [];
  let i = idxOf(opts.startTankF);
  let c = 0;
  let total = 0;
  const minOutAhead = (h: number) => Math.min(...hours.slice(h).map((x) => x.outdoorF));
  for (let h = 0; h < H; h++) {
    const hr = hours[h];
    const S = tempOf(i);
    const j = choice[h][i][c];
    const E = tempOf(j);
    const eFree = S - (hr.loadBtu + uaBtuPerHrF * Math.max(0, S - AMBIENT_F)) / C_EFF_BTU_PER_F;
    const boughtBtu = Math.max(0, (E - Math.min(eFree, E)) * C_EFF_BTU_PER_F);
    const charging = boughtBtu > 1;
    if (charging) {
      total += chargeKwh(opts.anchor, hr.outdoorF, Math.max(S, E) + LEAD_F, boughtBtu);
      if (!c) total += overhead;
    }
    const banked = E - hr.floorF;
    const reason = charging
      ? banked > 1
        ? `DP: bank to ${E}°F at ${Math.round(hr.outdoorF)}°F outdoor (min ahead ${Math.round(minOutAhead(h))}°F)`
        : `DP: charge to floor ${E}°F`
      : banked > 1
        ? `DP: coast on bank (${E}°F, floor ${Math.round(hr.floorF)}°F)`
        : `DP: hold floor ${E}°F`;
    blocks.push({ ts: hr.ts, targetF: E, charge: charging, reason });
    i = j;
    c = charging ? 1 : 0;
  }

  // Baseline: naive floor-following from the same start state (charge to floor whenever below).
  let floorKwh = 0;
  let S = opts.startTankF;
  let wasCharging = false;
  for (const hr of hours) {
    const eFree = S - (hr.loadBtu + uaBtuPerHrF * Math.max(0, S - AMBIENT_F)) / C_EFF_BTU_PER_F;
    const E = Math.max(hr.floorF, Math.min(eFree, hr.capF));
    const boughtBtu = Math.max(0, (E - Math.min(eFree, E)) * C_EFF_BTU_PER_F);
    const charging = boughtBtu > 1;
    if (charging) {
      floorKwh += chargeKwh(opts.anchor, hr.outdoorF, Math.max(S, E) + LEAD_F, boughtBtu);
      if (!wasCharging) floorKwh += overhead;
    }
    wasCharging = charging;
    S = E;
  }
  // Same terminal credit so the two totals are comparable.
  const trajCredit =
    (C_EFF_BTU_PER_F * Math.max(0, blocks[blocks.length - 1].targetF - last.floorF)) / BTU_PER_KWH / meanCop;
  const baseCredit = (C_EFF_BTU_PER_F * Math.max(0, S - last.floorF)) / BTU_PER_KWH / meanCop;
  const totalNet = Math.max(0, total - trajCredit);
  const floorNet = Math.max(0.001, floorKwh - baseCredit);
  return {
    blocks,
    totalKwh: Math.round(totalNet * 100) / 100,
    floorKwh: Math.round(floorNet * 100) / 100,
    savedPct: Math.round(Math.max(0, 1 - totalNet / floorNet) * 100),
  };
}
