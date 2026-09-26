/**
 * @purpose BACKWARD ARM for #122 Wave 1. Replays the storm state machine over the real 3-year
 * Open-Meteo archive for 42.63/-70.87 and diffs the CURRENT implementation against the one that
 * shipped 2026-07-14, so the window fixes (#118/#119 + per-storm segmentation + the 2 h lead) are
 * measured against history instead of asserted.
 *
 * Why this exists: every storm defect found on 2026-09-25/26 had been live for weeks or months and
 * every one was caught by a human reading code, not by the system. A replay is the cheapest way to
 * make "did this actually change behaviour, and in the direction we intended?" a number.
 *
 * The OLD functions below are a deliberate reimplementation of the shipped-then behaviour, kept
 * local so the comparison survives the real code moving on. They are history, not an alternative.
 *
 * Run: npx tsx planner/src/storm.replay.ts
 */
import { readFileSync } from "node:fs";
import { deriveSyntheticTriggers, evaluateStormState, type StormForecastHour,
         type SyntheticTrigger, type StormState } from "./storm";

const H = 3600_000;
const POLL_H = 6;        // the live trigger poll is 30 min; 6 h keeps a 3-year replay tractable
const FORECAST_DAYS = 3; // fetchStormForecast uses forecast_days=3

// ---------- the 2026-07-14 implementation, reproduced ----------
function oldWindow(q: StormForecastHour[]) {
  return { onset: q[0].ts, expires: new Date(Date.parse(q[q.length - 1].ts) + 6 * H).toISOString() };
}
/** No segmentation: ALL qualifying hours collapse into one first→last span. */
function oldTriggers(hours: StormForecastHour[]): SyntheticTrigger[] {
  const out: SyntheticTrigger[] = [];
  const cold = hours.filter((h) => h.tempF < 10);
  if (cold.length >= 3) out.push({ kind: "extreme-cold", detail: "", ...oldWindow(cold) });
  const windy = hours.filter((h) => h.gustMph > 45);
  if (windy.length >= 3) out.push({ kind: "high-wind", detail: "", ...oldWindow(windy) });
  const icy = hours.filter((h) => h.weatherCode === 66 || h.weatherCode === 67);
  if (icy.length >= 2) out.push({ kind: "freezing-rain", detail: "", ...oldWindow(icy) });
  const snowy = hours.filter((h) => h.snowfallIn > 0);
  if (snowy.reduce((a, h) => a + h.snowfallIn, 0) >= 8) out.push({ kind: "heavy-snow", detail: "", ...oldWindow(snowy) });
  return out;
}
/** min(onset-24h, now) — which is `now` until onset is inside 24 h, i.e. "start on sight". */
function oldEval(prev: StormState, syn: SyntheticTrigger[], now: number): StormState {
  const live = syn.filter((t) => Date.parse(t.expires) > now)
                  .sort((a, b) => Date.parse(a.onset) - Date.parse(b.onset));
  const arm = (t: SyntheticTrigger): StormState => ({
    kind: "armed", trigger: t.kind,
    windowStart: new Date(Math.min(Date.parse(t.onset) - 24 * H, now)).toISOString(),
    windowEnd: new Date(Date.parse(t.expires) + 6 * H).toISOString(),
  });
  if (prev.kind === "armed") {
    if (now <= Date.parse(prev.windowEnd)) return prev;   // FROZEN: forecast updates discarded
    return live.length ? arm(live[0]) : { kind: "idle" };
  }
  return live.length ? arm(live[0]) : { kind: "idle" };
}

// ---------- load ----------
const body = JSON.parse(readFileSync("planner/fixtures/openmeteo-archive-2023-2026.json", "utf8"));
const hrs: StormForecastHour[] = body.hourly.time.map((ts: string, i: number) => ({
  ts,
  tempF: Number(body.hourly.temperature_2m[i] ?? NaN),
  gustMph: Number(body.hourly.wind_gusts_10m[i] ?? NaN),
  snowfallIn: Number(body.hourly.snowfall[i] ?? 0),
  weatherCode: Number(body.hourly.weather_code[i] ?? 0),
}));
const tMs = hrs.map((h) => Date.parse(h.ts));

interface Run { armedH: number; events: number[]; triggerCount: number }
function replay(mode: "old" | "new"): Run {
  let state: StormState = { kind: "idle" };
  let triggerCount = 0;
  const armedAt = new Set<number>();          // hour indices where the plan would be shaped
  const events: number[] = [];
  let curStart: number | null = null;

  for (let i = 0; i < hrs.length; i += POLL_H) {
    const now = tMs[i];
    // the 3-day forecast this poll would have seen
    const win = hrs.filter((h) => { const t = Date.parse(h.ts); return t >= now && t < now + FORECAST_DAYS * 24 * H; });
    const syn = mode === "new" ? deriveSyntheticTriggers(win) : oldTriggers(win);
    triggerCount += syn.length;
    state = mode === "new"
      ? evaluateStormState(state, { alerts: [], synthetic: syn, outageActive: null }, new Date(now)).state
      : oldEval(state, syn, now);

    if (state.kind === "armed") {
      if (curStart === null) curStart = now;
      const s = Date.parse(state.windowStart), e = Date.parse(state.windowEnd);
      for (let j = 0; j < hrs.length; j++) if (tMs[j] >= s && tMs[j] <= e && tMs[j] <= now + POLL_H * H) armedAt.add(j);
    } else if (curStart !== null) {
      events.push((now - curStart) / H); curStart = null;
    }
  }
  if (curStart !== null) events.push((tMs[tMs.length - 1] - curStart) / H);
  return { armedH: armedAt.size, events, triggerCount };
}

const med = (a: number[]) => { if (!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const yrs = hrs.length / 8766;
const pad = (s: string, n: number) => s.padEnd(n);

console.log(`archive: ${hrs.length} h (${yrs.toFixed(2)} yr), 42.63/-70.87, poll ${POLL_H} h, forecast_days=${FORECAST_DAYS}`);
console.log(`qualifying raw hours — gust>45: ${hrs.filter(h=>h.gustMph>45).length}   temp<10F: ${hrs.filter(h=>h.tempF<10).length}\n`);

const O = replay("old"), N = replay("new");
console.log(`${pad("metric",28)}${pad("2026-07-14",14)}${pad("current",14)}delta`);
console.log("-".repeat(70));
const row = (label: string, o: number, n: number, unit = "") => {
  const d = n - o; const pct = o ? ` (${d >= 0 ? "+" : ""}${((d / o) * 100).toFixed(0)}%)` : "";
  console.log(`${pad(label,28)}${pad(o.toFixed(1)+unit,14)}${pad(n.toFixed(1)+unit,14)}${d>=0?"+":""}${d.toFixed(1)}${unit}${pct}`);
};
row("armed hours", O.armedH, N.armedH, " h");
row("armed share of record", (O.armedH/hrs.length)*100, (N.armedH/hrs.length)*100, " %");
row("arm events / yr", O.events.length/yrs, N.events.length/yrs);
row("median event length", med(O.events), med(N.events), " h");
row("max event length", Math.max(0,...O.events), Math.max(0,...N.events), " h");
row("triggers emitted (all polls)", O.triggerCount, N.triggerCount);

console.log("\nReading this:");
console.log("- MORE triggers emitted is the intended direction: per-storm segmentation splits spans");
console.log("  the old code merged, so two fronts now yield two windows instead of one bridging the");
console.log("  calm between them. The count going up is the fix working, not regressing.");
console.log("- FEWER armed hours is the intended direction: the lead now comes off onset (2 h) instead");
console.log("  of min(onset-24h, now), which in practice meant 'start the moment a trigger appears'.");
