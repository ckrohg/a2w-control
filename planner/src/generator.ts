/**
 * @purpose Generator-aware outage mode (#241), SHADOW. In an outage an automatic whole-house transfer switch puts the
 * house on a ~100 A / 240 V (~24 kW) generator, and the SPAN panel cannot tell (knowledge/reference/
 * generator-outage-mode.md). Owner rule 2026-10-29: on the generator the 16.5 kW backup element is a LAST RESORT — only
 * when the house is getting cold AND the live whole-house load leaves room for it under the cap; 60 °F indoors is a
 * hard floor ("my mom will NOT be happy if she gets cold").
 *
 * Pure (no I/O). index.ts feeds it every SensorLinx poll and hands `element_allowed` to the backup gate, which then
 * refuses a close it would otherwise make (backupgate.ts `generator`). Three inputs:
 *   - SUPPLY from 6bb's National Grid email feed (planner OUTAGEWATCH_URL). An outage, or < RESTORE_TAIL after one, is
 *     the generator; a fresh "no outage" answer is the grid; anything else (feed unreachable, stale, never answered) is
 *     UNKNOWN and is treated as the generator — "if unsure, assume we are". The feed is email-based: it cannot see the
 *     first minutes of an outage (the doc covers what that leaves open).
 *   - BUDGET: house load (every SPAN circuit but the element's, from a fresh Pi panel read) + the element's 16.5 kW +
 *     MARGIN must stay ≤ CAP. Unknown load = does not fit.
 *   - COMFORT from TempIQ (the planner's demand feed): the zones with a heating call — every zone with a setpoint when
 *     the call feed is unavailable — and the coldest drives it. At risk = within FLOOR_BUFFER of the 60 °F floor, or
 *     TARGET_DEFICIT below its own setpoint. Unknown comfort counts AS at risk (the budget still binds): the gate only
 *     gets here because the heat pumps already cannot hold the tank, and a TempIQ outage must not leave her cold.
 * Two advisories ride along (log, /health, dashboard; never acted on): `shed` — the element breaker is ON while on the
 * generator without headroom (the HBX could fire it any moment); `one_pump` — both pumps run and the house is near the
 * cap.
 */

export const GEN = {
  /** ~100 A at 240 V for the whole house (owner, 2026-10-29) */
  CAP_W: 24_000,
  /** the backup element's nameplate (owner); it never drew in Jul 31 – Oct 29 (breaker kept OPEN) */
  ELEMENT_W: 16_500,
  /** 10 A of headroom on top: compressor inrush, a pump starting, unmetered load */
  MARGIN_W: 2_400,
  /** a heat pump heating: measured p95 6.1 kW, max 6.6 kW (span_readings Jul 31 – Oct 29, n = 17.7k) */
  PUMP_W: 6_100,
  /** a feed answer older than this is no answer (it is polled every 5 min) */
  FEED_FRESH_MS: 15 * 60_000,
  /** after the feed says the outage is over, stay on "generator" this long: an ATS waits minutes before retransfer,
   *  and the restored email can arrive before it */
  RESTORE_TAIL_MS: 30 * 60_000,
  /** a panel read older than this (Pi clock, relative to the frame) is not a live load */
  HOUSE_FRESH_S: 120,
  FLOOR_F: 60,
  FLOOR_BUFFER_F: 2,
  TARGET_DEFICIT_F: 2,
} as const;

export interface GenConfig { capW: number; marginW: number }
export const DEFAULT_GEN_CONFIG: GenConfig = { capW: GEN.CAP_W, marginW: GEN.MARGIN_W };

/** GEN_CAP_KW (15–40, default 24), GEN_MARGIN_KW (0–8, default 2.4). An invalid value falls back to its default. */
export function parseGenConfig(env: Record<string, string | undefined>): { cfg: GenConfig; errors: string[] } {
  const errors: string[] = [];
  const kw = (key: string, dflt: number, lo: number, hi: number): number => {
    const v = env[key];
    if (v == null || v.trim() === "") return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${key}=${JSON.stringify(v)} ignored (must be ${lo}–${hi} kW) — ${dflt / 1000}`); return dflt; }
    return n * 1000;
  };
  return { cfg: { capW: kw("GEN_CAP_KW", GEN.CAP_W, 15, 40), marginW: kw("GEN_MARGIN_KW", GEN.MARGIN_W, 0, 8) }, errors };
}

export type Supply = "grid" | "generator" | "unknown";

/** What the outage feed has said: index.ts notes every storm-tick answer (null = unreachable / unreadable). */
export class OutageFeed {
  private answerMs: number | null = null;
  private active: boolean | null = null;
  private lastActiveMs: number | null = null;

  note(active: boolean | null, nowMs: number): void {
    if (active == null) return; // no answer: the last one ages out by FEED_FRESH_MS
    this.answerMs = nowMs;
    this.active = active;
    if (active) this.lastActiveMs = nowMs;
  }

  supply(nowMs: number): { supply: Supply; why: string } {
    if (this.answerMs != null && nowMs - this.answerMs <= GEN.FEED_FRESH_MS) {
      if (this.active) return { supply: "generator", why: "National Grid reports an outage (6bb feed)" };
      if (this.lastActiveMs != null && nowMs - this.lastActiveMs < GEN.RESTORE_TAIL_MS) {
        return { supply: "generator", why: `the outage ended ${Math.round((nowMs - this.lastActiveMs) / 60_000)} min ago; ` +
          `assumed on the generator for ${GEN.RESTORE_TAIL_MS / 60_000} min after (transfer-switch retransfer)` };
      }
      return { supply: "grid", why: "no outage reported (6bb feed)" };
    }
    return { supply: "unknown", why: this.answerMs == null ? "the outage feed has not answered since the planner started"
      : `the outage feed has not answered for ${Math.round((nowMs - this.answerMs) / 60_000)} min` };
  }

  status(nowMs: number): Record<string, unknown> {
    return {
      ...this.supply(nowMs),
      last_answer_at: this.answerMs == null ? null : new Date(this.answerMs).toISOString(),
      outage_active: this.active,
      last_outage_seen_at: this.lastActiveMs == null ? null : new Date(this.lastActiveMs).toISOString(),
    };
  }
}

export interface ZoneTemp { id: string; name: string; roomF: number | null; setpointF: number | null }
export interface Comfort {
  at_risk: boolean | null;
  coldest: { name: string; room_f: number; setpoint_f: number | null } | null;
  why: string;
}

/** The coldest comfort zone decides. callingIds null = the call feed is unavailable: every zone with a setpoint counts
 *  (the same all-zones posture as demand.ts computeFloors); [] = nobody is calling. */
export function comfortRisk(zones: ZoneTemp[] | null, callingIds: string[] | null): Comfort {
  if (!zones) return { at_risk: null, coldest: null, why: "TempIQ zone temperatures unavailable" };
  if (callingIds && callingIds.length === 0) return { at_risk: false, coldest: null, why: "no zone is calling for heat" };
  const pool = (callingIds ? zones.filter((z) => callingIds.includes(z.id)) : zones.filter((z) => z.setpointF != null))
    .filter((z): z is ZoneTemp & { roomF: number } => z.roomF != null);
  if (!pool.length) return { at_risk: null, coldest: null, why: "no temperature for the zones calling for heat" };
  const coldest = pool.reduce((a, b) => (b.roomF < a.roomF ? b : a));
  const c = { name: coldest.name, room_f: coldest.roomF, setpoint_f: coldest.setpointF };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  if (coldest.roomF < GEN.FLOOR_F + GEN.FLOOR_BUFFER_F) {
    return { at_risk: true, coldest: c, why: `${coldest.name} is ${r1(coldest.roomF)} °F — within ${GEN.FLOOR_BUFFER_F} °F of the ${GEN.FLOOR_F} °F floor` };
  }
  const behind = pool.filter((z) => z.setpointF != null && z.roomF <= z.setpointF - GEN.TARGET_DEFICIT_F)
    .sort((a, b) => (a.roomF - a.setpointF!) - (b.roomF - b.setpointF!));
  if (behind.length) {
    const z = behind[0];
    return { at_risk: true, coldest: c, why: `${z.name} is ${r1(z.roomF)} °F, ${r1(z.setpointF! - z.roomF)} °F below its ${r1(z.setpointF!)} °F setpoint` };
  }
  return { at_risk: false, coldest: c, why: `the coldest calling zone, ${coldest.name}, is ${r1(coldest.roomF)} °F` +
    (coldest.setpointF != null ? ` (setpoint ${r1(coldest.setpointF)} °F)` : "") };
}

export interface GenInput {
  nowMs: number;
  supply: { supply: Supply; why: string };
  /** whole-house draw from a fresh panel read, EXCLUDING the element's circuit; null = unknown */
  houseW: number | null;
  relay: "OPEN" | "CLOSED" | null;
  /** pumps heating now (compressor running): the staging advisory */
  pumpsEngaged: number | null;
  comfort: Comfort;
}

export interface GenAssessment {
  supply: Supply;
  supply_why: string;
  /** generator or unknown: the budget rule applies */
  budget_applies: boolean;
  cap_w: number;
  margin_w: number;
  element_w: number;
  house_w: number | null;
  /** house + element + margin */
  projected_w: number | null;
  budget_fits: boolean | null;
  comfort: Comfort;
  /** the gate may close the element breaker (its own rules still decide whether it wants to) */
  element_allowed: boolean;
  element_why: string;
  /** advisory: the breaker is ON on the generator without headroom for the element */
  shed: boolean;
  /** advisory: both pumps run on the generator with the house within the margin of the cap */
  one_pump: boolean;
}

const kw = (w: number) => `${(w / 1000).toFixed(1)} kW`;

export function assess(i: GenInput, cfg: GenConfig = DEFAULT_GEN_CONFIG): GenAssessment {
  const applies = i.supply.supply !== "grid";
  const projected = i.houseW == null ? null : i.houseW + GEN.ELEMENT_W + cfg.marginW;
  const fits = projected == null ? null : projected <= cfg.capW;
  let allowed = true;
  let why = "on the grid: no generator limit";
  if (applies) {
    const on = i.supply.supply === "generator" ? "on the generator" : "possibly on the generator (supply unknown)";
    if (fits == null) { allowed = false; why = `${on} and the live house load is unknown — the element stays locked out`; }
    else if (!fits) {
      allowed = false;
      why = `${on}: house ${kw(i.houseW!)} + element ${kw(GEN.ELEMENT_W)} + margin ${kw(cfg.marginW)} = ${kw(projected!)} ` +
        `exceeds the ${kw(cfg.capW)} cap`;
    } else if (i.comfort.at_risk === false) {
      allowed = false;
      why = `${on} with headroom (${kw(projected!)} of ${kw(cfg.capW)}), but the house is not getting cold: ${i.comfort.why}`;
    } else {
      why = `${on} with headroom (${kw(projected!)} of ${kw(cfg.capW)}) and ` +
        (i.comfort.at_risk ? i.comfort.why : `comfort unknown (${i.comfort.why}) — treated as at risk`);
    }
  }
  return {
    supply: i.supply.supply, supply_why: i.supply.why, budget_applies: applies,
    cap_w: cfg.capW, margin_w: cfg.marginW, element_w: GEN.ELEMENT_W,
    house_w: i.houseW == null ? null : Math.round(i.houseW), projected_w: projected == null ? null : Math.round(projected),
    budget_fits: fits, comfort: i.comfort, element_allowed: allowed, element_why: why,
    shed: applies && i.relay === "CLOSED" && fits === false,
    one_pump: applies && (i.pumpsEngaged ?? 0) >= 2 && i.houseW != null && i.houseW + cfg.marginW > cfg.capW,
  };
}

/** The live house load from the Pi's SPAN snapshot: `house_w` (bridge ≥ #241), only when that panel read was fresh
 *  when the frame was pushed (both clocks are the Pi's, so no skew). */
export function houseLoadW(frameTs: number | null, span: { ts?: number | null; house_w?: unknown } | null | undefined): number | null {
  if (!span || typeof span.house_w !== "number" || !Number.isFinite(span.house_w) || span.house_w < 0) return null;
  if (frameTs == null || span.ts == null) return null;
  const age = frameTs - span.ts;
  return age >= -5 && age <= GEN.HOUSE_FRESH_S ? span.house_w : null;
}
