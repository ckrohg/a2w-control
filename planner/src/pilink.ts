/**
 * @purpose #165 (wave N1, eval 2026-10-18 F1): the Pi link's story from tables the planner already shares with the
 * analytics mirror — no house network needed. Five 2–3 h dropouts in four days (Oct 14–17) left `phase_b_log` full of
 * `failed: no Pi connected`; the question each one raises is WHICH failure it was:
 *   gap+reboot  — the Pi's 60-s exporter (a path that bypasses the hub) ALSO went silent (`readings` gap) and the Pi
 *                 came back freshly booted (`system_stats.uptime_s` reset at reconnect): a WiFi stall cleared only by
 *                 deploy/bridge-watchdog.sh's 120-min reboot ladder;
 *   gap_only    — readings stopped too, but the Pi did not reboot: the link recovered on its own;
 *   socket_only — readings CONTINUED: the Pi was online and only the hub websocket was down;
 *   unknown     — the mirror tables do not cover the window (absent, or no readings before it).
 * Pure: the SQL reductions (readings gaps, uptime resets) live in store.ts piLinkInputs; this module turns them into
 * windows and verdicts so planner/src/pilink.test.ts can assert all of it over a synthetic history.
 */

/** phase_b_log's own words for a write the hub refused because the Pi was gone (hub/src/index.ts 503 detail). */
export const NO_PI = /no Pi connected/;
/** Readings arrive every ~60 s; a step of more than this between consecutive pushes is a gap. */
export const READING_GAP_MIN_S = 5 * 60;
/** How far outside a window a readings gap or a boot may sit and still belong to it (phase_b_log is 5-min grained). */
export const WINDOW_SLACK_S = 10 * 60;
/**
 * A reboot between two system_stats samples needs uptime evidence, not just a moved boot time (codex passes 1–2 on
 * #193: an NTP step forward moves ts − uptime_s exactly like a reboot does). CERTAIN: uptime fell. AMBIGUOUS: the boot
 * time jumped by more than this while uptime kept rising but is shorter than the time since the previous sample — a
 * reboot of a Pi that had only just booted, or a clock step on one; two samples cannot tell which. A clock step on a
 * Pi up longer than the step is neither. store.piLinkInputs applies it in SQL.
 */
export const BOOT_JUMP_S = 5 * 60;
/** A difference between the ts step and the uptime step larger than this between two samples is a clock step. */
export const CLOCK_STEP_S = 2 * 60;
/** Mirror samples stamped further than this AHEAD of the planner's clock are quarantined (a Pi clock running fast). */
export const FUTURE_S = 2 * 60;
/** A reboot is certain only after this much later history stayed on its new boot track (codex pass 7 on #193). */
export const SETTLE_S = 15 * 60;

export type PiVerdict = "gap+reboot" | "gap_only" | "socket_only" | "unknown";

/** One phase_b_log row (mode 'active'): epoch ms + the result string. */
export interface PhaseBRow { ts: number; result: string }
/** A readings gap: the last push before it and the first after it (epoch s, the Pi's clock). */
export interface ReadingGap { start: number; end: number }
/** A detected reboot: the new boot time (epoch s = ts − uptime_s of the first row after it). */
export interface Boot { at: number }

export interface DropoutRun { start: number; end: number | null }
export interface DropoutWindow {
  start: string;
  /** null = still ongoing at the last phase_b_log row */
  end: string | null;
  minutes: number;
  verdict: PiVerdict;
  /** The longest readings gap overlapping the window (minutes), or null. */
  readings_gap_min: number | null;
  /** The boot inside the window's slack, or null. */
  reboot_at: string | null;
}

/**
 * Maximal runs of `no Pi connected` in phase_b_log (both pumps interleaved, sorted by time). A run ends at the first
 * `sent` — the hub accepted a write, so the Pi was back. Other results (lease skips, dry-runs, other failures) say
 * nothing about the Pi and neither extend nor end a run. A run with no closing `sent` is ongoing (end null).
 */
export function dropoutRuns(rows: PhaseBRow[]): DropoutRun[] {
  const out: DropoutRun[] = [];
  let open: number | null = null;
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (NO_PI.test(r.result)) { open ??= r.ts; continue; }
    if (r.result === "sent" && open !== null) { out.push({ start: open, end: r.ts }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: null });
  return out;
}

/** Reboots closer together than this are one boot (a fresh Pi's NTP step right after boot re-trips the predicate). */
export const BOOT_MERGE_S = 15 * 60;

/** Collapse near-duplicate boots (sorted output). */
export function mergeBoots(boots: Boot[]): Boot[] {
  const out: Boot[] = [];
  for (const b of [...boots].sort((x, y) => x.at - y.at)) {
    if (!out.length || b.at - out[out.length - 1].at > BOOT_MERGE_S) out.push(b);
  }
  return out;
}

export interface ReadingsView {
  gaps: ReadingGap[];
  firstTs: number | null;
  lastTs: number | null;
  /**
   * Clock-CONTAMINATED spans (epoch s) from readings in INGESTION order (readings.id): a backward step re-stamped
   * (start, end] — rows there were stamped twice, so timestamps cannot order events in it (codex passes 8–9 on #193).
   */
  clockIntervals?: { start: number; end: number }[];
  /**
   * Spans the Pi clock was KNOWN (or cannot be shown not) to be misaligned against the planner's (piHealth: now, past,
   * or unanchored). Unlike a contamination span this voids even a certain reboot: uptime proves a reboot happened, not
   * that it lines up with the planner's window (codex pass 16 on #193).
   */
  misaligned?: { start: number; end: number }[];
}
export interface StatsView {
  /** certain reboots: uptime FELL between consecutive samples */
  boots: Boot[];
  /**
   * boot-time jumps that are a reboot OR a clock step on a freshly booted Pi — uptime kept rising but is shorter than
   * the time since the previous sample. Indistinguishable from two samples (codex pass 2 on #193): never counted as a
   * reboot, and a gap whose only evidence is one of these is `unknown`.
   */
  ambiguous?: Boot[];
  /** Pi-clock discontinuities (epoch s): ts moved unlike uptime between consecutive samples — an NTP step */
  clockSteps?: number[];
  /** the same steps, signed: delta > 0 = the clock jumped forward by delta seconds at ts */
  clockStepDeltas?: { ts: number; delta: number }[];
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Verdict per window (codex pass 1 on #193 tightened every rule):
 * - the readings gap must substantially belong to the window — at least half of it inside the window ± slack — so an
 *   unrelated gap just before/after does not turn a socket outage into a gap;
 * - the reboot must be the one that ended THAT gap — inside [gap start − 1 min, gap end + 2 min] (the Pi boots, then
 *   its first push closes the gap) — not merely somewhere in the window;
 * - a gap overlapping the window that does NOT clearly belong to it, or a Pi-clock step within window ± slack →
 *   `unknown` (unless a certain reboot was found): continuity is never assumed;
 * - gap+reboot vs gap_only needs system_stats samples bracketing the gap (first ≤ gap start, last ≥ gap end): absent,
 *   empty, late-starting stats, a gap still open now, or only an AMBIGUOUS boot jump in it → `unknown`, never a
 *   guessed gap_only;
 * - no readings before the window → `unknown`.
 * `readings` null = the table is absent; `stats` null likewise. A silence that has not ended (trailing) is a gap.
 */
export function classifyWindows(
  runs: DropoutRun[],
  readings: ReadingsView | null,
  stats: StatsView | null,
  nowS: number,
): DropoutWindow[] {
  const gaps: ReadingGap[] = readings ? [...readings.gaps] : [];
  const trailing = readings?.lastTs != null && nowS - readings.lastTs > READING_GAP_MIN_S;
  if (trailing) gaps.push({ start: readings!.lastTs as number, end: nowS });
  const boots = stats ? mergeBoots(stats.boots) : [];
  return runs.map((r) => {
    const s = r.start / 1000;
    const e = r.end == null ? nowS : r.end / 1000;
    const lo = s - WINDOW_SLACK_S, hi = e + WINDOW_SLACK_S;
    const covered = readings != null && readings.firstTs != null && readings.firstTs <= s;
    const inside = (g: ReadingGap) => Math.max(0, Math.min(g.end, hi) - Math.max(g.start, lo));
    const core = (g: ReadingGap) => Math.max(0, Math.min(g.end, e) - Math.max(g.start, s));
    // a gap belongs to the window when at least half of it lies inside window ± slack, OR it covers at least half of
    // the window itself (a long silence spanning a short socket outage — codex pass 2 on #193)
    const belongs = (g: ReadingGap) => inside(g) >= READING_GAP_MIN_S
      && (inside(g) >= (g.end - g.start) / 2 || core(g) >= (e - s) / 2);
    // EVERY gap that belongs is weighed (codex pass 3 on #193): a reboot in any of them is gap+reboot; otherwise any
    // unresolved one (still open, not bracketed by stats, only an ambiguous boot, or a clock step at its edges — the
    // "gap" may be the Pi's clock jumping, not a silence) makes the verdict unknown; only all-resolved is gap_only
    const mine = gaps.filter(belongs);
    // a gap that overlaps the window itself but does not clearly belong to it — whether or not another gap does: its
    // uncertainty is kept (codex pass 4 on #193); continuity is NOT established
    const unclear = gaps.some((g) => core(g) > 0 && !belongs(g));
    // a Pi-clock step anywhere in the window ± slack: timestamp order no longer proves arrival order, so a silence may
    // have been papered over (a backward step refills the gap) — never socket_only / gap_only on that evidence
    const stepNear = (stats?.clockSteps ?? []).some((t) => t >= lo && t <= hi)
      || (readings?.clockIntervals ?? []).some((c) => c.start <= hi && c.end >= lo);
    const near = (g: ReadingGap, t: number) => t >= g.start - 120 && t <= g.end + 120;
    let boot: Boot | null = null;
    let unresolved = false;
    for (const g of mine) {
      const open = trailing && g.end === nowS;
      const bracketed = !open && stats != null && stats.firstTs != null && stats.lastTs != null
        && stats.firstTs <= g.start && stats.lastTs >= g.end;
      const certain = bracketed ? boots.find((b) => near(g, b.at) && b.at >= g.start - 60) ?? null : null;
      if (certain) { boot ??= certain; continue; }
      if (!bracketed || (stats?.ambiguous ?? []).some((b) => near(g, b.at)) || (stats?.clockSteps ?? []).some((t) => near(g, t))) unresolved = true;
    }
    const longest = mine.reduce<ReadingGap | null>((a, g) => (!a || g.end - g.start > a.end - a.start ? g : a), null);
    const misaligned = (readings?.misaligned ?? []).some((c) => c.start <= hi && c.end >= lo);
    const verdict: PiVerdict = !covered || misaligned ? "unknown"
      : boot ? "gap+reboot"
      : unclear || stepNear || unresolved ? "unknown"
      : !mine.length ? "socket_only" : "gap_only";
    return {
      start: new Date(r.start).toISOString(),
      end: r.end == null ? null : new Date(r.end).toISOString(),
      minutes: Math.round((e - s) / 6) / 10,
      verdict,
      readings_gap_min: longest ? Math.round((longest.end - longest.start) / 6) / 10 : null,
      reboot_at: boot ? new Date(boot.at * 1000).toISOString() : null,
    };
  });
}

export interface PiLinkInputs {
  /** newest readings ts per pump over the WHOLE table (epoch s), or null when the readings table is absent */
  lastByPump: Record<string, number> | null;
  /** gaps + coverage over the analysis range, or null when the table is absent */
  readings: ReadingsView | null;
  /** newest system_stats row, or null when absent / empty */
  latestStat: { ts: number; uptime_s: number | null } | null;
  /** reboots (with uptime evidence) + coverage over the analysis range, or null when the table is absent */
  stats: StatsView | null;
  /** phase_b_log rows from a day BEFORE the 7-d window, so a run that straddles the edge keeps its real start */
  phaseB: PhaseBRow[];
  /** any readings / system_stats row stamped ahead of the planner clock (beyond FUTURE_S): the Pi clock runs fast NOW */
  futureRows?: boolean;
}

/**
 * The Pi clock against the planner's, NOW (codex pass 14 on #193): windows come from phase_b_log (planner clock) and are
 * matched against readings / system_stats (Pi clock). While the Pi clock is misaligned — future-stamped rows exist, or
 * the live offset measured from the hub's latest frame (planner now − frame ts, index.ts) exceeds CLOCK_STEP_S — every
 * Pi timestamp since the last detected clock step is shifted by an unknown amount, so every window since then is
 * `unknown`. Returns where that span starts, or null when aligned.
 */
export function misalignedSince(input: PiLinkInputs, nowS: number, liveOffsetS: number | null, fromS: number): number | null {
  const live = liveOffsetS != null && Math.abs(liveOffsetS) > CLOCK_STEP_S;
  if (!input.futureRows && !live) return null;
  const steps = (input.stats?.clockSteps ?? []).filter((t) => t < nowS - 1);
  return steps.length ? Math.max(...steps) : fromS;
}

/** Windows are reported when they ENDED (or are still open) within this — the hub's own convention (#178). */
export const DROPOUT_WINDOW_S = 7 * 86_400;
/** How much earlier the inputs start, so runs straddling the 7-d edge are seen whole (store.piLinkInputs). */
export const LOOKBACK_S = 86_400;

export interface PiHealth {
  computed_at: string;
  /** mirror tables present — false in a fresh DB the mirror never wrote (the rehearsal) */
  mirror_tables: { readings: boolean; system_stats: boolean };
  last_reading_age_s: number | null;
  last_reading_by_pump: Record<string, { ts: string; age_s: number }>;
  uptime_s: number | null;
  /** age of the system_stats row uptime_s came from */
  uptime_age_s: number | null;
  reboots_24h: number | null;
  reboots_7d: number | null;
  last_reboot_at: string | null;
  /** the Pi clock vs the planner's: misaligned_since non-null = every window since then is unknown */
  pi_clock: { live_offset_s: number | null; future_rows: boolean; misaligned_since: string | null; past_misaligned: { start: string; end: string }[]; unanchored: boolean };
  dropouts_7d: DropoutWindow[];
  summary: { count: number; longest_min: number | null; verdicts: Record<PiVerdict, number> };
}

/** Assemble /health.pi. The windows come from the planner's own phase_b_log, corroborated by the mirror's tables. */
/**
 * Past misalignment (codex pass 15 on #193): with the clock aligned NOW, the signed steps reconstruct its offset back in
 * time — 0 after the last step, minus each step's delta before it — so a span the clock spent off by more than
 * CLOCK_STEP_S (a Pi running an hour slow for two days, then corrected) is found even after the correction. Pure.
 */
export function historicMisalignment(deltas: { ts: number; delta: number }[], fromS: number, nowS: number): { start: number; end: number }[] {
  const steps = [...deltas].filter((d) => d.ts < nowS).sort((a, b) => a.ts - b.ts);
  const out: { start: number; end: number }[] = [];
  let offset = 0; // the clock's offset (Pi − true) on the segment AFTER steps[i]; 0 after the last one
  for (let i = steps.length - 1; i >= 0; i--) {
    offset -= steps[i].delta;                     // …and before it
    const start = i > 0 ? steps[i - 1].ts : fromS;
    if (Math.abs(offset) > CLOCK_STEP_S) out.push({ start, end: steps[i].ts });
  }
  return out.reverse();
}

export function piHealth(input: PiLinkInputs, nowMs: number, liveOffsetS: number | null = null): PiHealth {
  const nowS = nowMs / 1000;
  const fromS = nowS - DROPOUT_WINDOW_S - LOOKBACK_S;
  const since = misalignedSince(input, nowS, liveOffsetS, fromS);
  // The clock is shown aligned NOW only by a fresh live offset within CLOCK_STEP_S (codex pass 16 on #193: no hub
  // frame ≠ aligned). Aligned → reconstruct PAST misaligned spans from the signed steps. Misaligned now → the span
  // since the last step. Unanchored (no fresh frame, no future rows) with clock steps in range → which segment was
  // right cannot be told → the whole range is uncertain. No steps at all → no evidence of any clock change.
  const anchored = liveOffsetS != null && Math.abs(liveOffsetS) <= CLOCK_STEP_S;
  const deltas = (input.stats?.clockStepDeltas ?? []).filter((d) => d.ts < nowS);
  const past = since == null && anchored ? historicMisalignment(deltas, fromS, nowS) : [];
  const unanchored = since == null && !anchored && deltas.some((d) => Math.abs(d.delta) > CLOCK_STEP_S);
  const spans = [...past, ...(since == null ? [] : [{ start: since, end: nowS }]), ...(unanchored ? [{ start: fromS, end: nowS }] : [])];
  // misaligned spans void verdicts through every evidence path, a certain reboot included
  const readingsView = !spans.length || !input.readings ? input.readings
    : { ...input.readings, clockIntervals: [...(input.readings.clockIntervals ?? []), ...spans], misaligned: spans };
  const statsView = !spans.length || !input.stats ? input.stats
    : { ...input.stats, clockSteps: [...(input.stats.clockSteps ?? []), ...spans.flatMap((x) => [x.start, x.end])] };
  const by: PiHealth["last_reading_by_pump"] = {};
  for (const [id, ts] of Object.entries(input.lastByPump ?? {})) by[id] = { ts: new Date(ts * 1000).toISOString(), age_s: Math.round(nowS - ts) };
  const tsList = Object.values(input.lastByPump ?? {});
  const newest = tsList.length ? Math.max(...tsList) : null;
  const windows = classifyWindows(
    dropoutRuns(input.phaseB).filter((r) => r.end == null || nowS - r.end / 1000 <= DROPOUT_WINDOW_S),
    readingsView, statsView, nowS);
  const verdicts: Record<PiVerdict, number> = { "gap+reboot": 0, gap_only: 0, socket_only: 0, unknown: 0 };
  for (const w of windows) verdicts[w.verdict]++;
  const boots = input.stats ? mergeBoots(input.stats.boots) : [];
  const lastBoot = boots.length ? Math.max(...boots.map((b) => b.at)) : null;
  return {
    computed_at: new Date(nowMs).toISOString(),
    mirror_tables: { readings: input.lastByPump !== null, system_stats: input.stats !== null },
    last_reading_age_s: newest == null ? null : Math.round(nowS - newest),
    last_reading_by_pump: by,
    uptime_s: input.latestStat?.uptime_s ?? null,
    uptime_age_s: input.latestStat ? Math.round(nowS - input.latestStat.ts) : null,
    reboots_24h: input.stats === null ? null : boots.filter((b) => nowS - b.at <= 86_400).length,
    reboots_7d: input.stats === null ? null : boots.filter((b) => nowS - b.at <= DROPOUT_WINDOW_S).length,
    last_reboot_at: lastBoot == null ? null : new Date(lastBoot * 1000).toISOString(),
    pi_clock: {
      live_offset_s: liveOffsetS == null ? null : Math.round(liveOffsetS),
      future_rows: !!input.futureRows,
      misaligned_since: since == null ? null : new Date(since * 1000).toISOString(),
      past_misaligned: past.map((x) => ({ start: new Date(x.start * 1000).toISOString(), end: new Date(x.end * 1000).toISOString() })),
      /** no fresh hub frame to anchor the present, and clock steps in range: every window is unknown */
      unanchored,
    },
    dropouts_7d: windows,
    summary: {
      count: windows.length,
      longest_min: windows.length ? Math.max(...windows.map((w) => w.minutes)) : null,
      verdicts,
    },
  };
}

/**
 * /health serves the cached computation (refreshed every few minutes off the request path) with its ages advanced
 * to the scrape time, so `last_reading_age_s` keeps climbing between refreshes instead of freezing. Never mutates.
 */
export function withLiveAges(h: PiHealth, nowMs: number): PiHealth {
  const dt = Math.max(0, Math.round((nowMs - Date.parse(h.computed_at)) / 1000));
  const by: PiHealth["last_reading_by_pump"] = {};
  for (const [id, v] of Object.entries(h.last_reading_by_pump)) by[id] = { ...v, age_s: v.age_s + dt };
  return {
    ...h,
    last_reading_age_s: h.last_reading_age_s == null ? null : h.last_reading_age_s + dt,
    last_reading_by_pump: by,
    uptime_age_s: h.uptime_age_s == null ? null : h.uptime_age_s + dt,
  };
}
