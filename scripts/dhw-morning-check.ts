/**
 * @purpose Report, for each local America/New_York day on a LOCAL restore (scripts/analyze-local.sh), never production,
 * whether the planner's DHW pre-boost happened and whether a shower-hour draw started on a cold tank (owner rule:
 * "Any lukewarm shower is BAD"; a morning fails if the tank is below 120 °F when a shower-hour draw begins).
 * READ-ONLY: SELECTs on slx_readings, hbx_writes and shadow_plans, nothing else. Per day × shower window it prints
 * one line: the lead hour, the plan's lead-hour block (target, guard_f, pre-boost planned?), the hbx_writes before the
 * window (boost written? level in force), the tank at the window start, the draws that started in the window (lowest
 * pre-draw tank, trough, worst sag), the outdoor minimum since midnight and the verdict — OK / FAIL / NO_DRAWS /
 * NO_DATA, with NO_BOOST beside it when the window had draws but the boost was not planned or not written. A summary
 * follows. The rules and their sources in the planner are in scripts/dhw-morning.ts (tested by
 * scripts/dhw-morning.test.ts).
 *
 * Windows are production's: learnDhwWindows over the --learn-days of tank history before --from, then
 * mergeWindows(peakWindows(hourScores), the declared shower windows) — index.ts shadowOnce. Production relearns every
 * hour over a rolling 14 d; this check learns ONCE, so a peak that moved inside the checked range is judged against
 * the windows as they stood before --from. --windows overrides the declared windows (default: the DHW_SHOWER_WINDOWS
 * env, as the planner reads it); with the learner returning null, only the declared windows are used.
 *
 * Run from planner/:
 *   LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/dhw-morning-check.ts \
 *       [--from 2026-11-21] [--to 2026-11-23] [--fail-below 120] [--windows "5-8,18-20"] [--learn-days 21] [--json]
 * --from / --to are local ET calendar dates, inclusive (default: the last 3 local days present in slx_readings).
 * --windows takes bare hours ("5-8,18-20") or the planner's form ("06:30-10:00"). --json prints the same as JSON.
 */
import { Store } from "../planner/src/store";
import { assertLocalDatabaseUrl } from "../planner/src/local-db";
import { learnDhwWindows, mergeWindows, peakWindows } from "../planner/src/dhw";
import {
  TZ, DEFAULT_FAIL_BELOW_F, etInstant, etParts, shiftDay, daysBetween, parseWindowsArg, windowLabel, windowTimes,
  evaluateWindow, summarize, formatTable, formatSummary,
  type PlanRow, type SlxRow, type Window, type WindowResult, type WriteRow,
} from "./dhw-morning";

// dhw.ts reads local hours through the Date getters ("the TZ env makes the Date getters local"): pin them to the house
process.env.TZ = TZ;

const url = process.env.LOCAL_DATABASE_URL ?? "";
try { assertLocalDatabaseUrl(url); } catch (e) {
  console.error(`refusing: LOCAL_DATABASE_URL must point at a loopback host (this check is for a local restore only): ${(e as Error).message}`);
  process.exit(2);
}

// ---- arguments ------------------------------------------------------------------------------------------------
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
  else if (a === "--json") args.set("json", "1");
  else args.set(a.slice(2), process.argv[++i] ?? "");
}
const die = (msg: string): never => { console.error(msg); process.exit(2); };
const JSON_OUT = args.has("json");
const FAIL_BELOW = Number(args.get("fail-below") ?? DEFAULT_FAIL_BELOW_F);
if (!Number.isFinite(FAIL_BELOW)) die(`--fail-below must be a number (°F), got ${args.get("fail-below")}`);
const LEARN_DAYS = Number(args.get("learn-days") ?? "21");
if (!(LEARN_DAYS > 0)) die(`--learn-days must be a positive number, got ${args.get("learn-days")}`);
const dayArg = (k: string): string | null => {
  const v = args.get(k);
  if (v == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) die(`--${k} must be a local date YYYY-MM-DD, got "${v}"`);
  return v;
};
const FROM_ARG = dayArg("from"), TO_ARG = dayArg("to");
const DECLARED_RAW = args.get("windows") ?? process.env.DHW_SHOWER_WINDOWS;
const DECLARED_FROM = args.has("windows") ? "--windows" : process.env.DHW_SHOWER_WINDOWS ? "env DHW_SHOWER_WINDOWS" : "none";

const fmtWindows = (ws: Window[]) => (ws.length ? ws.map(windowLabel).join(", ") : "none");
const iso = (ms: number) => new Date(ms).toISOString();

async function main(): Promise<void> {
  const store = new Store(url);
  const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;
  const say = (s: string) => { if (!JSON_OUT) console.log(s); };
  const warnings: string[] = [];
  const warn = (s: string) => { warnings.push(s); if (!JSON_OUT) console.log(`WARN  ${s}`); };
  try {
    // ---- days ------------------------------------------------------------------------------------------------
    const newestMs = Number((await pool.query(`SELECT extract(epoch FROM max(ts))::float8 * 1000 AS t FROM slx_readings`)).rows[0]?.t ?? NaN);
    if (!Number.isFinite(newestMs)) throw new Error("slx_readings is empty — restore a backup first (scripts/analyze-local.sh)");
    const present: string[] = (await pool.query(
      `SELECT DISTINCT to_char(ts AT TIME ZONE $1, 'YYYY-MM-DD') AS day FROM slx_readings WHERE ts >= to_timestamp($2) ORDER BY 1 DESC LIMIT 3`,
      [TZ, (newestMs - 14 * 86400_000) / 1000])).rows.map((r) => String(r.day)).reverse();
    const to = TO_ARG ?? (FROM_ARG ? shiftDay(FROM_ARG, 2) : present[present.length - 1]);
    const from = FROM_ARG ?? (TO_ARG ? shiftDay(TO_ARG, -2) : present[0]);
    const days = FROM_ARG || TO_ARG ? daysBetween(from, to) : present;
    if (!days.length) throw new Error(`--to must not be before --from (${from} → ${to})`);
    const newest = etParts(newestMs);
    say(`dhw-morning-check: local days ${days[0]} → ${days[days.length - 1]} (${TZ}); fail below ${FAIL_BELOW} °F; restore's newest slx_readings row ${newest.day} ${String(newest.hour).padStart(2, "0")}:${String(newest.minute).padStart(2, "0")} ET`);

    // ---- windows, as index.ts shadowOnce builds them ---------------------------------------------------------
    const learnTo = etInstant(days[0], 0), learnFrom = learnTo - LEARN_DAYS * 86400_000;
    const history = (await pool.query(
      `SELECT extract(epoch FROM ts)::float8 * 1000 AS ts, tank_f FROM slx_readings
       WHERE ts >= to_timestamp($1) AND ts < to_timestamp($2) AND tank_f IS NOT NULL ORDER BY ts`, [learnFrom / 1000, learnTo / 1000]))
      .rows.map((r) => ({ ts: new Date(Number(r.ts)), tankF: Number(r.tank_f) }));
    const learned = learnDhwWindows(history);
    const peaks = learned ? peakWindows(learned.hourScores) : [];
    const declared = parseWindowsArg(DECLARED_RAW);
    const windows = mergeWindows(peaks, declared);
    const source = learned
      ? `learned peaks ${fmtWindows(peaks)} (${learned.days} d, ${learned.drawEvents} draw events in the ${LEARN_DAYS} d before ${days[0]}) merged with declared ${fmtWindows(declared)} (${DECLARED_FROM})`
      : `declared ${fmtWindows(declared)} (${DECLARED_FROM}) only — the learner returned null on ${history.length} tank rows in the ${LEARN_DAYS} d before ${days[0]}`;
    say(`windows checked: ${fmtWindows(windows)} — ${source}`);
    if (!windows.length) throw new Error(`no windows to check: the learner found no peak hours and none were declared — pass --windows "06:30-10:00"`);
    say(`note  a "draw" is dhw.ts detectDrawTimes: in the heating season it is a draw OR a zone call pulling the buffer`);

    // ---- data ------------------------------------------------------------------------------------------------
    const rangeFrom = etInstant(days[0], 0) - 86400_000, rangeTo = etInstant(days[days.length - 1], 24) + 2 * 3600_000;
    const slx: SlxRow[] = (await pool.query(
      `SELECT extract(epoch FROM ts)::float8 * 1000 AS ts, tank_f, outdoor_f FROM slx_readings
       WHERE ts >= to_timestamp($1) AND ts <= to_timestamp($2) ORDER BY ts`, [rangeFrom / 1000, rangeTo / 1000]))
      .rows.map((r) => ({ ts: Number(r.ts), tank_f: r.tank_f == null ? null : Number(r.tank_f), outdoor_f: r.outdoor_f == null ? null : Number(r.outdoor_f) }));
    const toWrite = (r: any): WriteRow => ({ ts: Number(r.ts), source: String(r.source), action: String(r.action), result: String(r.result), requested: r.requested ?? null, detail: r.detail ?? null });
    const WRITE_COLS = `extract(epoch FROM ts)::float8 * 1000 AS ts, source, action, result, requested, detail`;
    // the last accepted writes before the range give the first window's writes a level to be compared with
    const before = (await pool.query(
      `SELECT ${WRITE_COLS} FROM hbx_writes WHERE ts < to_timestamp($1) AND result = 'accepted' ORDER BY ts DESC, id DESC LIMIT 5`, [rangeFrom / 1000])).rows.map(toWrite).reverse();
    const within = (await pool.query(
      `SELECT ${WRITE_COLS} FROM hbx_writes WHERE ts >= to_timestamp($1) AND ts <= to_timestamp($2) ORDER BY ts, id`, [rangeFrom / 1000, rangeTo / 1000])).rows.map(toWrite);
    const writes = [...before, ...within];
    say(`rows: slx_readings ${slx.length}, hbx_writes ${within.length} (+${before.length} earlier accepted), tank history for the learner ${history.length}`);

    // ---- day × window ----------------------------------------------------------------------------------------
    const results: WindowResult[] = [];
    for (const day of days) {
      for (const window of windows) {
        const t = windowTimes(day, window, windows);
        let plan: PlanRow | null = null;
        if (t.leadMs != null) {
          const r = (await pool.query(
            `SELECT id, extract(epoch FROM computed_at)::float8 * 1000 AS computed_at, plan FROM shadow_plans
             WHERE computed_at < to_timestamp($1) ORDER BY computed_at DESC, id DESC LIMIT 1`, [t.leadMs / 1000])).rows[0];
          if (r) plan = { id: Number(r.id), computedAtMs: Number(r.computed_at), plan: Array.isArray(r.plan) ? r.plan : null };
        }
        const res = evaluateWindow({ day, window, windows, plan, writes, slx, failBelowF: FAIL_BELOW });
        const label = `${day} ${windowLabel(window)}`;
        if (!t.lead) warn(`${label}: no hour outside every window in the 3 h before ${String(window[0]).padStart(2, "0")}:00 — the planner places no pre-boost for this window`);
        else if (!plan) warn(`${label}: no shadow_plans row computed before the lead hour (${iso(t.leadMs as number)})`);
        else if (!res.plan?.block) warn(`${label}: plan #${plan.id} (computed ${iso(plan.computedAtMs)}) has no block for the lead hour ${iso(t.leadMs as number)}`);
        else if ((t.leadMs as number) - plan.computedAtMs > 2 * 3600_000) warn(`${label}: the last plan before the lead hour is ${(((t.leadMs as number) - plan.computedAtMs) / 3600_000).toFixed(1)} h old (plan #${plan.id}) — the hourly replan was not running`);
        if (res.plan?.boost_hours_in_window.length) warn(`${label}: plan #${res.plan.id} carries a pre-boost INSIDE the window at ${res.plan.boost_hours_in_window.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} (kept after the windows moved?)`);
        if (res.partial) warn(`${label}: tank readings stop before the window end + 60 min — draws may be missing`);
        results.push(res);
      }
    }
    const summary = summarize(results);

    if (JSON_OUT) {
      console.log(JSON.stringify({
        from: days[0], to: days[days.length - 1], tz: TZ, fail_below_f: FAIL_BELOW, newest_slx_reading: iso(newestMs),
        windows: { used: windows, learned_peaks: learned ? peaks : null, declared, declared_from: DECLARED_FROM, learn_days: LEARN_DAYS,
          learned: learned ? { days: learned.days, draw_events: learned.drawEvents } : null },
        results, summary, warnings,
      }, null, 2));
      return;
    }
    console.log("");
    console.log(formatTable(results));
    console.log("");
    console.log(formatSummary(summary, FAIL_BELOW));
  } finally {
    await store.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? `dhw-morning-check: ${e.message}` : e); process.exit(1); });
