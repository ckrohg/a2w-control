/**
 * @purpose #170 (surface for #134): watch for a binding zone whose cost-first escalation is structurally INERT.
 *
 * DEMAND_FLOOR_POLICY=escalate lets room-deficit or call-persistence evidence raise a zone's supply temp toward
 * TempIQ's requiredSupplyWaterTempF, which acts as the ceiling (demand.ts costFirstAwtF). TempIQ emits that ceiling
 * only for zones whose delivery type the owner has VERIFIED (deliveryTypeVerified). For an unverified zone
 * requiredSupplyF is null, computeFloors never calls costFirstAwtF, and the zone gets awtF = localF with zero
 * escalation at any room deficit and for any number of calling cycles (#134). Three hydronic zones are still
 * unverified (Master Bathroom at 60 % duty last winter, Upstairs Bathroom, Kitchen Radiant), and index.ts only
 * logged a generic "UNVERIFIED delivery_type" warning every cycle.
 *
 * This is OPTION (a) of #170 — surface only. It changes no target and writes nothing: it names the cycles where
 * the binding zone is unverified AND is showing the very evidence the escalation would have acted on (room deficit
 * ≥ DEFICIT_F, or binding for ≥ STREAK_CYCLES consecutive cycles). Edge-triggered: one report when an episode opens,
 * one when it clears; /health carries the open episode and the week's closed ones. No notification tier is attached
 * (the owner has not chosen one). Pure — no I/O, no clock of its own.
 */

/** Room deficit (setpoint − room, °F) at or above which an unverified binding zone is an episode. */
export const DEFICIT_F = 1.0;
/** Consecutive cycles as the binding zone at or above which an unverified binding zone is an episode. */
export const STREAK_CYCLES = 6;
/** The open episode clears after this many consecutive cycles with the condition false (zone still binding). */
export const CLEAR_CYCLES = 3;
/** How long closed episodes are kept for the weekly view. */
export const WEEK_MS = 7 * 86_400_000;

/** The per-cycle facts about the binding zone; null = no binding zone this cycle (no floor / nobody calling). */
export interface BindingFacts {
  zone: string;
  /** FloorResult.bindingVerified: true = owner-verified, false = seeded/unconfirmed, null = TempIQ did not say. */
  verified: boolean | null;
  /** setpoint − room in °F from the same roomF/setpointF costFirstAwtF reads; null when either is missing. */
  deficitF: number | null;
}

/** What is reported when an episode opens, and shown on /health while it is open. */
export interface UnverifiedBindingReport {
  zone: string;
  /** consecutive cycles the zone has been the binding zone (counted here) */
  cycles: number;
  /** the room deficit at the last step, °F (null = no room telemetry) */
  deficit_f: number | null;
  /** ISO time the episode opened */
  since: string;
}

export interface UnverifiedBindingEpisode extends UnverifiedBindingReport {
  /** ISO time the episode cleared; null while open */
  until: string | null;
  /** the largest deficit seen during the episode, °F (null = never had room telemetry) */
  max_deficit_f: number | null;
  /** consecutive binding cycles at the last step of the episode */
  cycles_at_close: number;
  /** why the episode cleared: "binding_changed" (another zone binds / no binding zone) or "condition_false" (CLEAR_CYCLES false cycles) */
  cleared_by: "binding_changed" | "condition_false" | null;
}

export type UnverifiedBindingEvent =
  | { kind: "open"; report: UnverifiedBindingReport }
  | { kind: "clear"; episode: UnverifiedBindingEpisode };

/** Room deficit the way costFirstAwtF measures it (setpoint − room); null when either reading is missing. */
export function roomDeficitF(roomF: number | null | undefined, setpointF: number | null | undefined): number | null {
  if (typeof roomF !== "number" || !Number.isFinite(roomF)) return null;
  if (typeof setpointF !== "number" || !Number.isFinite(setpointF)) return null;
  return Math.round((setpointF - roomF) * 10) / 10;
}

/** The per-cycle predicate (#170): unverified AND (deficit ≥ DEFICIT_F OR binding ≥ STREAK_CYCLES cycles). */
export function unverifiedBindingCondition(f: BindingFacts, cycles: number): boolean {
  if (f.verified !== false) return false; // true = fine; null = TempIQ did not say — do not accuse a zone on no evidence
  return (f.deficitF != null && f.deficitF >= DEFICIT_F) || cycles >= STREAK_CYCLES;
}

/**
 * Edge-triggered state for the binding zone. Call step() once per planner cycle with the binding zone's facts
 * (null when there is no binding zone). Returns the events this step produced — at most one — so the caller logs
 * one line per transition, never per cycle.
 */
export class UnverifiedBindingWatch {
  /** the zone binding on the previous step and how many consecutive steps it has been binding */
  private cur: { zone: string; cycles: number } | null = null;
  private open: UnverifiedBindingEpisode | null = null;
  /** consecutive steps the condition has been false while an episode is open and the zone is still binding */
  private falseStreak = 0;
  private history: UnverifiedBindingEpisode[] = [];

  step(facts: BindingFacts | null, now: number = Date.now()): UnverifiedBindingEvent[] {
    const out: UnverifiedBindingEvent[] = [];
    // Binding change (including "no binding zone"): the open episode clears, the cycle count restarts. A zone that
    // stops binding is no longer the zone the floor is set from, so there is nothing left to watch.
    if (facts === null || this.cur === null || this.cur.zone !== facts.zone) {
      if (this.open) out.push(this.close("binding_changed", now));
      this.cur = facts === null ? null : { zone: facts.zone, cycles: 0 };
      this.falseStreak = 0;
    }
    if (facts === null || this.cur === null) { this.prune(now); return out; }

    this.cur.cycles += 1;
    const on = unverifiedBindingCondition(facts, this.cur.cycles);
    if (this.open) {
      this.open.cycles_at_close = this.cur.cycles;
      if (facts.deficitF != null) this.open.max_deficit_f = Math.max(this.open.max_deficit_f ?? -Infinity, facts.deficitF);
      if (on) {
        this.falseStreak = 0;
      } else if (++this.falseStreak >= CLEAR_CYCLES) {
        out.push(this.close("condition_false", now));
      }
    } else if (on) {
      this.open = {
        zone: facts.zone, cycles: this.cur.cycles, deficit_f: facts.deficitF, since: new Date(now).toISOString(),
        until: null, max_deficit_f: facts.deficitF, cycles_at_close: this.cur.cycles, cleared_by: null,
      };
      this.falseStreak = 0;
      out.push({ kind: "open", report: this.current() as UnverifiedBindingReport });
    }
    this.prune(now);
    return out;
  }

  /** The open episode as /health.winter_solver.unverified_binding shows it, or null. */
  current(): UnverifiedBindingReport | null {
    if (!this.open) return null;
    const { zone, cycles, deficit_f, since } = this.open;
    return { zone, cycles, deficit_f, since };
  }

  /** Episodes (closed, oldest first, then the open one) that opened or closed inside the last WEEK_MS. */
  week(now: number = Date.now()): UnverifiedBindingEpisode[] {
    this.prune(now);
    return [...this.history.map((e) => ({ ...e })), ...(this.open ? [{ ...this.open }] : [])];
  }

  private close(by: UnverifiedBindingEpisode["cleared_by"], now: number): UnverifiedBindingEvent {
    const e = this.open as UnverifiedBindingEpisode;
    e.until = new Date(now).toISOString();
    e.cleared_by = by;
    this.open = null;
    this.falseStreak = 0;
    this.history.push(e);
    return { kind: "clear", episode: { ...e } };
  }

  private prune(now: number): void {
    const cutoff = now - WEEK_MS;
    this.history = this.history.filter((e) => Date.parse(e.until ?? e.since) >= cutoff);
  }
}

/** One log line per transition (index.ts). Says what the escalation would have seen and why it could not act (#134). */
export function describeEvent(ev: UnverifiedBindingEvent): string {
  if (ev.kind === "open") {
    const r = ev.report;
    const why = r.deficit_f != null && r.deficit_f >= DEFICIT_F
      ? `room deficit ${r.deficit_f.toFixed(1)} °F`
      : `binding for ${r.cycles} consecutive cycles${r.deficit_f == null ? ", no room telemetry" : ` (room deficit ${r.deficit_f.toFixed(1)} °F)`}`;
    return `[demand] UNVERIFIED binding zone "${r.zone}" is calling without an escalation ceiling: ${why}. ` +
      `TempIQ emits requiredSupplyWaterTempF only for verified delivery types, so the cost-first escalation cannot help it (#134/#170). ` +
      `Surface only — no target changed. Verify the zone's delivery type in TempIQ.`;
  }
  const e = ev.episode;
  const how = e.cleared_by === "binding_changed" ? "it is no longer the binding zone" : `the condition has been false for ${CLEAR_CYCLES} cycles`;
  const peak = e.max_deficit_f != null ? `, peak room deficit ${e.max_deficit_f.toFixed(1)} °F` : "";
  return `[demand] UNVERIFIED binding zone "${e.zone}" episode cleared: ${how} (open since ${e.since}, ${e.cycles_at_close} binding cycles${peak}) (#134/#170).`;
}
