/**
 * @purpose Assertions for /health.pi (#165, pilink.ts) over a synthetic week shaped like Oct 14–17: phase_b_log runs of
 * `no Pi connected` → dropout windows, each given a verdict from the mirror's readings gaps and system_stats reboots —
 * gap+reboot, gap_only, socket_only (all three), plus unknown (no coverage) and an ongoing window. Run with:
 * npx tsx planner/src/pilink.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import {
  dropoutRuns, classifyWindows, piHealth, withLiveAges, WINDOW_SLACK_S,
  type PhaseBRow, type ReadingGap, type Boot, type PiLinkInputs,
} from "./pilink";

const ms = (iso: string) => Date.parse(iso);
const s = (iso: string) => Date.parse(iso) / 1000;
const NO_PI = "failed: no Pi connected";

/** Phase B rows every 5 min for both pumps from `from` to `to` with `result`. */
function phaseB(from: string, to: string, result: string): PhaseBRow[] {
  const out: PhaseBRow[] = [];
  for (let t = ms(from); t < ms(to); t += 5 * 60_000) out.push({ ts: t, result }, { ts: t + 1_000, result });
  return out;
}

// ── 1. dropoutRuns: a run ends at the first `sent`; lease skips / other failures neither extend nor end it ─────────
{
  const rows: PhaseBRow[] = [
    { ts: ms("2026-10-17T05:20:00Z"), result: "sent" },
    { ts: ms("2026-10-17T05:31:00Z"), result: NO_PI },
    { ts: ms("2026-10-17T05:36:00Z"), result: "skipped: no writer lease" },
    { ts: ms("2026-10-17T05:41:00Z"), result: "failed: hub timeout" },
    { ts: ms("2026-10-17T05:46:00Z"), result: NO_PI },
    { ts: ms("2026-10-17T07:41:00Z"), result: "sent" },
    { ts: ms("2026-10-17T07:46:00Z"), result: "sent" },
    { ts: ms("2026-10-17T15:00:00Z"), result: NO_PI },
  ];
  // shuffled input: the function sorts
  assert.deepEqual(dropoutRuns([...rows].reverse()), [
    { start: ms("2026-10-17T05:31:00Z"), end: ms("2026-10-17T07:41:00Z") },
    { start: ms("2026-10-17T15:00:00Z"), end: null },
  ]);
  assert.deepEqual(dropoutRuns([]), []);
  assert.deepEqual(dropoutRuns([{ ts: 1, result: "sent" }, { ts: 2, result: "would-send" }]), [], "no failures → no windows");
}

// ── 2. The synthetic week — five windows, every verdict ─────────────────────────────────────────────────────────
const NOW = ms("2026-10-18T22:00:00Z");
const rows: PhaseBRow[] = [
  ...phaseB("2026-10-14T12:00:00Z", "2026-10-14T15:00:00Z", "sent"),
  ...phaseB("2026-10-14T15:00:00Z", "2026-10-14T17:10:00Z", NO_PI),   // W1 gap+reboot (watchdog ladder)
  ...phaseB("2026-10-14T17:10:00Z", "2026-10-15T18:00:00Z", "sent"),
  ...phaseB("2026-10-15T18:00:00Z", "2026-10-15T20:05:00Z", NO_PI),   // W2 gap_only (recovered on its own)
  ...phaseB("2026-10-15T20:05:00Z", "2026-10-16T10:00:00Z", "sent"),
  ...phaseB("2026-10-16T10:00:00Z", "2026-10-16T12:00:00Z", NO_PI),   // W3 socket_only (readings continued)
  ...phaseB("2026-10-16T12:00:00Z", "2026-10-17T05:31:00Z", "sent"),
  ...phaseB("2026-10-17T05:31:00Z", "2026-10-17T07:41:00Z", NO_PI),   // W4 gap+reboot, 130 min (the Oct 17 window)
  ...phaseB("2026-10-17T07:41:00Z", "2026-10-18T21:00:00Z", "sent"),
  ...phaseB("2026-10-18T21:00:00Z", "2026-10-18T21:55:00Z", NO_PI),   // W5 ongoing at NOW
];
const gaps: ReadingGap[] = [
  { start: s("2026-10-14T14:58:00Z"), end: s("2026-10-14T17:08:00Z") },  // W1: exporter silent too
  { start: s("2026-10-15T18:01:00Z"), end: s("2026-10-15T20:03:00Z") },  // W2
  // W3: none — readings kept arriving every minute
  { start: s("2026-10-17T05:30:00Z"), end: s("2026-10-17T07:40:00Z") },  // W4
];
const boots: Boot[] = [
  { at: s("2026-10-14T17:06:00Z") },   // W1: rebooted at the end of the ladder
  { at: s("2026-10-17T07:38:00Z") },   // W4
  { at: s("2026-10-18T09:00:00Z") },   // a reboot with no dropout (owner power-cycle) — counts in reboots_24h
];
const readings = { gaps, firstTs: s("2026-10-11T00:00:00Z"), lastTs: s("2026-10-18T21:59:30Z") };
{
  const w = classifyWindows(dropoutRuns(rows), readings, boots, NOW / 1000);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.verdict), ["gap+reboot", "gap_only", "socket_only", "gap+reboot", "socket_only"]);
  assert.deepEqual(w.map((x) => x.minutes), [130, 125, 120, 130, 60]);
  assert.equal(w[0].start, "2026-10-14T15:00:00.000Z");
  assert.equal(w[0].end, "2026-10-14T17:10:00.000Z");
  assert.equal(w[0].reboot_at, "2026-10-14T17:06:00.000Z", "names the reboot that ended it");
  assert.equal(w[0].readings_gap_min, 130);
  assert.equal(w[1].reboot_at, null);
  assert.equal(w[2].readings_gap_min, null, "socket_only: the readings never stopped");
  assert.equal(w[4].end, null, "ongoing, measured to now");
  // W5: readings are 30 s old — the Pi is online and pushing; only the hub socket is down
}
// ── 3. The trailing silence: readings stopped and have not resumed → an ongoing window is a gap ────────────────────
{
  const run = [{ start: ms("2026-10-18T21:00:00Z"), end: null }];
  const fresh = classifyWindows(run, { gaps: [], firstTs: s("2026-10-11T00:00:00Z"), lastTs: s("2026-10-18T21:59:30Z") }, [], NOW / 1000);
  assert.equal(fresh[0].verdict, "socket_only", "readings 30 s old → the Pi is online; only the socket is down");
  const silent = classifyWindows(run, { gaps: [], firstTs: s("2026-10-11T00:00:00Z"), lastTs: s("2026-10-18T20:59:00Z") }, [], NOW / 1000);
  assert.equal(silent[0].verdict, "gap_only", "readings silent since before the window → a gap, no reboot yet");
  assert.equal(silent[0].readings_gap_min, 61);
}
// ── 4. Slack: a gap or boot just outside the window still belongs to it; far away it does not ─────────────────────
{
  const run = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T12:00:00Z") }];
  const base = { firstTs: s("2026-10-11T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const inSlack = { start: s("2026-10-16T12:00:00Z") + WINDOW_SLACK_S - 60, end: s("2026-10-16T12:30:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [inSlack] }, [], NOW / 1000)[0].verdict, "gap_only");
  const far = { start: s("2026-10-16T13:00:00Z"), end: s("2026-10-16T13:30:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [far] }, [], NOW / 1000)[0].verdict, "socket_only");
  const gap = { start: s("2026-10-16T10:00:00Z"), end: s("2026-10-16T12:00:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [gap] }, [{ at: s("2026-10-16T12:00:00Z") + WINDOW_SLACK_S + 60 }], NOW / 1000)[0].verdict,
    "gap_only", "a boot after the slack is not this window's reboot");
}
// ── 5. unknown: no readings table, or readings start after the window began ────────────────────────────────────
{
  const run = [{ start: ms("2026-10-14T15:00:00Z"), end: ms("2026-10-14T17:10:00Z") }];
  assert.equal(classifyWindows(run, null, null, NOW / 1000)[0].verdict, "unknown", "mirror tables absent");
  assert.equal(classifyWindows(run, { gaps: [], firstTs: s("2026-10-15T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") }, [], NOW / 1000)[0].verdict,
    "unknown", "no readings before the window → cannot say whether they stopped");
  assert.equal(classifyWindows(run, { gaps: [], firstTs: null, lastTs: null }, [], NOW / 1000)[0].verdict, "unknown", "empty readings table");
}
// ── 6. piHealth assembles /health.pi ────────────────────────────────────────────────────────────────────────────
{
  const input: PiLinkInputs = {
    lastByPump: { pump1: s("2026-10-18T21:59:30Z"), pump2: s("2026-10-18T21:58:00Z") },
    readings, latestStat: { ts: s("2026-10-18T21:59:00Z"), uptime_s: 46_740 }, boots, phaseB: rows,
  };
  const h = piHealth(input, NOW);
  assert.equal(h.last_reading_age_s, 30, "newest reading of any pump");
  assert.deepEqual(h.last_reading_by_pump.pump2, { ts: "2026-10-18T21:58:00.000Z", age_s: 120 });
  assert.equal(h.uptime_s, 46_740);
  assert.equal(h.uptime_age_s, 60);
  assert.equal(h.reboots_24h, 1, "the 09:00Z power-cycle");
  assert.equal(h.reboots_7d, 3);
  assert.equal(h.last_reboot_at, "2026-10-18T09:00:00.000Z");
  assert.equal(h.dropouts_7d.length, 5);
  assert.deepEqual(h.dropouts_7d.map((w) => w.verdict), ["gap+reboot", "gap_only", "socket_only", "gap+reboot", "socket_only"]);
  assert.deepEqual(h.summary, { count: 5, longest_min: 130, verdicts: { "gap+reboot": 2, gap_only: 1, socket_only: 2, unknown: 0 } });
  assert.deepEqual(h.mirror_tables, { readings: true, system_stats: true });
  // live ages: /health serves the cached computation with ages advanced to the scrape time
  const later = withLiveAges(h, NOW + 90_000);
  assert.equal(later.last_reading_age_s, 120);
  assert.equal(later.last_reading_by_pump.pump1.age_s, 120);
  assert.equal(later.uptime_age_s, 150);
  assert.equal(h.last_reading_age_s, 30, "the cached object is not mutated");
  // a fresh DB the mirror never wrote (the rehearsal): everything mirror-derived is null, windows are unknown
  const bare = piHealth({ lastByPump: null, readings: null, latestStat: null, boots: null, phaseB: rows }, NOW);
  assert.deepEqual(bare.mirror_tables, { readings: false, system_stats: false });
  assert.equal(bare.last_reading_age_s, null);
  assert.equal(bare.reboots_24h, null);
  assert.equal(bare.summary.verdicts.unknown, 5);
  assert.equal(withLiveAges(bare, NOW + 60_000).last_reading_age_s, null);
}

console.log("pilink.test.ts: all assertions passed");
