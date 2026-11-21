/**
 * @purpose Pure logic for the DHW morning check (owner rule: "Any lukewarm shower is BAD"): for one local
 * America/New_York day and one shower window [startHour, endHour), decide whether the planner's #135 pre-boost was
 * PLANNED (the lead-hour block of the plan in force before the lead hour began), whether it was WRITTEN (hbx_writes
 * between one hour before the lead hour and the window start), how warm the tank was when the window opened, and
 * whether any draw that started inside the window began on a tank below the bar (default 120 °F). No I/O and no clock
 * here — the CLI in scripts/dhw-morning-check.ts reads the LOCAL restore and feeds these functions;
 * scripts/dhw-morning.test.ts checks them on hand-built fixtures.
 *
 * Definitions, each taken from the planner so the check and production cannot drift apart silently:
 *   lead hour      shadow.ts places the boost on the LATEST of the prechargeLookbackH (3) hours before the window start
 *                  that lies outside every window ("the hour before the bell unless that hour belongs to another
 *                  peak"). A window starting at hour 0 leads from the previous day's hour 23. No such hour = no lead,
 *                  and production plans no boost for that window either.
 *   planned_boost  the lead block has boost === true or a reason matching /pre-?boost/i (identify.ts
 *                  planConflictAhead reads a pre-boost the same way). The block's target is ShadowBlock.tank_target_f.
 *   boost_written  an ACCEPTED hbx_writes row in the interval that raised the commanded level by ≥ RAISE_MIN_F over
 *                  the last accepted write before it, or an accepted row with action "boost". writes.ts: actions are
 *                  set_target / set_curve / restore / boost, results accepted / rejected / failed / verify_mismatch /
 *                  arming / expired. A boost that LANDS is audited as set_target (boost() funnels through
 *                  setTargetSerial), so action "boost" only ever carries rejected / arming / expired — the raise rule
 *                  is what finds a landed boost. The commanded level comes from the audit detail patch() wrote
 *                  ("target N°F commanded…", "…(output N°F at M°F outdoor…"), else the dbt/mbt midpoint of a
 *                  set_target; the as-found restore carries no level and resets the comparison.
 *                  Reads false when the plan held the boost hour at a level already in force (raiseBoostsToGuard on a
 *                  flat winter plan: a 135 °F guard hour before and after) — nothing is written then; held_f, the
 *                  level in force at the window start, shows it.
 *   draw           dhw.ts detectDrawTimes (a ≥ 1.5 °F fall between adjacent samples), merged into one event per
 *                  DRAW_MERGE_MIN and troughed over the contiguous samples within SAG_HORIZON_MIN, exactly as
 *                  measureWindowSags does. pre_draw_f is the sample just before the fall. WINTER CAVEAT (dhw.ts): a
 *                  space-heat call pulls the buffer too, so a heating-season "draw" is a draw OR a zone call.
 *   verdict        FAIL when a draw that started inside the window had pre_draw_f below the bar; OK otherwise;
 *                  NO_DRAWS when none started inside it; NO_DATA when the restore holds no tank reading inside the
 *                  window (never reported as OK). NO_BOOST is a warning beside the verdict: the window had draws but
 *                  the boost was not planned or not written.
 */
import { detectDrawTimes, SAG_HORIZON_MIN, DRAW_MERGE_MIN, parseShowerWindows } from "../planner/src/dhw";

// ---- constants ------------------------------------------------------------------------------------------------
export const TZ = "America/New_York";
export const DEFAULT_FAIL_BELOW_F = 120; // owner: a morning fails if the tank is below 120 °F when a shower-hour draw begins
export const LEAD_LOOKBACK_H = 3; // shadow.ts DEFAULT_OPTS.prechargeLookbackH
export const NEAREST_MAX_MIN = 10;
export const MAX_SAMPLE_GAP_MIN = 12; // dhw.ts MAX_SAMPLE_GAP_MIN (not exported there)
export const RAISE_MIN_F = 1;
export const WRITES_BEFORE_LEAD_MS = 3600_000; // the written interval opens 1 h before the lead hour
export const DRAW_TAIL_MS = 60 * 60_000; // rows after the window end that a late draw's trough may need
export const PRE_BOOST_RE = /pre-?boost/i;

export type Window = [number, number]; // [startHour, endHourExclusive) local

// ---- local time -----------------------------------------------------------------------------------------------
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** America/New_York wall clock of an epoch-ms instant. */
export function etParts(ms: number): { day: string; hour: number; minute: number } {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
export const hhmm = (ms: number): string => { const p = etParts(ms); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };

/** "YYYY-MM-DD" moved by n calendar days. */
export function shiftDay(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`expected YYYY-MM-DD, got "${day}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}
/** Every calendar day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = shiftDay(from, 0); d <= shiftDay(to, 0); d = shiftDay(d, 1)) out.push(d);
  return out;
}
/**
 * Epoch ms at which America/New_York reads `day` HH:00 (hour 24 = the next day's 00:00). On the spring-forward day the
 * skipped 02:00 does not exist and resolves to 03:00 EDT; on the fall-back day 01:00 is the first (EDT) one.
 */
export function etInstant(day: string, hour: number): number {
  if (hour >= 24) return etInstant(shiftDay(day, 1), hour - 24);
  if (hour < 0) return etInstant(shiftDay(day, -1), hour + 24);
  const [y, mo, d] = shiftDay(day, 0).split("-").map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, hour + off);
    const p = etParts(t);
    if (p.day === day && p.hour === hour) return t;
  }
  return Date.UTC(y, mo - 1, d, hour + 5);
}

// ---- windows --------------------------------------------------------------------------------------------------
/**
 * --windows accepts the planner's DHW_SHOWER_WINDOWS form ("06:30-10:00") and bare hours ("5-8,18-20"); bare hours
 * are rewritten to HH:00 so dhw.ts parseShowerWindows — the production parser — does the parsing and the rounding.
 */
export function normalizeWindowsArg(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split(",").map((x) => x.trim()).filter(Boolean)
    .map((part) => part.replace(/^(\d{1,2})\s*-\s*(\d{1,2})$/, (_m, a: string, b: string) => `${a}:00-${b}:00`))
    .join(",");
}
export const parseWindowsArg = (raw: string | undefined): Window[] => parseShowerWindows(normalizeWindowsArg(raw));
export const windowLabel = ([a, b]: Window): string => `${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;

export interface Lead { day: string; hour: number }
/** The hour shadow.ts would boost for a window starting at `startHour` on `day` (see header); null when there is none. */
export function leadFor(day: string, startHour: number, windows: Window[], lookbackH = LEAD_LOOKBACK_H): Lead | null {
  const inPeak = (h: number) => windows.some(([a, b]) => h >= a && h < b);
  for (let k = 1; k <= lookbackH; k++) {
    const h = startHour - k;
    const lead = h >= 0 ? { day, hour: h } : { day: shiftDay(day, -1), hour: h + 24 };
    if (!inPeak(lead.hour)) return lead;
  }
  return null;
}

export interface WindowTimes {
  startMs: number;
  endMs: number;
  dayStartMs: number; // local 00:00 of `day`
  lead: Lead | null;
  leadMs: number | null;
  writesFromMs: number; // 1 h before the lead hour (2 h before the start when there is no lead)
  rowsToMs: number; // window end + DRAW_TAIL_MS
}
export function windowTimes(day: string, window: Window, windows: Window[]): WindowTimes {
  const startMs = etInstant(day, window[0]), endMs = etInstant(day, window[1]);
  const lead = leadFor(day, window[0], windows);
  const leadMs = lead ? etInstant(lead.day, lead.hour) : null;
  return {
    startMs, endMs, dayStartMs: etInstant(day, 0), lead, leadMs,
    writesFromMs: (leadMs ?? startMs - 3600_000) - WRITES_BEFORE_LEAD_MS, rowsToMs: endMs + DRAW_TAIL_MS,
  };
}

// ---- plan -----------------------------------------------------------------------------------------------------
/** The fields of a ShadowBlock (planner/src/shadow.ts) this check reads; a stored plan is plain JSON. */
export interface PlanBlock { ts?: unknown; tank_target_f?: unknown; reason?: unknown; boost?: unknown; sani?: unknown; bank?: unknown; guard_f?: unknown }
export interface PlanRow { id: number; computedAtMs: number; plan: PlanBlock[] | null }

export function isPlannedBoost(b: PlanBlock | null | undefined): boolean {
  return !!b && (b.boost === true || PRE_BOOST_RE.test(String(b.reason ?? "")));
}
export function blockAt(plan: PlanBlock[] | null | undefined, tsMs: number): PlanBlock | null {
  return (Array.isArray(plan) ? plan : []).find((b) => Date.parse(String(b?.ts)) === tsMs) ?? null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface PlanSummary {
  id: number;
  computed_at: string;
  /** the lead-hour block; null when the plan does not reach that hour */
  block: { ts: string; target_f: number | null; boost: boolean; sani: boolean; bank: boolean; reason: string; guard_f: number | null } | null;
  /** local hours INSIDE the window whose block is a pre-boost (a boost kept after the learned windows moved) */
  boost_hours_in_window: number[];
}

// ---- writes ---------------------------------------------------------------------------------------------------
export interface WriteRow { ts: number; source: string; action: string; result: string; requested: unknown; detail: string | null } // ts epoch ms
export interface WriteSummary { ts: string; local: string; source: string; action: string; result: string; requested: string; level_f: number | null; raised: boolean }

/** The commanded level (°F at the live outdoor) an ACCEPTED write put in force, from patch()'s audit detail; null when it names none. */
export function writeLevelF(w: WriteRow): number | null {
  const d = w.detail ?? "";
  const m = /^target (-?\d+(?:\.\d+)?)°F/.exec(d) ?? /\(output (-?\d+(?:\.\d+)?)°F/.exec(d);
  if (m) return Number(m[1]);
  const r = (w.requested ?? {}) as Record<string, unknown>;
  const dbt = num(r.dbt), mbt = num(r.mbt);
  return w.action === "set_target" && dbt != null && mbt != null ? (dbt + mbt) / 2 : null;
}
/** The requested JSON as a short "k v" list in a fixed key order: target_f, minutes, dot, dbt, mbt, wwsd. */
export function shortRequested(requested: unknown): string {
  if (requested == null || typeof requested !== "object") return requested == null ? "-" : String(requested);
  const r = requested as Record<string, unknown>;
  const parts = ["target_f", "minutes", "dot", "dbt", "mbt", "wwsd"].filter((k) => r[k] != null).map((k) => `${k} ${r[k]}`);
  return parts.length ? parts.join(" ") : JSON.stringify(requested).slice(0, 60);
}

export interface WritesVerdict { written: WriteSummary[]; boost_written: boolean; held_f: number | null }
/**
 * `rows` ascending, reaching back before `fromMs` so the first write of the interval has a level to be compared with.
 * Returns the rows in [fromMs, toMs), whether one of them was the boost (see header), and the level in force at toMs.
 */
export function classifyWrites(rows: WriteRow[], fromMs: number, toMs: number): WritesVerdict {
  const written: WriteSummary[] = [];
  let level: number | null = null, boost = false;
  for (const w of rows) {
    if (w.ts >= toMs) break;
    const accepted = w.result === "accepted";
    const lv = accepted ? writeLevelF(w) : null;
    const raised = accepted && (w.action === "boost" || (lv != null && level != null && lv - level >= RAISE_MIN_F));
    if (accepted) level = lv;
    if (w.ts < fromMs) continue;
    if (raised) boost = true;
    written.push({ ts: new Date(w.ts).toISOString(), local: hhmm(w.ts), source: w.source, action: w.action, result: w.result, requested: shortRequested(w.requested), level_f: lv, raised });
  }
  return { written, boost_written: boost, held_f: level };
}

// ---- tank -----------------------------------------------------------------------------------------------------
export interface SlxRow { ts: number; tank_f: number | null; outdoor_f: number | null } // ts epoch ms

/** tank_f of the reading nearest `tMs`, null when none lies within ±maxMin minutes. */
export function nearestTankF(rows: SlxRow[], tMs: number, maxMin = NEAREST_MAX_MIN): number | null {
  let best: SlxRow | null = null;
  for (const r of rows) {
    if (r.tank_f == null || Math.abs(r.ts - tMs) > maxMin * 60_000) continue;
    if (!best || Math.abs(r.ts - tMs) < Math.abs(best.ts - tMs)) best = r;
  }
  return best ? best.tank_f : null;
}

export interface Draw { ts: string; local: string; pre_draw_f: number; min_f: number; sag_f: number }
/**
 * Draw events that START in [fromMs, toMs) (see header). `rows` should begin a little before fromMs — a fall across
 * the window edge needs its "before" sample, and a draw already under way must merge instead of starting again —
 * and run SAG_HORIZON_MIN past toMs for the last draw's trough.
 */
export function findDraws(rows: SlxRow[], fromMs: number, toMs: number): Draw[] {
  const tank = rows.filter((r) => r.tank_f != null).map((r) => ({ ts: r.ts, tankF: r.tank_f as number }));
  const index = new Map(tank.map((r, i) => [r.ts, i]));
  const out: Draw[] = [];
  let last = -Infinity;
  for (const d of detectDrawTimes(tank.map((r) => ({ ts: new Date(r.ts), tankF: r.tankF })))) {
    const t = d.getTime();
    const merged = t - last < DRAW_MERGE_MIN * 60_000;
    last = t;
    if (merged || t < fromMs || t >= toMs) continue;
    const i = index.get(t) as number;
    let min = tank[i].tankF;
    for (let j = i + 1; j < tank.length && tank[j].ts - t <= SAG_HORIZON_MIN * 60_000; j++) {
      if ((tank[j].ts - tank[j - 1].ts) / 60_000 > MAX_SAMPLE_GAP_MIN) break;
      if (tank[j].tankF < min) min = tank[j].tankF;
    }
    const pre = tank[i - 1].tankF;
    out.push({ ts: d.toISOString(), local: hhmm(t), pre_draw_f: pre, min_f: min, sag_f: Math.round((pre - min) * 10) / 10 });
  }
  return out;
}

// ---- one day × window -----------------------------------------------------------------------------------------
export type Verdict = "OK" | "FAIL" | "NO_DRAWS" | "NO_DATA";
export interface WindowResult {
  day: string;
  window: Window;
  window_start: string;
  lead: (Lead & { ts: string }) | null;
  plan: PlanSummary | null;
  planned_boost: boolean;
  written: WriteSummary[];
  boost_written: boolean;
  held_f: number | null;
  tank_at_start: number | null;
  draws: Draw[];
  outdoor_min_f: number | null;
  verdict: Verdict;
  no_boost: boolean;
  /** the restore's tank readings stop before the window end + 60 min: draws may be missing */
  partial: boolean;
}

export interface WindowInput {
  day: string;
  window: Window;
  windows: Window[]; // every window in use (the lead hour must lie outside all of them)
  plan: PlanRow | null; // the last shadow_plans row computed before the lead hour began
  writes: WriteRow[]; // ascending; from before the written interval through the window start
  slx: SlxRow[]; // ascending; from before local 00:00 through the window end + 60 min
  failBelowF?: number;
}

export function evaluateWindow(inp: WindowInput): WindowResult {
  const t = windowTimes(inp.day, inp.window, inp.windows);
  const failBelow = inp.failBelowF ?? DEFAULT_FAIL_BELOW_F;

  const lead = t.lead && t.leadMs != null ? { ...t.lead, ts: new Date(t.leadMs).toISOString() } : null;
  const leadBlock = inp.plan && t.leadMs != null ? blockAt(inp.plan.plan, t.leadMs) : null;
  const boostHours: number[] = [];
  if (inp.plan) for (let h = inp.window[0]; h < inp.window[1]; h++) if (isPlannedBoost(blockAt(inp.plan.plan, etInstant(inp.day, h)))) boostHours.push(h);
  const plan: PlanSummary | null = inp.plan && {
    id: inp.plan.id, computed_at: new Date(inp.plan.computedAtMs).toISOString(),
    block: leadBlock && {
      ts: String(leadBlock.ts), target_f: num(leadBlock.tank_target_f), boost: leadBlock.boost === true, sani: leadBlock.sani === true,
      bank: leadBlock.bank === true, reason: String(leadBlock.reason ?? ""), guard_f: num(leadBlock.guard_f),
    },
    boost_hours_in_window: boostHours,
  };
  const planned = isPlannedBoost(leadBlock);

  const w = classifyWrites(inp.writes, t.writesFromMs, t.startMs);

  const tankRows = inp.slx.filter((r) => r.tank_f != null);
  const inWindow = tankRows.filter((r) => r.ts >= t.startMs && r.ts < t.endMs);
  const draws = findDraws(inp.slx.filter((r) => r.ts >= t.startMs - 2 * DRAW_MERGE_MIN * 60_000 && r.ts <= t.rowsToMs), t.startMs, t.endMs);
  const outdoor = inp.slx.filter((r) => r.ts >= t.dayStartMs && r.ts < t.startMs && r.outdoor_f != null).map((r) => r.outdoor_f as number);

  const verdict: Verdict = !inWindow.length ? "NO_DATA" : !draws.length ? "NO_DRAWS" : draws.some((d) => d.pre_draw_f < failBelow) ? "FAIL" : "OK";
  return {
    day: inp.day, window: inp.window, window_start: new Date(t.startMs).toISOString(), lead, plan,
    planned_boost: planned, written: w.written, boost_written: w.boost_written, held_f: w.held_f,
    tank_at_start: nearestTankF(inp.slx, t.startMs), draws,
    outdoor_min_f: outdoor.length ? Math.min(...outdoor) : null,
    verdict, no_boost: draws.length > 0 && !(planned && w.boost_written),
    partial: inWindow.length > 0 && (tankRows[tankRows.length - 1]?.ts ?? -Infinity) < t.rowsToMs - MAX_SAMPLE_GAP_MIN * 60_000,
  };
}

// ---- report ---------------------------------------------------------------------------------------------------
export interface Summary {
  days_checked: number;
  windows_checked: number;
  windows_with_draws: number;
  fail: number;
  no_boost: number;
  no_data: number;
  lowest_pre_draw_f: number | null;
  lowest_pre_draw_at: string | null; // "YYYY-MM-DD HH:MM" local
  worst_sag_f: number | null;
  worst_sag_at: string | null;
}
export function summarize(results: WindowResult[]): Summary {
  const draws = results.flatMap((r) => r.draws.map((d) => ({ ...d, at: `${r.day} ${d.local}` })));
  const lowest = draws.reduce<(typeof draws)[number] | null>((a, d) => (!a || d.pre_draw_f < a.pre_draw_f ? d : a), null);
  const worst = draws.reduce<(typeof draws)[number] | null>((a, d) => (!a || d.sag_f > a.sag_f ? d : a), null);
  return {
    days_checked: new Set(results.map((r) => r.day)).size,
    windows_checked: results.length,
    windows_with_draws: results.filter((r) => r.draws.length).length,
    fail: results.filter((r) => r.verdict === "FAIL").length,
    no_boost: results.filter((r) => r.no_boost).length,
    no_data: results.filter((r) => r.verdict === "NO_DATA").length,
    lowest_pre_draw_f: lowest?.pre_draw_f ?? null, lowest_pre_draw_at: lowest?.at ?? null,
    worst_sag_f: worst?.sag_f ?? null, worst_sag_at: worst?.at ?? null,
  };
}

const f1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(1));
const yn = (b: boolean) => (b ? "yes" : "no");

/** One fixed-width line per day × window under a header line. Temperatures in °F; times local ET. */
export function formatTable(results: WindowResult[]): string {
  const cols: [string, number, (r: WindowResult) => string][] = [
    ["day", 10, (r) => r.day],
    ["window", 6, (r) => windowLabel(r.window)],
    ["lead", 5, (r) => (r.lead ? `${String(r.lead.hour).padStart(2, "0")}:00` : "-")],
    ["plan_f", 6, (r) => f1(r.plan?.block?.target_f)],
    ["guard", 5, (r) => f1(r.plan?.block?.guard_f)],
    ["planned", 7, (r) => (r.plan?.block ? yn(r.planned_boost) : "-")],
    ["writes", 6, (r) => `${r.written.filter((w) => w.result === "accepted").length}/${r.written.length}`],
    ["written", 7, (r) => yn(r.boost_written)],
    ["held_f", 6, (r) => f1(r.held_f)],
    ["tank@start", 10, (r) => f1(r.tank_at_start)],
    ["draws", 5, (r) => String(r.draws.length)],
    ["pre_min", 7, (r) => f1(r.draws.length ? Math.min(...r.draws.map((d) => d.pre_draw_f)) : null)],
    ["min_f", 5, (r) => f1(r.draws.length ? Math.min(...r.draws.map((d) => d.min_f)) : null)],
    ["sag_max", 7, (r) => f1(r.draws.length ? Math.max(...r.draws.map((d) => d.sag_f)) : null)],
    ["out_min", 7, (r) => f1(r.outdoor_min_f)],
    ["verdict", 0, (r) => [r.verdict, ...(r.no_boost ? ["NO_BOOST"] : []), ...(r.partial ? ["PARTIAL"] : [])].join(" ")],
    ["plan reason", 0, (r) => { const s = r.plan?.block?.reason ?? ""; return s.length > 48 ? `${s.slice(0, 47)}…` : s; }],
  ];
  const line = (cells: string[]) => cells.map((c, i) => (cols[i][1] ? c.padEnd(cols[i][1]) : i === cols.length - 1 ? c : c.padEnd(22))).join("  ").trimEnd();
  return [line(cols.map((c) => c[0])), ...results.map((r) => line(cols.map((c) => c[2](r))))].join("\n");
}

export function formatSummary(s: Summary, failBelowF = DEFAULT_FAIL_BELOW_F): string {
  return [
    `days checked ${s.days_checked}; windows ${s.windows_checked}, with draws ${s.windows_with_draws}${s.no_data ? `, without tank data ${s.no_data}` : ""}`,
    `FAIL ${s.fail} (a draw began below ${failBelowF} °F); NO_BOOST ${s.no_boost} (draws, but the boost was not planned or not written)`,
    `lowest pre_draw_f ${s.lowest_pre_draw_f == null ? "n/a" : `${f1(s.lowest_pre_draw_f)} °F at ${s.lowest_pre_draw_at}`}; worst sag ${s.worst_sag_f == null ? "n/a" : `${f1(s.worst_sag_f)} °F at ${s.worst_sag_at}`}`,
  ].join("\n");
}
