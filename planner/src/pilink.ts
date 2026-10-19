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
/** How far the Pi's boot time (ts − uptime_s) must jump forward to count as a reboot (absorbs clock/NTP jitter). */
export const BOOT_JUMP_S = 5 * 60;

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

/**
 * Verdict per window. `readings` = what the mirror's readings table can say: null when the table is absent; else the
 * gaps over the period, the oldest reading (no coverage before it) and the newest (a trailing silence up to `nowS`
 * counts as a gap). `boots` = null when system_stats is absent (a gap is then gap_only — no reboot evidence).
 */
export function classifyWindows(
  runs: DropoutRun[],
  readings: { gaps: ReadingGap[]; firstTs: number | null; lastTs: number | null } | null,
  boots: Boot[] | null,
  nowS: number,
): DropoutWindow[] {
  const gaps: ReadingGap[] = readings ? [...readings.gaps] : [];
  if (readings?.lastTs != null && nowS - readings.lastTs > READING_GAP_MIN_S) gaps.push({ start: readings.lastTs, end: nowS });
  return runs.map((r) => {
    const s = r.start / 1000;
    const e = r.end == null ? nowS : r.end / 1000;
    const lo = s - WINDOW_SLACK_S, hi = e + WINDOW_SLACK_S;
    const covered = readings != null && readings.firstTs != null && readings.firstTs <= s;
    const gap = gaps.filter((g) => g.start < hi && g.end > lo)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] ?? null;
    const boot = (boots ?? []).find((b) => b.at >= lo && b.at <= hi) ?? null;
    const verdict: PiVerdict = !covered ? "unknown" : gap ? (boot ? "gap+reboot" : "gap_only") : "socket_only";
    return {
      start: new Date(r.start).toISOString(),
      end: r.end == null ? null : new Date(r.end).toISOString(),
      minutes: Math.round((e - s) / 6) / 10,
      verdict,
      readings_gap_min: gap ? Math.round((gap.end - gap.start) / 6) / 10 : null,
      reboot_at: boot ? new Date(boot.at * 1000).toISOString() : null,
    };
  });
}

export interface PiLinkInputs {
  /** newest readings ts per pump (epoch s), or null when the readings table is absent */
  lastByPump: Record<string, number> | null;
  readings: { gaps: ReadingGap[]; firstTs: number | null; lastTs: number | null } | null;
  /** newest system_stats row, or null when absent / empty */
  latestStat: { ts: number; uptime_s: number | null } | null;
  /** reboots detected in system_stats, or null when the table is absent */
  boots: Boot[] | null;
  phaseB: PhaseBRow[];
}

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
  dropouts_7d: DropoutWindow[];
  summary: { count: number; longest_min: number | null; verdicts: Record<PiVerdict, number> };
}

/** Assemble /health.pi. The windows come from the planner's own phase_b_log, corroborated by the mirror's tables. */
export function piHealth(input: PiLinkInputs, nowMs: number): PiHealth {
  const nowS = nowMs / 1000;
  const by: PiHealth["last_reading_by_pump"] = {};
  for (const [id, ts] of Object.entries(input.lastByPump ?? {})) by[id] = { ts: new Date(ts * 1000).toISOString(), age_s: Math.round(nowS - ts) };
  const tsList = Object.values(input.lastByPump ?? {});
  const newest = tsList.length ? Math.max(...tsList) : null;
  const windows = classifyWindows(dropoutRuns(input.phaseB), input.readings, input.boots, nowS);
  const verdicts: Record<PiVerdict, number> = { "gap+reboot": 0, gap_only: 0, socket_only: 0, unknown: 0 };
  for (const w of windows) verdicts[w.verdict]++;
  const boots = input.boots ?? [];
  const lastBoot = boots.length ? Math.max(...boots.map((b) => b.at)) : null;
  return {
    computed_at: new Date(nowMs).toISOString(),
    mirror_tables: { readings: input.lastByPump !== null, system_stats: input.boots !== null },
    last_reading_age_s: newest == null ? null : Math.round(nowS - newest),
    last_reading_by_pump: by,
    uptime_s: input.latestStat?.uptime_s ?? null,
    uptime_age_s: input.latestStat ? Math.round(nowS - input.latestStat.ts) : null,
    reboots_24h: input.boots === null ? null : boots.filter((b) => nowS - b.at <= 86_400).length,
    reboots_7d: input.boots === null ? null : boots.filter((b) => nowS - b.at <= 7 * 86_400).length,
    last_reboot_at: lastBoot == null ? null : new Date(lastBoot * 1000).toISOString(),
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
