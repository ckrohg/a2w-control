/**
 * @purpose Assertions for /health.pi (#165, pilink.ts) over a synthetic week shaped like Oct 14–17: phase_b_log runs of
 * `no Pi connected` → dropout windows, each given a verdict from the mirror's readings gaps and system_stats reboots —
 * gap+reboot, gap_only, socket_only (all three), plus unknown (no coverage / no reboot evidence possible) and an ongoing
 * window — and the negative cases codex pass 1 on #193 named: unrelated gaps and boots, the 7-day edge, missing stats.
 * Run with: npx tsx planner/src/pilink.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import {
  dropoutRuns, classifyWindows, piHealth, withLiveAges, mergeBoots, historicMisalignment, WINDOW_SLACK_S, DROPOUT_WINDOW_S,
  type PhaseBRow, type ReadingGap, type Boot, type PiLinkInputs, type StatsView,
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
  assert.deepEqual(dropoutRuns([...rows].reverse()), [
    { start: ms("2026-10-17T05:31:00Z"), end: ms("2026-10-17T07:41:00Z") },
    { start: ms("2026-10-17T15:00:00Z"), end: null },
  ], "sorted, two runs, the second ongoing");
  assert.deepEqual(dropoutRuns([]), []);
  assert.deepEqual(dropoutRuns([{ ts: 1, result: "sent" }, { ts: 2, result: "would-send" }]), [], "no failures → no windows");
}

// ── 2. mergeBoots: a fresh Pi's NTP step right after boot is the same boot ───────────────────────────────────────
assert.deepEqual(mergeBoots([{ at: 1_000 }, { at: 1_000 + 600 }, { at: 1_000 + 3_600 }]), [{ at: 1_000 }, { at: 4_600 }]);

// ── 3. The synthetic week — five windows, every verdict ─────────────────────────────────────────────────────────
const NOW = ms("2026-10-18T22:00:00Z");
const rows: PhaseBRow[] = [
  ...phaseB("2026-10-11T12:00:00Z", "2026-10-14T15:00:00Z", "sent"),
  ...phaseB("2026-10-14T15:00:00Z", "2026-10-14T17:10:00Z", NO_PI),   // W1 gap+reboot (watchdog ladder)
  ...phaseB("2026-10-14T17:10:00Z", "2026-10-15T18:00:00Z", "sent"),
  ...phaseB("2026-10-15T18:00:00Z", "2026-10-15T20:05:00Z", NO_PI),   // W2 gap_only (recovered on its own)
  ...phaseB("2026-10-15T20:05:00Z", "2026-10-16T10:00:00Z", "sent"),
  ...phaseB("2026-10-16T10:00:00Z", "2026-10-16T12:00:00Z", NO_PI),   // W3 socket_only (readings continued)
  ...phaseB("2026-10-16T12:00:00Z", "2026-10-17T05:31:00Z", "sent"),
  ...phaseB("2026-10-17T05:31:00Z", "2026-10-17T07:41:00Z", NO_PI),   // W4 gap+reboot, 130 min (the Oct 17 window)
  ...phaseB("2026-10-17T07:41:00Z", "2026-10-18T21:00:00Z", "sent"),
  ...phaseB("2026-10-18T21:00:00Z", "2026-10-18T21:55:00Z", NO_PI),   // W5 ongoing at NOW, readings fresh → socket_only
];
const gaps: ReadingGap[] = [
  { start: s("2026-10-14T14:58:00Z"), end: s("2026-10-14T17:08:00Z") },  // W1: exporter silent too
  { start: s("2026-10-15T18:01:00Z"), end: s("2026-10-15T20:03:00Z") },  // W2
  { start: s("2026-10-17T05:30:00Z"), end: s("2026-10-17T07:40:00Z") },  // W4
];
const stats: StatsView = {
  boots: [
    { at: s("2026-10-14T17:06:00Z") },   // W1: rebooted at the end of the ladder, inside its gap
    { at: s("2026-10-17T07:38:00Z") },   // W4
    { at: s("2026-10-18T09:00:00Z") },   // a reboot with no dropout (owner power-cycle) — counts in reboots_24h
  ],
  firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z"),
};
const readings = { gaps, firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:30Z") };
{
  const w = classifyWindows(dropoutRuns(rows), readings, stats, NOW / 1000);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.verdict), ["gap+reboot", "gap_only", "socket_only", "gap+reboot", "socket_only"]);
  assert.deepEqual(w.map((x) => x.minutes), [130, 125, 120, 130, 60]);
  assert.equal(w[0].start, "2026-10-14T15:00:00.000Z");
  assert.equal(w[0].end, "2026-10-14T17:10:00.000Z");
  assert.equal(w[0].reboot_at, "2026-10-14T17:06:00.000Z", "names the reboot that ended its gap");
  assert.equal(w[0].readings_gap_min, 130);
  assert.equal(w[1].reboot_at, null);
  assert.equal(w[2].readings_gap_min, null, "socket_only: the readings never stopped");
  assert.equal(w[4].end, null, "ongoing, measured to now");
}

// ── 4. Gap and boot must belong to the window (codex pass 1 on #193) ──────────────────────────────────────────────
{
  const run = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T12:00:00Z") }];
  const base = { firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const st = (boots: Boot[]): StatsView => ({ boots, firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") });
  // a gap that mostly lies AFTER the window (starts at 12:09) does not make a socket outage a gap
  const after = { start: s("2026-10-16T12:09:00Z"), end: s("2026-10-16T13:00:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [after] }, st([]), NOW / 1000)[0].verdict, "socket_only");
  // a gap just inside the slack, mostly inside → it belongs
  const edge = { start: s("2026-10-16T11:40:00Z"), end: s("2026-10-16T12:00:00Z") + WINDOW_SLACK_S - 60 };
  assert.equal(classifyWindows(run, { ...base, gaps: [edge] }, st([]), NOW / 1000)[0].verdict, "gap_only");
  // a SHORT unrelated gap 10:10–10:20 and a reboot at 11:00 that did not end it → gap_only, never gap+reboot
  const short = { start: s("2026-10-16T10:10:00Z"), end: s("2026-10-16T10:20:00Z") };
  const w = classifyWindows(run, { ...base, gaps: [short] }, st([{ at: s("2026-10-16T11:00:00Z") }]), NOW / 1000)[0];
  assert.equal(w.verdict, "gap_only", "the reboot must be inside the gap that ended at reconnect");
  assert.equal(w.reboot_at, null);
  // the same gap with a boot inside it → gap+reboot
  assert.equal(classifyWindows(run, { ...base, gaps: [short] }, st([{ at: s("2026-10-16T10:18:00Z") }]), NOW / 1000)[0].verdict, "gap+reboot");
  // a gap shorter than READING_GAP_MIN_S of overlap is not a gap
  const blip = { start: s("2026-10-16T12:00:00Z") + WINDOW_SLACK_S - 120, end: s("2026-10-16T12:00:00Z") + WINDOW_SLACK_S + 60 };
  assert.equal(classifyWindows(run, { ...base, gaps: [blip] }, st([]), NOW / 1000)[0].verdict, "socket_only");
}

// ── 4b. A long silence that SPANS a short socket outage is that outage's gap; a partial overlap is unclear → unknown;
// a growing trailing silence never turns into continuity (codex pass 2 on #193) ─────────────────────────────────
{
  const run = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T11:00:00Z") }];
  const base = { firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const st: StatsView = { boots: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const spanning = { start: s("2026-10-16T09:00:00Z"), end: s("2026-10-16T14:00:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [spanning] }, st, NOW / 1000)[0].verdict, "gap_only",
    "readings were silent for the whole outage — never socket_only");
  assert.equal(classifyWindows(run, { ...base, gaps: [spanning] }, { ...st, boots: [{ at: s("2026-10-16T13:58:00Z") }] }, NOW / 1000)[0].verdict,
    "gap+reboot", "…and the reboot that ended the silence counts");
  // a 6-min gap covering only the first minutes of a 2-h outage, mostly before it: neither belongs nor is absent
  const run2 = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T12:00:00Z") }];
  const partial = { start: s("2026-10-16T08:00:00Z"), end: s("2026-10-16T10:05:00Z") };
  assert.equal(classifyWindows(run2, { ...base, gaps: [partial] }, st, NOW / 1000)[0].verdict, "unknown", "unclear overlap → unknown");
  // an ongoing outage whose readings went silent before it began: unknown at every age, never socket_only
  const ongoing = [{ start: ms("2026-10-18T10:00:00Z"), end: null }];
  for (const lastIso of ["2026-10-18T09:30:00Z", "2026-10-18T03:00:00Z", "2026-10-17T12:00:00Z"]) {
    const v = classifyWindows(ongoing, { gaps: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s(lastIso) }, st, NOW / 1000)[0].verdict;
    assert.equal(v, "unknown", `silent since ${lastIso}: still unknown`);
  }
  // an AMBIGUOUS boot jump (reboot vs a fresh Pi's clock step) inside the gap → unknown, and never counted
  const short = { start: s("2026-10-16T10:10:00Z"), end: s("2026-10-16T10:40:00Z") };
  const amb: StatsView = { ...st, ambiguous: [{ at: s("2026-10-16T10:30:00Z") }] };
  assert.equal(classifyWindows(run, { ...base, gaps: [short] }, amb, NOW / 1000)[0].verdict, "unknown");
  const h = piHealth({ lastByPump: { pump1: NOW / 1000 - 30 }, readings: { ...base, gaps: [] }, latestStat: null, stats: amb, phaseB: [] }, NOW);
  assert.equal(h.reboots_7d, 0, "ambiguous jumps are not reboots");
}

// ── 4c. Every gap in the window is weighed; a clock step at a gap's edge makes it unresolved (codex pass 3 on #193)
{
  const st: StatsView = { boots: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const base = { firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const run = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T12:00:00Z") }];
  const g1 = { start: s("2026-10-16T10:00:00Z"), end: s("2026-10-16T11:00:00Z") };
  const g2 = { start: s("2026-10-16T11:20:00Z"), end: s("2026-10-16T11:40:00Z") };
  // a reboot in the SHORTER second gap still counts
  const w = classifyWindows(run, { ...base, gaps: [g1, g2] }, { ...st, boots: [{ at: s("2026-10-16T11:35:00Z") }] }, NOW / 1000)[0];
  assert.equal(w.verdict, "gap+reboot");
  assert.equal(w.reboot_at, "2026-10-16T11:35:00.000Z");
  assert.equal(w.readings_gap_min, 60, "the longest gap is reported");
  // an ongoing window with a closed gap AND a trailing silence → the open one keeps it unknown
  const now2 = s("2026-10-16T12:00:00Z");
  const ongoing = [{ start: ms("2026-10-16T10:00:00Z"), end: null }];
  assert.equal(classifyWindows(ongoing, { gaps: [g1], firstTs: base.firstTs, lastTs: s("2026-10-16T11:20:00Z") },
    { ...st, lastTs: s("2026-10-16T11:59:00Z") }, now2)[0].verdict, "unknown", "the still-open silence forbids a no-reboot verdict");
  // a forward clock step at the gap's edge: the 'gap' may be the clock jumping → unknown
  const step = { start: s("2026-10-16T10:29:00Z"), end: s("2026-10-16T10:40:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [step] }, { ...st, clockSteps: [s("2026-10-16T10:40:00Z")] }, NOW / 1000)[0].verdict, "unknown");
  assert.equal(classifyWindows(run, { ...base, gaps: [step] }, st, NOW / 1000)[0].verdict, "gap_only", "the same gap without the step is resolved");
  // codex pass 4: a clock step inside the window with NO readings gap (a backward step refilled it) → unknown
  assert.equal(classifyWindows(run, { ...base, gaps: [] }, { ...st, clockSteps: [s("2026-10-16T10:01:00Z")] }, NOW / 1000)[0].verdict, "unknown");
  assert.equal(classifyWindows(run, { ...base, gaps: [] }, { ...st, clockSteps: [s("2026-10-16T15:00:00Z")] }, NOW / 1000)[0].verdict,
    "socket_only", "a step far outside the window is irrelevant");
  // codex pass 4: a resolved closed gap does not hide an overlapping, non-belonging, still-open silence
  const closed = { start: s("2026-10-16T10:30:00Z"), end: s("2026-10-16T10:40:00Z") };
  const late = { start: s("2026-10-16T11:55:00Z"), end: s("2026-10-17T09:00:00Z") };
  assert.equal(classifyWindows(run, { ...base, gaps: [closed, late] }, st, NOW / 1000)[0].verdict, "unknown");
  assert.equal(classifyWindows(run, { ...base, gaps: [closed] }, st, NOW / 1000)[0].verdict, "gap_only", "without it: gap_only");
}

// ── 5. No reboot evidence possible → unknown, never a guessed gap_only (codex pass 1 on #193) ──────────────────────
{
  const run = [{ start: ms("2026-10-14T15:00:00Z"), end: ms("2026-10-14T17:10:00Z") }];
  const r = { gaps: [gaps[0]], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  assert.equal(classifyWindows(run, r, null, NOW / 1000)[0].verdict, "unknown", "system_stats absent");
  assert.equal(classifyWindows(run, r, { boots: [], firstTs: null, lastTs: null }, NOW / 1000)[0].verdict, "unknown", "system_stats empty");
  assert.equal(classifyWindows(run, r, { boots: [], firstTs: s("2026-10-14T16:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") }, NOW / 1000)[0].verdict,
    "unknown", "stats start inside the gap");
  assert.equal(classifyWindows(run, r, { boots: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-14T16:00:00Z") }, NOW / 1000)[0].verdict,
    "unknown", "stats stop before the gap ends");
  assert.equal(classifyWindows(run, r, { boots: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") }, NOW / 1000)[0].verdict,
    "gap_only", "bracketed and no boot → a positively observed recovery without reboot");
  // readings: absent, empty, or starting after the window began
  assert.equal(classifyWindows(run, null, stats, NOW / 1000)[0].verdict, "unknown", "readings absent");
  assert.equal(classifyWindows(run, { gaps: [], firstTs: null, lastTs: null }, stats, NOW / 1000)[0].verdict, "unknown", "readings empty");
  assert.equal(classifyWindows(run, { gaps: [], firstTs: s("2026-10-15T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") }, stats, NOW / 1000)[0].verdict,
    "unknown", "no readings before the window");
}

// ── 6. The trailing silence: an ongoing window whose readings stopped too — a gap whose ending is unknown ──────────
{
  const run = [{ start: ms("2026-10-18T21:00:00Z"), end: null }];
  const fresh = classifyWindows(run, { gaps: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:30Z") }, stats, NOW / 1000);
  assert.equal(fresh[0].verdict, "socket_only", "readings 30 s old → the Pi is online; only the socket is down");
  const silent = classifyWindows(run, { gaps: [], firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T20:59:00Z") }, stats, NOW / 1000);
  assert.equal(silent[0].verdict, "unknown", "the gap has not ended → reboot or not cannot be known yet");
  assert.equal(silent[0].readings_gap_min, 61, "…but the gap itself is reported");
}

// ── 7. piHealth assembles /health.pi; windows are kept by END within 7 d, with their real start ─────────────────
{
  const input: PiLinkInputs = {
    lastByPump: { pump1: s("2026-10-18T21:59:30Z"), pump2: s("2026-10-18T21:58:00Z") },
    readings, latestStat: { ts: s("2026-10-18T21:59:00Z"), uptime_s: 46_740 }, stats, phaseB: rows,
  };
  const h = piHealth(input, NOW);
  assert.equal(h.last_reading_age_s, 30, "newest reading of any pump");
  assert.deepEqual(h.last_reading_by_pump.pump2, { ts: "2026-10-18T21:58:00.000Z", age_s: 120 });
  assert.equal(h.uptime_s, 46_740);
  assert.equal(h.uptime_age_s, 60);
  assert.equal(h.reboots_24h, 1, "the 09:00Z power-cycle");
  assert.equal(h.reboots_7d, 3);
  assert.equal(h.last_reboot_at, "2026-10-18T09:00:00.000Z");
  assert.deepEqual(h.dropouts_7d.map((w) => w.verdict), ["gap+reboot", "gap_only", "socket_only", "gap+reboot", "socket_only"]);
  assert.deepEqual(h.summary, { count: 5, longest_min: 130, verdicts: { "gap+reboot": 2, gap_only: 1, socket_only: 2, unknown: 0 } });
  assert.deepEqual(h.mirror_tables, { readings: true, system_stats: true });
  // live ages
  const later = withLiveAges(h, NOW + 90_000);
  assert.equal(later.last_reading_age_s, 120);
  assert.equal(later.last_reading_by_pump.pump1.age_s, 120);
  assert.equal(later.uptime_age_s, 150);
  assert.equal(h.last_reading_age_s, 30, "the cached object is not mutated");
  // the 7-day edge (codex pass 1 on #193): a run that STARTED before the edge and ended inside keeps its real start;
  // one that ENDED before the edge is not reported
  const edgeS = NOW / 1000 - DROPOUT_WINDOW_S;
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const straddle = [
    ...phaseB(iso(edgeS - 6 * 3600), iso(edgeS - 4 * 3600), "sent"),
    ...phaseB(iso(edgeS - 4 * 3600), iso(edgeS - 3 * 3600), NO_PI),     // ended 3 h before the edge → out
    ...phaseB(iso(edgeS - 3 * 3600), iso(edgeS - 3600), "sent"),
    ...phaseB(iso(edgeS - 3600), iso(edgeS + 3600), NO_PI),             // 1 h before → 1 h after → in, 120 min
    ...phaseB(iso(edgeS + 3600), iso(edgeS + 7200), "sent"),
  ];
  const e = piHealth({ ...input, phaseB: straddle }, NOW);
  assert.equal(e.dropouts_7d.length, 1, "kept by end, as the hub does");
  assert.equal(e.dropouts_7d[0].start, iso(edgeS - 3600), "its real start, not the edge");
  assert.equal(e.dropouts_7d[0].minutes, 120);
  // a fresh DB the mirror never wrote (the rehearsal): everything mirror-derived is null, windows are unknown
  const bare = piHealth({ lastByPump: null, readings: null, latestStat: null, stats: null, phaseB: rows }, NOW);
  assert.deepEqual(bare.mirror_tables, { readings: false, system_stats: false });
  assert.equal(bare.last_reading_age_s, null);
  assert.equal(bare.reboots_24h, null);
  assert.equal(bare.summary.verdicts.unknown, 5);
  assert.equal(withLiveAges(bare, NOW + 60_000).last_reading_age_s, null);
}

// ── 8. codex pass 14 on #193: a Pi clock misaligned NOW voids every window since the last clock step ──────────────
{
  const base: PiLinkInputs = {
    lastByPump: { pump1: NOW / 1000 - 30 }, readings: { ...readings, gaps: [] }, latestStat: null,
    stats: { ...stats, clockSteps: [s("2026-10-17T00:00:00Z")] }, phaseB: rows,
  };
  const aligned = piHealth(base, NOW, 4);
  assert.equal(aligned.pi_clock.misaligned_since, null);
  assert.equal(aligned.dropouts_7d.at(-1)?.verdict, "socket_only");
  const fast = piHealth({ ...base, futureRows: true }, NOW);
  assert.equal(fast.pi_clock.misaligned_since, "2026-10-17T00:00:00.000Z", "since the last clock step");
  assert.deepEqual(fast.dropouts_7d.map((w) => w.verdict).slice(-2), ["unknown", "unknown"], "the Oct 17 + 18 windows are void");
  assert.equal(fast.dropouts_7d[2].verdict, "socket_only", "the Oct 16 window, before the step, stands");
  const live = piHealth(base, NOW, -3_600);
  assert.equal(live.pi_clock.live_offset_s, -3_600);
  assert.equal(live.pi_clock.misaligned_since, "2026-10-17T00:00:00.000Z", "the live hub offset alone is enough");
  const noStep = piHealth({ ...base, stats: { ...stats, clockSteps: [] }, futureRows: true }, NOW);
  assert.ok(noStep.dropouts_7d.every((w) => w.verdict === "unknown"), "no step known → the whole range is void");
}

// ── 9. codex pass 15 on #193: a PAST misaligned span (an hour slow for two days, then corrected) is found after the
// correction from the signed steps, and voids the windows inside it ────────────────────────────────────────────
{
  const from = s("2026-10-10T00:00:00Z");
  // slowed −1 h on Oct 14 00:00, corrected +1 h on Oct 16 00:00; a +30 s blip is not a step worth a span
  const deltas = [{ ts: s("2026-10-14T00:00:00Z"), delta: -3_600 }, { ts: s("2026-10-16T00:00:00Z"), delta: 3_600 }];
  assert.deepEqual(historicMisalignment(deltas, from, NOW / 1000), [{ start: s("2026-10-14T00:00:00Z"), end: s("2026-10-16T00:00:00Z") }]);
  assert.deepEqual(historicMisalignment([], from, NOW / 1000), []);
  // a single step that CORRECTED a slow clock: everything before it was off
  assert.deepEqual(historicMisalignment([{ ts: s("2026-10-12T00:00:00Z"), delta: 3_600 }], from, NOW / 1000), [{ start: from, end: s("2026-10-12T00:00:00Z") }]);
  // two steps that cancel within tolerance leave nothing; a later unrelated pair is found on its own
  assert.deepEqual(historicMisalignment([{ ts: s("2026-10-12T00:00:00Z"), delta: 90 }], from, NOW / 1000), []);
  const base: PiLinkInputs = {
    lastByPump: { pump1: NOW / 1000 - 30 }, readings: { ...readings, gaps: [] }, latestStat: null,
    stats: { ...stats, clockSteps: deltas.map((d) => d.ts), clockStepDeltas: deltas }, phaseB: rows,
  };
  const h = piHealth(base, NOW, 0);
  assert.equal(h.pi_clock.misaligned_since, null, "aligned now");
  assert.equal(h.pi_clock.past_misaligned.length, 1);
  assert.deepEqual(h.dropouts_7d.map((w) => w.verdict), ["unknown", "unknown", "socket_only", "socket_only", "socket_only"],
    "Oct 14 15:00 and Oct 15 18:00 lie inside the slow span (Oct 14 00:00 → Oct 16 00:00) → unknown; the rest stand");
  assert.deepEqual(piHealth({ ...base, stats: { ...stats, clockSteps: [], clockStepDeltas: [] } }, NOW, 0).dropouts_7d.map((w) => w.verdict),
    ["socket_only", "socket_only", "socket_only", "socket_only", "socket_only"], "without the steps every window would read socket_only");
}

// ── 10. codex pass 16 on #193: a KNOWN misaligned span voids even a certain reboot; an unanchored present voids all ─
{
  const run = [{ start: ms("2026-10-16T10:00:00Z"), end: ms("2026-10-16T11:00:00Z") }];
  const base = { firstTs: s("2026-10-10T00:00:00Z"), lastTs: s("2026-10-18T21:59:00Z") };
  const shifted = { start: s("2026-10-16T10:00:00Z"), end: s("2026-10-16T11:00:00Z") };      // really 09:00–10:00
  const st: StatsView = { boots: [{ at: s("2026-10-16T10:50:00Z") }], firstTs: base.firstTs, lastTs: base.lastTs };
  assert.equal(classifyWindows(run, { ...base, gaps: [shifted] }, st, NOW / 1000)[0].verdict, "gap+reboot", "at face value");
  assert.equal(classifyWindows(run, { ...base, gaps: [shifted], misaligned: [{ start: s("2026-10-16T00:00:00Z"), end: NOW / 1000 }] }, st, NOW / 1000)[0].verdict,
    "unknown", "inside a known misaligned span the reboot proves nothing about THIS window");
  // a lone clock-step marker near a reboot does NOT void it (a rebooted Pi's NTP step is normal)
  assert.equal(classifyWindows(run, { ...base, gaps: [shifted] }, { ...st, clockSteps: [s("2026-10-16T10:52:00Z")] }, NOW / 1000)[0].verdict, "gap+reboot");
  // unanchored: steps in range, no fresh frame, no future rows
  const inp: PiLinkInputs = {
    lastByPump: { pump1: NOW / 1000 - 30 }, readings: { ...readings }, latestStat: null,
    stats: { ...stats, clockSteps: [s("2026-10-17T12:00:00Z")], clockStepDeltas: [{ ts: s("2026-10-17T12:00:00Z"), delta: -3_600 }] }, phaseB: rows,
  };
  const un = piHealth(inp, NOW, null);
  assert.equal(un.pi_clock.unanchored, true);
  assert.ok(un.dropouts_7d.every((w) => w.verdict === "unknown"));
  const an = piHealth(inp, NOW, 3);
  assert.equal(an.pi_clock.unanchored, false, "a fresh frame anchors the present");
  assert.equal(an.dropouts_7d[0].verdict, "unknown", "…and the past BEFORE the −1 h step was off by +1 h → unknown");
  assert.equal(an.dropouts_7d.at(-1)?.verdict, "socket_only", "…after it the clock was right");
}

console.log("pilink.test.ts: all assertions passed");
