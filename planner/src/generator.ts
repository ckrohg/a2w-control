/**
 * @purpose Generator-aware outage mode (#241), SHADOW. In an outage an automatic whole-house transfer switch puts the
 * house on a Kohler 20RESA propane generator (20 kW / 83 A at 240 V), and the SPAN panel cannot tell (knowledge/
 * reference/generator-outage-mode.md). Owner rule 2026-11-02: the 16.5 kW backup element NEVER closes automatically on
 * the generator, and an unknown supply is treated as the generator. (It replaces the 2026-10-29 rule "last resort, if
 * the budget fits and the house is cold".) 60 °F indoors stays a hard floor ("my mom will NOT be happy if she gets
 * cold"): on the generator that is the heat pumps' job, with a pre-charged tank.
 *
 * Pure (no I/O). index.ts feeds it every SensorLinx poll and hands `element_allowed` to the backup gate, which then
 * refuses a close it would otherwise make (backupgate.ts `generator`). On the generator or an unknown supply
 * `element_allowed` is always false; the budget and comfort below are still computed and reported (/health, the
 * `shed` and `one_pump` advisories). Three inputs:
 *   - SUPPLY from 6bb's National Grid email feed (planner OUTAGEWATCH_URL). An outage, or < RESTORE_TAIL after one, is
 *     the generator; a fresh "no outage" answer is the grid. A SILENT feed (unreachable, stale, never answered) is
 *     UNKNOWN, treated as the generator, only while an outage is plausible: the last answer said one is active, one was
 *     seen < SILENT_OUTAGE_RECENT_MS ago, or the planner started < FEED_STARTUP_GRACE_MS ago with no answer yet.
 *     Otherwise it is the grid, flagged `assumed` (owner 2026-11-01: a dead feed must not block the element on normal
 *     grid power all season). The feed is email-based: it cannot see the first minutes of an outage, nor one that
 *     starts while it is silent (the doc covers what that leaves open). What it last said survives a restart
 *     (FeedMemory), because every deploy restarts the planner, and a feed silent for FEED_SILENT_ALERT_MS emails the owner.
 *   - BUDGET: house load (every SPAN circuit but the element's, from a fresh Pi panel read) + the element's 16.5 kW +
 *     MARGIN must stay ≤ CAP. Unknown load = does not fit.
 *   - COMFORT from TempIQ (the planner's demand feed): every OCCUPIED zone (comfortRisk), the coldest driving it. At
 *     risk = within FLOOR_BUFFER of the 60 °F floor, or TARGET_DEFICIT below its own setpoint. A zone with no or a stale
 *     temperature makes it unknown. Reported only: no comfort verdict lets the element close on the generator.
 * Two advisories ride along (log, /health, dashboard; never acted on): `shed` — the element breaker is ON while on the
 * generator without headroom, or with a load nobody can see (the HBX could fire it any moment); `one_pump` — both pumps
 * run and the house is near the cap.
 */

export const GEN = {
  /** Kohler 20RESA on propane: 20 kW / 83 A at 240 V for the whole house (owner, 2026-11-02; the earlier 24 kW / 100 A
   *  was wrong) */
  CAP_W: 20_000,
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
  /** a silent feed stays "unknown" (= the generator) if an outage was seen this recently; older, it assumes the grid */
  SILENT_OUTAGE_RECENT_MS: 6 * 3600_000,
  /** no answer yet since the planner started: "unknown" this long (the first poll normally answers within minutes;
   *  every deploy restarts the planner), then the grid is assumed */
  FEED_STARTUP_GRACE_MS: 30 * 60_000,
  /** silent this long and the owner hears about it: past any 6bb deploy, and the supply is a guess until it answers */
  FEED_SILENT_ALERT_MS: 2 * 3600_000,
  /** a panel read older than this (Pi clock, relative to the frame) is not a live load */
  HOUSE_FRESH_S: 120,
  FLOOR_F: 60,
  FLOOR_BUFFER_F: 2,
  TARGET_DEFICIT_F: 2,
} as const;

export interface GenConfig { capW: number; marginW: number }
export const DEFAULT_GEN_CONFIG: GenConfig = { capW: GEN.CAP_W, marginW: GEN.MARGIN_W };

/** GEN_CAP_KW (15–40, default 20), GEN_MARGIN_KW (0–8, default 2.4). An invalid value falls back to its default. */
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

/** The part of the feed's state that outlives a restart (store: outage_feed_memory). */
export interface FeedMemory { active: boolean | null; lastActiveMs: number | null }

/** What the outage feed has said: index.ts notes every storm-tick answer (null = unreachable / unreadable). */
export class OutageFeed {
  private answerMs: number | null = null;
  private active: boolean | null = null;
  private lastActiveMs: number | null = null;
  private failure: string | null = null;

  /** startMs = when the planner started (the FEED_STARTUP_GRACE_MS clock) */
  constructor(private readonly startMs: number = Date.now()) {}

  /** `failure` says why there was no answer (storm.ts feedFailure), for the owner's email and /health */
  note(active: boolean | null, nowMs: number, failure: string | null = null): void {
    this.failure = active == null ? failure : null;
    if (active == null) return; // no answer: the last one ages out by FEED_FRESH_MS
    this.answerMs = nowMs;
    this.active = active;
    if (active) this.lastActiveMs = nowMs;
  }

  memory(): FeedMemory { return { active: this.active, lastActiveMs: this.lastActiveMs }; }

  /**
   * What the feed said before this start. The answer time stays null: "has it answered since we started" is what the
   * startup grace needs, and the memory then does the rest (an active outage or a recent one keeps a silent feed
   * unknown, and a first "no outage" still gets the retransfer tail). An answer that beat the restore wins.
   */
  restore(m: FeedMemory): void {
    if (this.answerMs != null) return;
    this.active = m.active;
    this.lastActiveMs = m.lastActiveMs;
  }

  /** Silent for FEED_SILENT_ALERT_MS (a restart restarts this clock), else null. Whatever the supply reads: a dead feed
   *  after an outage locks the element out on a guess, and a dead feed with no outage hides the next one. */
  silence(nowMs: number): { hours: number; why: string; failure: string | null } | null {
    const silentMs = nowMs - (this.answerMs ?? this.startMs);
    if (silentMs < GEN.FEED_SILENT_ALERT_MS) return null;
    return { hours: silentMs / 3600_000, why: this.supply(nowMs).why, failure: this.failure };
  }

  /** `assumed` = the grid answer comes from the feed's silence, not from the feed */
  supply(nowMs: number): { supply: Supply; why: string; assumed: boolean } {
    if (this.answerMs != null && nowMs - this.answerMs <= GEN.FEED_FRESH_MS) {
      if (this.active) return { supply: "generator", why: "National Grid reports an outage (6bb feed)", assumed: false };
      if (this.lastActiveMs != null && nowMs - this.lastActiveMs < GEN.RESTORE_TAIL_MS) {
        return { supply: "generator", why: `the outage ended ${Math.round((nowMs - this.lastActiveMs) / 60_000)} min ago; ` +
          `assumed on the generator for ${GEN.RESTORE_TAIL_MS / 60_000} min after (transfer-switch retransfer)`, assumed: false };
      }
      return { supply: "grid", why: "no outage reported (6bb feed)", assumed: false };
    }
    const min = (ms: number) => Math.round(ms / 60_000);
    const silent = this.answerMs == null ? `the outage feed has not answered in the ${min(nowMs - this.startMs)} min since the planner started`
      : `the outage feed has not answered for ${min(nowMs - this.answerMs)} min`;
    if (this.answerMs == null && nowMs - this.startMs < GEN.FEED_STARTUP_GRACE_MS) return { supply: "unknown", why: silent, assumed: false };
    if (this.active) return { supply: "unknown", why: `${silent}; its last answer was an active outage`, assumed: false };
    if (this.lastActiveMs != null && nowMs - this.lastActiveMs < GEN.SILENT_OUTAGE_RECENT_MS) {
      return { supply: "unknown", why: `${silent}; an outage was seen ${min(nowMs - this.lastActiveMs)} min ago`, assumed: false };
    }
    return { supply: "grid", why: `${silent}; assuming the grid (no outage seen in the last ${GEN.SILENT_OUTAGE_RECENT_MS / 3600_000} h)`, assumed: true };
  }

  status(nowMs: number): Record<string, unknown> {
    return {
      ...this.supply(nowMs),
      last_answer_at: this.answerMs == null ? null : new Date(this.answerMs).toISOString(),
      outage_active: this.active,
      last_outage_seen_at: this.lastActiveMs == null ? null : new Date(this.lastActiveMs).toISOString(),
      last_failure: this.failure,
    };
  }
}

export interface ZoneTemp {
  id: string;
  name: string;
  roomF: number | null;
  setpointF: number | null;
  /** TempIQ's thermostat mode; "off" = not occupied. null/absent = unknown (counts as occupied) */
  mode?: string | null;
  deliveryType?: string;
}
export interface Comfort {
  at_risk: boolean | null;
  coldest: { name: string; room_f: number; setpoint_f: number | null } | null;
  why: string;
  /** occupied zones whose temperature is missing or stale (they make an otherwise-fine verdict unknown) */
  unknown?: string[];
}

/**
 * Zones TempIQ reports that are not the house. Measured (zone_floor_snapshots, 14 days to 2026-10-29): "Barn - Tack"
 * read exactly 59 °F in 344 of 344 samples (a stuck sensor), and "Barn Basement" is held at 55.4 °F on purpose. Either
 * would put the 60 °F floor permanently "at risk". COMFORT_EXCLUDE_ZONES (comma-separated names) replaces this list.
 */
export const DEFAULT_COMFORT_EXCLUDE = ["Barn - Tack", "Barn Basement"];
export function parseComfortExclude(env: Record<string, string | undefined>): string[] {
  const v = env.COMFORT_EXCLUDE_ZONES;
  return v == null ? DEFAULT_COMFORT_EXCLUDE : v.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * TempIQ's zone payload carries no per-zone reading time, so staleness is inferred: a room temperature that has not
 * changed for STALE_MS is treated as stale (a sensor or integration that stopped reporting keeps serving its last
 * value — "Barn - Tack" above). A real occupied room moves by a step in hours, and certainly once the heat is failing.
 * comfortRisk asks only about a room below its setpoint: one a thermostat holds does not move, and that means nothing.
 */
export class ZoneAges {
  static readonly STALE_MS = 6 * 3600_000;
  private seen = new Map<string, { roomF: number | null; sinceMs: number }>();
  observe(zones: ZoneTemp[], nowMs: number): void {
    for (const z of zones) {
      const prev = this.seen.get(z.id);
      if (!prev || prev.roomF !== z.roomF) this.seen.set(z.id, { roomF: z.roomF, sinceMs: nowMs });
    }
  }
  stale(id: string, nowMs: number): boolean {
    const s = this.seen.get(id);
    return s != null && nowMs - s.sinceMs >= ZoneAges.STALE_MS;
  }
  status(nowMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, s] of this.seen) out[id] = Math.round((nowMs - s.sinceMs) / 60_000);
    return out;
  }
}

/**
 * Owner (2026-10-29): ALL OCCUPIED ZONES count, and the coldest drives the decision. Occupied = a zone with a heating
 * call, or with a setpoint whose thermostat is not OFF (an OFF Nest — the baseboard and dining comfort-only zones — has no
 * setpoint and is not occupied). DHW and the excluded zones never count. Every occupied zone is checked against the
 * floor (< FLOOR_F + FLOOR_BUFFER_F) and its own target (≤ setpoint − TARGET_DEFICIT_F), set back or satisfied or not.
 * Verdict: at risk if ANY occupied zone with a fresh temperature is; otherwise UNKNOWN if any occupied zone has no
 * temperature or a stale one (never silently dropped); otherwise not at risk.
 */
export function comfortRisk(zones: ZoneTemp[] | null, callingIds: string[] | null,
  opts: { nowMs?: number; ages?: ZoneAges; exclude?: string[] } = {}): Comfort {
  if (!zones) return { at_risk: null, coldest: null, why: "TempIQ zone temperatures unavailable" };
  const exclude = new Set((opts.exclude ?? DEFAULT_COMFORT_EXCLUDE).map((n) => n.trim().toLowerCase()));
  const occupied = zones.filter((z) => z.deliveryType !== "dhw" && !exclude.has(z.name.trim().toLowerCase())
    && ((callingIds?.includes(z.id) ?? false) || (z.setpointF != null && !/^off$/i.test(z.mode ?? ""))));
  if (!occupied.length) return { at_risk: null, coldest: null, why: "no occupied zone reported" };
  const now = opts.nowMs ?? Date.now();
  // TempIQ reports 0.5 °C steps, so a room a thermostat holds sits in one bucket for hours: an unchanged value says
  // nothing at or above the setpoint, and treating it as unknown would hand a warm, steady house the element
  const held = (z: ZoneTemp) => z.roomF != null && z.setpointF != null && z.roomF >= z.setpointF;
  const unknown = occupied.filter((z) => z.roomF == null || (!held(z) && (opts.ages?.stale(z.id, now) ?? false)));
  const known = occupied.filter((z): z is ZoneTemp & { roomF: number } => !unknown.includes(z) && z.roomF != null);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const unk = unknown.map((z) => `${z.name} ${z.roomF == null ? "no temperature" : `stale at ${r1(z.roomF)} °F`}`);
  const coldestZ = known.length ? known.reduce((a, b) => (b.roomF < a.roomF ? b : a)) : null;
  const c = coldestZ ? { name: coldestZ.name, room_f: coldestZ.roomF, setpoint_f: coldestZ.setpointF } : null;
  if (coldestZ && coldestZ.roomF < GEN.FLOOR_F + GEN.FLOOR_BUFFER_F) {
    return { at_risk: true, coldest: c, unknown: unk, why: `${coldestZ.name} is ${r1(coldestZ.roomF)} °F — within ${GEN.FLOOR_BUFFER_F} °F of the ${GEN.FLOOR_F} °F floor` };
  }
  const behind = known.filter((z) => z.setpointF != null && z.roomF <= z.setpointF - GEN.TARGET_DEFICIT_F)
    .sort((a, b) => (a.roomF - a.setpointF!) - (b.roomF - b.setpointF!));
  if (behind.length) {
    const z = behind[0];
    return { at_risk: true, coldest: c, unknown: unk, why: `${z.name} is ${r1(z.roomF)} °F, ${r1(z.setpointF! - z.roomF)} °F below its ${r1(z.setpointF!)} °F setpoint` };
  }
  if (unk.length) return { at_risk: null, coldest: c, unknown: unk, why: `no temperature to trust for ${unk.join(", ")}` };
  return { at_risk: false, coldest: c, unknown: unk, why: `the coldest occupied zone, ${coldestZ!.name}, is ${r1(coldestZ!.roomF)} °F` +
    (coldestZ!.setpointF != null ? ` (setpoint ${r1(coldestZ!.setpointF)} °F)` : "") };
}

export interface GenInput {
  nowMs: number;
  supply: { supply: Supply; why: string; assumed?: boolean };
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
  /** generator or unknown: the generator rule applies (element never; the budget is reported) */
  budget_applies: boolean;
  cap_w: number;
  margin_w: number;
  element_w: number;
  house_w: number | null;
  /** house + element + margin */
  projected_w: number | null;
  budget_fits: boolean | null;
  comfort: Comfort;
  /** the gate may close the element breaker (its own rules still decide whether it wants to). Never on the generator
   *  or an unknown supply (owner, 2026-11-02) */
  element_allowed: boolean;
  element_why: string;
  /** advisory: the breaker is ON on the generator without headroom for the element, or with the load unknown */
  shed: boolean;
  /** advisory: both pumps run on the generator with the house within the margin of the cap */
  one_pump: boolean;
}

export function assess(i: GenInput, cfg: GenConfig = DEFAULT_GEN_CONFIG): GenAssessment {
  const applies = i.supply.supply !== "grid";
  const projected = i.houseW == null ? null : i.houseW + GEN.ELEMENT_W + cfg.marginW;
  const fits = projected == null ? null : projected <= cfg.capW;
  // owner 2026-11-02: never on the generator, whatever the budget and comfort say; unknown supply = the generator
  const allowed = !applies;
  const why = !applies ? (i.supply.assumed ? "assumed on the grid (the outage feed is silent): no generator limit" : "on the grid: no generator limit")
    : i.supply.supply === "generator" ? "on the generator: the element is never used there (owner, 2026-11-02)"
    : "the supply is unknown, so it is treated as the generator: the element is never used there (owner, 2026-11-02)";
  return {
    supply: i.supply.supply, supply_why: i.supply.why, budget_applies: applies,
    cap_w: cfg.capW, margin_w: cfg.marginW, element_w: GEN.ELEMENT_W,
    house_w: i.houseW == null ? null : Math.round(i.houseW), projected_w: projected == null ? null : Math.round(projected),
    budget_fits: fits, comfort: i.comfort, element_allowed: allowed, element_why: why,
    shed: applies && i.relay === "CLOSED" && fits !== true,
    one_pump: applies && (i.pumpsEngaged ?? 0) >= 2 && i.houseW != null && i.houseW + cfg.marginW > cfg.capW,
  };
}

/** The budget in one line, for the shed notice and the one-pump log. */
export function budgetLine(g: GenAssessment): string {
  return `${g.supply_why}. House ${g.house_w ?? "?"} W + element ${g.element_w} W + margin ${g.margin_w} W = ` +
    `${g.projected_w ?? "?"} W against the ${g.cap_w} W cap.`;
}

/** The alert-episode kind for generator notices, by the gate's mode (as index.ts's backupGateKind). */
export const genEpisodeKind = (mode: string): "generator" | "generator_shadow" =>
  mode === "live" ? "generator" : "generator_shadow";

/** The `shed` notice. Live it must not claim SHADOW; with the load unknown it must not claim there is no headroom. */
export function shedNotice(mode: string, g: GenAssessment): { title: string; body: string } {
  const live = mode === "live";
  const unknown = g.house_w == null;
  const reason = unknown
    ? `${g.supply_why}. The live house load is unknown, so nothing shows the ${g.element_w} W element fits under the ${g.cap_w} W cap.`
    : budgetLine(g);
  return {
    title: `Backup element${live ? "" : " (shadow)"}: breaker is ON on the generator ${unknown ? "with the house load unknown" : "without headroom"}`,
    body: `${live ? "" : "SHADOW — nothing was switched. "}The Buffer Tank breaker is ON, so the HBX can fire the 16.5 kW element at any moment, ` +
      `but ${reason} A2W does NOT switch it off — nothing re-opens the breaker on the generator${live ? "" : " (an owner decision before going live)"}. ` +
      "If you can, switch it off at the SPAN panel or in the 6bb app, or shed another big load (EV charger).",
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
