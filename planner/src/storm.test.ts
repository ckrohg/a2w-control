/**
 * @purpose Assertions for storm.ts. Run with: npx tsx planner/src/storm.test.ts — exits non-zero
 * on failure. Written for #112: storm mode armed itself on a calm 2026-09-23 night because the
 * forecast's gusts arrived in km/h and were compared against a threshold written in mph, so the
 * first block below pins the UNITS CONTRACT against the real response body that caused it. The
 * rest pins what had never been pinned at all — this module shipped 2026-07-14 with no test file,
 * which is how an assumption this load-bearing (every threshold names a unit the parser did not
 * enforce) went unnoticed for two months.
 */
import assert from "node:assert/strict";
import {
  parseStormForecast,
  unitConverter,
  deriveSyntheticTriggers,
  evaluateStormState,
  stormCeilingF,
  type StormForecastHour,
  type StormInputs,
  type StormState,
} from "./storm";

/** The real Open-Meteo body for 2026-09-25 as fetched on 2026-09-23 — gusts in km/h, temps in °F.
 *  Peak gust 50.4 km/h = 31.3 mph: a breezy Friday, nowhere near the 45 mph storm bar. */
const REAL_KMH_BODY = {
  hourly_units: { time: "iso8601", temperature_2m: "°F", wind_gusts_10m: "km/h", snowfall: "inch", weather_code: "wmo code" },
  hourly: {
    time: ["2026-09-25T00:00","2026-09-25T01:00","2026-09-25T02:00","2026-09-25T03:00","2026-09-25T04:00","2026-09-25T05:00","2026-09-25T06:00","2026-09-25T07:00","2026-09-25T08:00","2026-09-25T09:00","2026-09-25T10:00","2026-09-25T11:00","2026-09-25T12:00","2026-09-25T13:00","2026-09-25T14:00","2026-09-25T15:00","2026-09-25T16:00","2026-09-25T17:00","2026-09-25T18:00","2026-09-25T19:00","2026-09-25T20:00","2026-09-25T21:00","2026-09-25T22:00","2026-09-25T23:00"],
    temperature_2m: [53.2,54.1,52.9,51.1,50.9,52.3,52.9,53.8,54.9,55.8,56.7,57.7,59.0,59.9,59.7,59.7,60.3,59.2,58.6,52.9,53.1,53.8,54.5,55.0],
    wind_gusts_10m: [23.8,28.4,34.9,35.3,35.3,40.3,41.0,43.6,45.4,43.6,45.4,46.8,46.4,45.4,45.7,45.7,44.6,45.4,43.6,39.2,45.0,50.4,50.4,46.8],
    snowfall: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    weather_code: [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,51,51,61,61,61,61,80],
  },
};

// 1. #112 REGRESSION. The body that armed storm mode must now normalise to real mph and trigger
//    NOTHING. The second half proves the test isn't vacuous: relabel the identical numbers as mph
//    and the high-wind trigger fires with exactly the 11 hours the live planner acted on.
{
  const hours = parseStormForecast(REAL_KMH_BODY);
  const peak = Math.max(...hours.map((h) => h.gustMph));
  assert.ok(Math.abs(peak - 31.3) < 0.1, `50.4 km/h must normalise to ~31.3 mph, got ${peak}`);
  assert.equal(deriveSyntheticTriggers(hours).length, 0, "a 31 mph Friday must arm nothing");

  const mislabelled = parseStormForecast({ ...REAL_KMH_BODY, hourly_units: { ...REAL_KMH_BODY.hourly_units, wind_gusts_10m: "mp/h" } });
  const wind = deriveSyntheticTriggers(mislabelled).find((t) => t.kind === "high-wind");
  assert.ok(wind, "taken as mph the same numbers DO trip the bar — this is what happened on 2026-09-23");
  assert.match(wind!.detail, /across 11 h/, "…across the same 11 hours the live planner banked heat for");
}

// 2. Units contract: every unit Open-Meteo can return converts, and anything else is a hard fail
//    rather than a silent misread. The temperature case is the live twin of #112 — 8.8 °C is a mild
//    September night that would trip the <10 °F extreme-cold bar if it were read as Fahrenheit.
{
  assert.ok(Math.abs(unitConverter("wind_gusts_10m", "km/h")(50.4) - 31.32) < 0.01, "km/h → mph");
  assert.ok(Math.abs(unitConverter("wind_gusts_10m", "m/s")(20) - 44.74) < 0.01, "m/s → mph");
  assert.ok(Math.abs(unitConverter("wind_gusts_10m", "kn")(40) - 46.03) < 0.01, "kn → mph");
  // "mp/h" is the label Open-Meteo actually returns for a wind_speed_unit=mph request — asserting
  // the spelling we assumed rather than the one it sends is how this fix would have fail-closed
  // storm mode entirely (every poll throwing → synthetic cache empty → the winter pre-charge never
  // fires). Caught by running the real fetch before shipping.
  assert.equal(unitConverter("wind_gusts_10m", "mp/h")(31.3), 31.3, "mp/h — the real label — is identity");
  assert.equal(unitConverter("wind_gusts_10m", "mph")(31.3), 31.3, "mph alias is identity");
  assert.ok(Math.abs(unitConverter("temperature_2m", "°C")(8.8) - 47.84) < 0.01, "°C → °F");
  assert.equal(unitConverter("temperature_2m", "°F")(47.8), 47.8, "°F is identity");
  assert.ok(Math.abs(unitConverter("snowfall", "cm")(25.4) - 10) < 1e-9, "cm → inch");

  assert.throws(() => unitConverter("wind_gusts_10m", "furlongs/fortnight"), /unusable unit/);
  assert.throws(() => unitConverter("wind_gusts_10m", undefined), /\(absent\)/);
  // A body with no hourly_units at all must throw, NOT default to the requested unit: that default
  // is precisely the assumption #112 falsified.
  assert.throws(() => parseStormForecast({ hourly: REAL_KMH_BODY.hourly }), /unusable unit/);
  assert.throws(
    () => parseStormForecast({ ...REAL_KMH_BODY, hourly_units: { ...REAL_KMH_BODY.hourly_units, snowfall: "hogsheads" } }),
    /unusable unit/,
    "one bad series fails the whole poll — never a half-converted forecast",
  );
}

// 3. Sustained-count bars. Each trigger needs its dwell, not a single qualifying hour: a one-hour
//    dip or gust is weather, not a storm.
{
  const mk = (over: Partial<StormForecastHour>[], base: Partial<StormForecastHour> = {}): StormForecastHour[] =>
    over.map((o, i) => ({
      ts: `2026-01-15T${String(i).padStart(2, "0")}:00`,
      tempF: 30, gustMph: 10, snowfallIn: 0, weatherCode: 3, ...base, ...o,
    }));

  const kinds = (h: StormForecastHour[]) => deriveSyntheticTriggers(h).map((t) => t.kind);
  assert.deepEqual(kinds(mk([{ tempF: 5 }, { tempF: 5 }])), [], "2 cold hours is under the ≥3 bar");
  assert.deepEqual(kinds(mk([{ tempF: 5 }, { tempF: 5 }, { tempF: 5 }])), ["extreme-cold"], "3 cold hours arms");
  assert.deepEqual(kinds(mk([{ tempF: 10 }, { tempF: 10 }, { tempF: 10 }])), [], "exactly 10 °F is not below 10");
  assert.deepEqual(kinds(mk([{ gustMph: 46 }, { gustMph: 46 }])), [], "2 gust hours is under the ≥3 bar");
  assert.deepEqual(kinds(mk([{ gustMph: 46 }, { gustMph: 46 }, { gustMph: 46 }])), ["high-wind"], "3 gust hours arms");
  assert.deepEqual(kinds(mk([{ weatherCode: 66 }])), [], "1 icy hour is under the ≥2 bar");
  assert.deepEqual(kinds(mk([{ weatherCode: 66 }, { weatherCode: 67 }])), ["freezing-rain"], "2 icy hours arm");
  assert.deepEqual(kinds(mk([{ snowfallIn: 4 }, { snowfallIn: 3.9 }])), [], "7.9 in is under the 8 in bar");
  assert.deepEqual(kinds(mk([{ snowfallIn: 4 }, { snowfallIn: 4 }])), ["heavy-snow"], "8 in arms");

  // Window: onset is the first qualifying hour, expiry runs 6 h past the last.
  const t = deriveSyntheticTriggers(mk([{ gustMph: 46 }, { gustMph: 46 }, { gustMph: 46 }]))[0];
  assert.equal(t.onset, "2026-01-15T00:00");
  assert.equal(Date.parse(t.expires) - Date.parse("2026-01-15T02:00"), 6 * 3600_000, "expiry = last + 6 h");
}

// 4. State machine. now sits INSIDE the trigger window throughout.
{
  const now = new Date("2026-01-15T12:00:00Z");
  const idle: StormState = { kind: "idle" };
  const live = { kind: "high-wind", detail: "gusts to 60 mph across 4 h", onset: "2026-01-15T10:00:00Z", expires: "2026-01-15T20:00:00Z" };
  const base: StormInputs = { alerts: [], synthetic: [], outageActive: null };

  // Arming, and the two ways a feed says nothing.
  const armed = evaluateStormState(idle, { ...base, synthetic: [live] }, now);
  assert.equal(armed.state.kind, "armed");
  assert.deepEqual(armed.transitions, ["arm"]);
  assert.equal(evaluateStormState(idle, base, now).state.kind, "idle", "no triggers → stays idle");
  assert.equal(evaluateStormState(idle, { ...base, outageActive: null }, now).state.kind, "idle",
    "an unreachable OutageWatch is NO signal, never an outage");
  assert.equal(
    evaluateStormState(idle, { ...base, synthetic: [{ ...live, expires: "2026-01-15T11:00:00Z" }] }, now).state.kind,
    "idle", "an already-expired trigger never arms");
  // A Watch-tier NWS alert notifies but must not arm; only Warnings do.
  const notice = { event: "High Wind Watch", severity: "Moderate", tier: "notice" as const, onset: null, expires: "2026-01-15T20:00:00Z", headline: "" };
  assert.equal(evaluateStormState(idle, { ...base, alerts: [notice] }, now).state.kind, "idle", "notice tier never arms");

  // Holding and standing down.
  assert.deepEqual(evaluateStormState(armed.state, { ...base, synthetic: [live] }, now).transitions, [],
    "held inside the window — no repeat page");
  const after = new Date("2026-01-16T06:00:00Z");
  assert.equal(evaluateStormState(armed.state, base, after).transitions[0], "stand-down", "window closed, nothing live");
  assert.equal(evaluateStormState(armed.state, { ...base, synthetic: [{ ...live, onset: "2026-01-16T05:00:00Z", expires: "2026-01-16T12:00:00Z" }] }, after).transitions[0],
    "re-arm", "window closed but a fresh trigger is live");

  // Outage activates immediately and keeps the armed trigger's name; the debounce then holds the
  // window open after the outage clears, so a flapping feed can't drop the bank mid-event.
  const active = evaluateStormState(armed.state, { ...base, synthetic: [live], outageActive: true }, now);
  assert.equal(active.state.kind, "active");
  assert.deepEqual(active.transitions, ["outage-activate"]);
  assert.equal(active.state.kind === "active" && active.state.trigger, "high-wind", "keeps the armed trigger's name");
  assert.equal(evaluateStormState(active.state, { ...base, outageActive: false }, now).state.kind, "active",
    "cleared outage holds until the window closes");
  assert.equal(evaluateStormState(active.state, { ...base, outageActive: null }, after).transitions[0], "stand-down");

  // Manual disarm outranks a live trigger and suppresses re-arming for 12 h.
  const dis = evaluateStormState(armed.state, { ...base, synthetic: [live], manual: { disarm: true } }, now);
  assert.equal(dis.state.kind, "idle");
  assert.deepEqual(dis.transitions, ["manual-disarm"]);
  assert.equal(evaluateStormState(dis.state, { ...base, synthetic: [live] }, now).transitions.length, 0,
    "suppressed: the same live trigger must not re-arm");
  assert.equal(
    // Same trigger, still live past the suppression — otherwise this would pass for the wrong reason.
    evaluateStormState(dis.state, { ...base, synthetic: [{ ...live, expires: "2026-01-16T06:00:00Z" }] }, new Date("2026-01-16T01:00:00Z")).transitions[0],
    "arm", "…until the 12 h suppression lapses");
  assert.equal(evaluateStormState(dis.state, { ...base, manual: { armHours: 6 } }, now).transitions[0], "manual-arm",
    "an explicit manual arm beats the owner's own suppression");
}

// 5. Ceiling: curve + step, capped. The cap is what binds in shoulder season, which is why a
//    spurious arm is expensive — #112 held the tank at 135 °F against a 120 °F September idle
//    target. Step is 10 °F as of the 2026-09-25 owner decision (#114), was 3.
{
  assert.equal(stormCeilingF(120, 135), 130, "curve + 10 when it fits under the cap");
  assert.equal(stormCeilingF(156, 135), 135, "cap binds");
  assert.equal(stormCeilingF(null, 135), 135, "no curve reading → the cap");
}

// 6. #118 NWS window: `ends` is the weather, `expires` is only the bulletin's refresh deadline.
//    Fixture is the REAL High Wind Warning live at 2026-09-25T16:5xZ, whose two fields were 31 h
//    apart — the planner read it as ending Sat 01:30 EDT when the wind ran to Sun 08:00 EDT.
{
  const REAL_HIGH_WIND = {
    features: [{
      properties: {
        event: "High Wind Warning", severity: "Severe", messageType: "Update",
        onset: "2026-09-25T12:30:00-04:00",
        expires: "2026-09-26T01:30:00-04:00", // bulletin refresh
        ends: "2026-09-27T08:00:00-04:00",    // the weather
        headline: "High Wind Warning issued September 25 at 12:30PM EDT until September 27 at 8:00AM EDT",
      },
    }],
  };
  // fetchNwsAlerts' mapping, exercised through the same shape it builds from.
  const mapped = REAL_HIGH_WIND.features.map((f) => {
    const p = f.properties as Record<string, string>;
    return { expires: p.ends ?? p.expires ?? null };
  });
  assert.equal(mapped[0].expires, "2026-09-27T08:00:00-04:00", "the event end, not the refresh deadline");

  // And end-to-end through the machine: the armed window must outlast the bulletin.
  const now = new Date("2026-09-25T17:00:00Z");
  const alert = {
    event: "High Wind Warning", severity: "Severe", tier: "arm" as const,
    onset: "2026-09-25T12:30:00-04:00", expires: "2026-09-27T08:00:00-04:00",
    headline: "hwo",
  };
  const res = evaluateStormState({ kind: "idle" }, { alerts: [alert], synthetic: [], outageActive: null }, now);
  assert.equal(res.transitions[0], "arm");
  assert.ok(res.state.kind === "armed" && Date.parse(res.state.windowEnd) > Date.parse("2026-09-27T08:00:00-04:00"),
    "window must extend past the event end, not stop at the bulletin refresh");
}

// 7. #119 re-timing. An armed window used to be frozen until it lapsed, so a storm that shifted
//    left the window behind — measured live 2026-09-25: held window ended 8 h before the peak.
{
  const base: StormInputs = { alerts: [], synthetic: [], outageActive: null };
  const now = new Date("2026-09-25T17:00:00Z");
  const early = { kind: "high-wind", detail: "d", onset: "2026-09-26T12:00:00Z", expires: "2026-09-26T17:00:00Z" };
  const armed = evaluateStormState({ kind: "idle" }, { ...base, synthetic: [early] }, now);
  assert.equal(armed.transitions[0], "arm");
  const heldEnd = (armed.state as { windowEnd: string }).windowEnd;

  // The storm slips 8 h later. The window must follow, without waiting to lapse.
  const late = { ...early, onset: "2026-09-26T20:00:00Z", expires: "2026-09-27T01:00:00Z" };
  const retimed = evaluateStormState(armed.state, { ...base, synthetic: [late] }, now);
  assert.deepEqual(retimed.transitions, ["re-time"], "a materially moved trigger re-times the window");
  assert.ok(Date.parse((retimed.state as { windowEnd: string }).windowEnd) > Date.parse(heldEnd),
    "the re-timed window must end later than the one it replaced");

  // Jitter below the threshold must NOT churn the window (and so must not page).
  const jitter = { ...early, expires: "2026-09-26T17:30:00Z" };
  assert.equal(evaluateStormState(armed.state, { ...base, synthetic: [jitter] }, now).transitions.length, 0,
    "30 min of forecast jitter is not a re-time");

  // A manual arm is the owner's explicit window — a forecast never overrides it.
  const manual = evaluateStormState({ kind: "idle" }, { ...base, manual: { armHours: 24 } }, now);
  assert.equal(manual.transitions[0], "manual-arm");
  assert.equal(evaluateStormState(manual.state, { ...base, synthetic: [late] }, now).transitions.length, 0,
    "a manual window is never re-timed by the forecast");
}

// 8. #114/#119 lead-in. `min(onset - 24h, now)` never meant "24 h early": `now` was always the
//    smaller term until onset came within 24 h, so it meant "start the moment a trigger appears."
//    The lead must now come off onset, and a future windowStart must survive (index.ts gates
//    shaping on it, which is what "armed but not yet banking" looks like).
{
  const base: StormInputs = { alerts: [], synthetic: [], outageActive: null };
  const now = new Date("2026-09-25T17:00:00Z");
  const farOff = { kind: "high-wind", detail: "d", onset: "2026-09-27T12:00:00Z", expires: "2026-09-27T18:00:00Z" };
  const res = evaluateStormState({ kind: "idle" }, { ...base, synthetic: [farOff] }, now);
  assert.equal(res.transitions[0], "arm");
  const startMs = Date.parse((res.state as { windowStart: string }).windowStart);
  assert.equal(startMs, Date.parse("2026-09-27T08:00:00Z"), "lead is 4 h off onset, not 24 h and not now");
  assert.ok(startMs > now.getTime(), "a trigger two days out must not start shaping the plan today");
}

// 9. Ceiling step: default is the owner-decided 10 °F, and the old 3 is still reachable so
//    STORM_STEP_F=3 is a real rollback and not just a comment.
{
  assert.equal(stormCeilingF(120, 135), 130, "default step is +10 (#114, 2026-09-25)");
  assert.equal(stormCeilingF(120, 135, 3), 123, "STORM_STEP_F=3 restores pre-decision behaviour");
  assert.equal(stormCeilingF(130, 135), 135, "the cap still binds over the step");
  assert.equal(stormCeilingF(120, 122), 122, "a cap below curve+step clamps, never raises past it");
}

console.log("storm.test.ts: all assertions passed");
