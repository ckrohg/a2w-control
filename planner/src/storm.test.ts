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
  feedFailure,
  fetchOutageStatus,
  parseNwsAlerts,
  parseStormForecast,
  unitConverter,
  deriveSyntheticTriggers,
  evaluateStormState,
  nwsAlertFromProperties,
  stormCeilingF,
  HIGH_WIND_GUST_MPH,
  HIGH_WIND_MIN_HOURS,
  type StormForecastHour,
  type StormInputs,
  type StormState,
} from "./storm";

/** The real Open-Meteo body for 2026-09-25 as fetched on 2026-09-23 — gusts in km/h, temps in °F.
 *  Peak gust 50.4 km/h = 31.3 mph: a breezy Friday, nowhere near the storm bar (45 mph then, 50 since #115). */
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
//    and the high-wind trigger fires. Under the 2026-09-23 bar (> 45 for ≥ 3 h) that was the 11 hours
//    the live planner acted on; under #115's bar (> 50 for ≥ 2 h) it is the two 50.4 "mph" hours at
//    21:00–22:00 — still a trip, which is the point: the units contract, not the bar, is the guard.
{
  const hours = parseStormForecast(REAL_KMH_BODY);
  const peak = Math.max(...hours.map((h) => h.gustMph));
  assert.ok(Math.abs(peak - 31.3) < 0.1, `50.4 km/h must normalise to ~31.3 mph, got ${peak}`);
  assert.equal(deriveSyntheticTriggers(hours).length, 0, "a 31 mph Friday must arm nothing");

  const mislabelled = parseStormForecast({ ...REAL_KMH_BODY, hourly_units: { ...REAL_KMH_BODY.hourly_units, wind_gusts_10m: "mp/h" } });
  const wind = deriveSyntheticTriggers(mislabelled).find((t) => t.kind === "high-wind");
  assert.ok(wind, "taken as mph the same numbers DO trip the bar — this is what happened on 2026-09-23");
  assert.match(wind!.detail, /across 2 h/, "…on the two 50.4 'mph' hours that clear the #115 bar");
}

// 2. Units contract: every unit Open-Meteo can return converts, and anything else is a hard fail
//    rather than a silent misread. The temperature case is the live twin of #112 — 8.8 °C is a mild
//    September night that would have tripped the old <10 °F extreme-cold bar if read as Fahrenheit.
//    (#115 removed that trigger; the temperature contract stays pinned because tempF is still parsed.)
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
//    gust is weather, not a storm. Bars as recalibrated by #115 (2026-11-10): wind > 50 mph for ≥ 2 h,
//    no cold trigger at all; freezing rain and heavy snow unchanged.
{
  const mk = (over: Partial<StormForecastHour>[], base: Partial<StormForecastHour> = {}): StormForecastHour[] =>
    over.map((o, i) => ({
      ts: `2026-01-15T${String(i).padStart(2, "0")}:00`,
      tempF: 30, gustMph: 10, snowfallIn: 0, weatherCode: 3, ...base, ...o,
    }));
  const rep = (n: number, o: Partial<StormForecastHour>) => Array.from({ length: n }, () => o);

  const kinds = (h: StormForecastHour[]) => deriveSyntheticTriggers(h).map((t) => t.kind);
  assert.equal(HIGH_WIND_GUST_MPH, 50, "#115 gust bar");
  assert.equal(HIGH_WIND_MIN_HOURS, 2, "#115 dwell");
  // Cold alone never arms any more: 0 of 9 outage storms, every long armed run (#115).
  assert.deepEqual(kinds(mk(rep(12, { tempF: 5 }))), [], "5 °F for 12 h is a cold spell, not a storm — no trigger");
  assert.deepEqual(kinds(mk(rep(6, { tempF: -5 }))), [], "nor is −5 °F for 6 h");
  // Wind: between the old bar and the new one is a Wind Advisory, not an outage risk.
  assert.deepEqual(kinds(mk(rep(4, { gustMph: 48 }))), [], "48 mph for 4 h — cleared the old 45 bar, not the 50 bar");
  assert.deepEqual(kinds(mk(rep(3, { gustMph: 50 }))), [], "exactly 50 mph is not above 50");
  assert.deepEqual(kinds(mk([{ gustMph: 52 }])), [], "1 gust hour is under the ≥2 bar");
  assert.deepEqual(kinds(mk(rep(2, { gustMph: 52 }))), ["high-wind"], "52 mph for 2 h arms");
  assert.deepEqual(kinds(mk(rep(2, { gustMph: 52, tempF: 5 }))), ["high-wind"], "cold + wind is still just the wind trigger");
  assert.deepEqual(kinds(mk([{ weatherCode: 66 }])), [], "1 icy hour is under the ≥2 bar");
  assert.deepEqual(kinds(mk([{ weatherCode: 66 }, { weatherCode: 67 }])), ["freezing-rain"], "2 icy hours arm (unchanged)");
  assert.deepEqual(kinds(mk([{ snowfallIn: 4 }, { snowfallIn: 3.9 }])), [], "7.9 in is under the 8 in bar");
  assert.deepEqual(kinds(mk([{ snowfallIn: 4 }, { snowfallIn: 4 }])), ["heavy-snow"], "8 in arms (unchanged)");

  // Window: onset is the first qualifying hour; expiry is the END of the last qualifying hour.
  // (#114: was +6 h, which together with armFrom's old +6 h tail shaped the plan 12 h past a storm's end.)
  const t = deriveSyntheticTriggers(mk(rep(3, { gustMph: 52 })))[0];
  assert.equal(t.onset, "2026-01-15T00:00");
  assert.equal(Date.parse(t.expires) - Date.parse("2026-01-15T02:00"), 1 * 3600_000, "expiry = end of the last qualifying hour (#114)");
}

// 3b. #115 NWS tiering. Storm mode is outage preparation: only High Wind, Blizzard and Ice Storm
//     WARNINGS arm. Winter Storm Warnings (4–9 arms, no outage behind them) and Wind Chill / Extreme
//     Cold Warnings no longer arm; Watches of the kept families stay at the non-arming notice tier;
//     Advisories and everything else are dropped before they reach the machine.
{
  const props = (event: string) => ({ event, severity: "Severe", onset: "2026-01-15T10:00:00Z", expires: "2026-01-15T12:00:00Z", ends: "2026-01-15T20:00:00Z", headline: event });
  const tier = (event: string) => nwsAlertFromProperties(props(event))?.tier ?? null;
  assert.equal(tier("High Wind Warning"), "arm");
  assert.equal(tier("Blizzard Warning"), "arm");
  assert.equal(tier("Ice Storm Warning"), "arm");
  assert.equal(tier("Winter Storm Warning"), null, "a Winter Storm Warning no longer arms (#115)");
  assert.equal(tier("Winter Storm Watch"), null);
  assert.equal(tier("Extreme Cold Warning"), null, "cold is the planner's normal job, not storm mode's");
  assert.equal(tier("Wind Chill Warning"), null);
  assert.equal(tier("Wind Advisory"), null, "a Wind Advisory (46 mph criterion) sits below the bar");
  assert.equal(tier("High Wind Watch"), "notice", "a Watch of a kept family still maps, at the non-arming tier");
  assert.equal(tier("Blizzard Watch"), "notice");
  assert.equal(tier("Winter Weather Advisory"), null);
  assert.equal(nwsAlertFromProperties(props("High Wind Warning"))!.expires, "2026-01-15T20:00:00Z", "#118: `ends` still wins over `expires`");

  // …and through the machine: the Winter Storm Warning that used to arm is now invisible to it,
  // the High Wind Warning arms, the Wind Advisory does nothing.
  const now = new Date("2026-01-15T09:00:00Z");
  const base: StormInputs = { alerts: [], synthetic: [], outageActive: null };
  const through = (event: string) => {
    const alert = nwsAlertFromProperties(props(event));
    return evaluateStormState({ kind: "idle" }, { ...base, alerts: alert ? [alert] : [] }, now);
  };
  assert.deepEqual(through("High Wind Warning").transitions, ["arm"], "High Wind Warning arms");
  assert.equal(through("Winter Storm Warning").state.kind, "idle", "Winter Storm Warning does not arm");
  assert.equal(through("Wind Advisory").state.kind, "idle", "Wind Advisory does not arm");
  assert.equal(through("High Wind Watch").state.kind, "idle", "a Watch notifies at most — never arms");
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
    "stand-down", "window closed but a fresh trigger is live");

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
  const [alert] = parseNwsAlerts(REAL_HIGH_WIND);
  assert.equal(alert.expires, "2026-09-27T08:00:00-04:00", "the event end, not the refresh deadline");
  assert.equal(alert.tier, "arm", "a Warning arms");
  assert.equal(alert.onset, "2026-09-25T12:30:00-04:00");

  // And end-to-end, parser → machine: the armed window is `ends` + the 1 h tail, not the bulletin refresh.
  const now = new Date("2026-09-25T17:00:00Z");
  const res = evaluateStormState({ kind: "idle" }, { alerts: [alert], synthetic: [], outageActive: null }, now);
  assert.equal(res.transitions[0], "arm");
  assert.ok(res.state.kind === "armed");
  assert.equal(Date.parse(res.state.windowEnd), Date.parse("2026-09-27T08:00:00-04:00") + 3600_000,
    "windowEnd = ends + 1 h tail");
}

// 6b. The rest of parseNwsAlerts: what passes the event filter, which tier it gets, the fallbacks,
//     and that a malformed body yields no alerts rather than a throw that empties the poll.
{
  const feat = (properties: Record<string, unknown>) => ({ properties });
  const one = (properties: Record<string, unknown>) => parseNwsAlerts({ features: [feat(properties)] });

  // `ends: null` is legitimate on some alert types — fall back to `expires`.
  assert.equal(one({ event: "Blizzard Warning", ends: null, expires: "2026-01-15T20:00:00Z" })[0].expires,
    "2026-01-15T20:00:00Z", "ends null → expires");
  assert.equal(one({ event: "Blizzard Warning" })[0].expires, null, "neither → null");

  // Filter and tier (#115, 2026-11-10): only High Wind / Blizzard / Ice Storm Warnings arm; their Watches
  // are a notice; everything else — Winter Storm, Wind Chill, Extreme Cold, any Advisory — is dropped.
  for (const ev of ["High Wind Warning", "Blizzard Warning", "Ice Storm Warning"])
    assert.equal(one({ event: ev })[0].tier, "arm", `${ev} arms`);
  for (const ev of ["High Wind Watch", "Blizzard Watch", "Ice Storm Watch"])
    assert.equal(one({ event: ev })[0].tier, "notice", `${ev} is a notice`);
  for (const ev of ["Winter Storm Warning", "Winter Storm Watch", "Wind Chill Warning", "Wind Chill Advisory",
                    "Extreme Cold Warning", "Wind Advisory", "Winter Weather Advisory", "Flood Warning"])
    assert.deepEqual(one({ event: ev, expires: "2026-01-15T20:00:00Z" }), [], `${ev} is dropped`);

  // Onset falls back to `effective`, then null.
  assert.equal(one({ event: "Ice Storm Warning", effective: "2026-01-15T08:00:00Z" })[0].onset, "2026-01-15T08:00:00Z");
  assert.equal(one({ event: "Ice Storm Warning" })[0].onset, null);

  // Defaults for the display fields.
  const bare = one({ event: "High Wind Warning" })[0];
  assert.equal(bare.severity, "Unknown");
  assert.equal(bare.headline, "High Wind Warning", "headline falls back to the event name");

  // Malformed bodies: no alerts, no throw.
  assert.deepEqual(parseNwsAlerts({}), [], "no features");
  assert.deepEqual(parseNwsAlerts({ features: null }), [], "features: null");
  assert.deepEqual(parseNwsAlerts({ features: [{}] }), [], "a feature with no properties");
  assert.deepEqual(parseNwsAlerts(null), [], "null body");
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
  assert.equal(startMs, Date.parse("2026-09-27T10:00:00Z"), "lead is 2 h off onset (owner spec), not 24 h and not now");
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

// 10. OWNER SPEC 2026-09-25 — back-to-back storms get their own windows. The old code handed ALL
//     qualifying hours to triggerWindow (first → last), so two fronts in one forecast became a
//     single span bridging the calm days between them and pre-charged straight through.
{
  const mk = (ts: string, gustMph: number): StormForecastHour =>
    ({ ts, tempF: 50, gustMph, snowfallIn: 0, weatherCode: 3 });
  const twoStorms: StormForecastHour[] = [
    // storm A: 3 h on the 26th
    mk("2026-09-26T12:00", 55), mk("2026-09-26T13:00", 57), mk("2026-09-26T14:00", 53),
    // ~2 days of calm (below the bar, so absent from the qualifying set entirely)
    // storm B: 3 h on the 28th
    mk("2026-09-28T12:00", 54), mk("2026-09-28T13:00", 56), mk("2026-09-28T14:00", 52),
  ];
  const t = deriveSyntheticTriggers(twoStorms).filter((x) => x.kind === "high-wind");
  assert.equal(t.length, 2, "two fronts must produce TWO triggers, not one merged span");
  assert.equal(t[0].onset, "2026-09-26T12:00", "first storm keeps its own onset");
  assert.ok(Date.parse(t[0].expires) < Date.parse(t[1].onset),
    "the first window must CLOSE before the second opens — no bridging the calm between them");
  assert.equal(t[1].onset, "2026-09-28T12:00", "second storm keeps its own onset");

  // A short lull inside one storm must NOT split it — that would re-introduce churn.
  const oneStormWithLull: StormForecastHour[] = [
    mk("2026-09-26T12:00", 55), mk("2026-09-26T13:00", 57),
    mk("2026-09-26T16:00", 53), mk("2026-09-26T17:00", 54),
  ];
  assert.equal(deriveSyntheticTriggers(oneStormWithLull).filter((x) => x.kind === "high-wind").length, 1,
    "a 3 h lull is one storm, not two");

  // Snow is per-storm too: two unremarkable events must not sum into a heavy-snow arm.
  const snow = (ts: string, inches: number): StormForecastHour =>
    ({ ts, tempF: 28, gustMph: 10, snowfallIn: inches, weatherCode: 73 });
  const twoSmallSnows: StormForecastHour[] = [
    snow("2026-01-10T00:00", 2), snow("2026-01-10T01:00", 2.5),
    snow("2026-01-13T00:00", 2), snow("2026-01-13T01:00", 2.5),
  ];
  assert.equal(deriveSyntheticTriggers(twoSmallSnows).filter((x) => x.kind === "heavy-snow").length, 0,
    "4.5 in twice, days apart, is not an 8 in storm");
  const oneBigSnow: StormForecastHour[] = [snow("2026-01-10T00:00", 5), snow("2026-01-10T01:00", 4)];
  assert.equal(deriveSyntheticTriggers(oneBigSnow).filter((x) => x.kind === "heavy-snow").length, 1,
    "9 in in one storm still arms");
}

// 11. #119, observed live 2026-09-27T12:40Z: a storm that has ALREADY ENDED must not arm. The 3-day
//     body starts at local midnight today, so this morning's qualifying hours sit in this
//     afternoon's payload; without the `nowMs` filter they built a trigger and a lapsed window
//     re-armed on them. An in-progress storm must still arm (future hours remain). Omitting nowMs
//     keeps the old unfiltered behaviour so fixtures and the replay are unaffected.
{
  const mk = (ts: string, g: number): StormForecastHour => ({ ts, tempF: 55, gustMph: g, snowfallIn: 0, weatherCode: 3 });
  const morning = [mk("2026-09-27T00:00", 52), mk("2026-09-27T02:00", 52), mk("2026-09-27T05:00", 52)]; // all past by afternoon
  const noon = Date.parse("2026-09-27T14:00");
  assert.equal(deriveSyntheticTriggers(morning, noon).length, 0, "a storm that ended this morning must not arm this afternoon");
  assert.equal(deriveSyntheticTriggers(morning).length, 1, "omitting nowMs keeps the unfiltered contract (fixtures/replay)");
  const inProgress = [...morning, mk("2026-09-27T15:00", 53), mk("2026-09-27T16:00", 54), mk("2026-09-27T17:00", 51)];
  const t = deriveSyntheticTriggers(inProgress, noon);
  assert.equal(t.length, 1, "an in-progress storm still arms");
  assert.equal(t[0].onset, "2026-09-27T15:00", "onset is the first hour still ahead, not one already gone");
  // the current partial hour is kept (now - 1h), matching shadow.ts
  assert.equal(deriveSyntheticTriggers([mk("2026-09-27T13:30", 52), mk("2026-09-27T15:00", 52), mk("2026-09-27T16:00", 52)], noon).length, 1);
}

// 12. #114 — armed DURATION is capped. (a) The tail: shaping ends 1 h after a trigger's expiry, and
//     expiry is the END of the last qualifying hour — 2 h past the storm, not 12. (b) No chaining:
//     when a window lapses the machine STANDS DOWN even if the next storm is already live, and arms
//     it fresh on the following tick with its own window. Both are what this weekend's capture
//     showed the old code failing (armed to 21:00Z on a storm that ended 12:00Z).
{
  const mk = (ts: string, g: number): StormForecastHour => ({ ts, tempF: 55, gustMph: g, snowfallIn: 0, weatherCode: 3 });
  const storm = [mk("2026-09-26T18:00", 53), mk("2026-09-26T19:00", 55), mk("2026-09-26T20:00", 52)];
  const t = deriveSyntheticTriggers(storm);
  assert.equal(t[0].expires, new Date(Date.parse("2026-09-26T20:00") + 3600_000).toISOString(), "expiry = end of the last qualifying hour");
  const base: StormInputs = { alerts: [], synthetic: t, outageActive: null };
  const armed = evaluateStormState({ kind: "idle" }, base, new Date("2026-09-26T15:00"));
  assert.ok(armed.state.kind === "armed");
  const endMs = Date.parse(armed.state.windowEnd), lastMs = Date.parse("2026-09-26T20:00");
  assert.equal((endMs - lastMs) / 3600_000, 2, "shaping stops 2 h after the storm's last qualifying hour (was 12)");

  // (b) two storms, the second already live when the first's window lapses → stand-down, then a fresh arm
  const next = { kind: "high-wind", detail: "d", onset: "2026-09-27T10:00", expires: new Date(Date.parse("2026-09-27T12:00") + 3600_000).toISOString() };
  const afterA = new Date(endMs + 60_000);
  const lapsed = evaluateStormState(armed.state, { ...base, synthetic: [next] }, afterA);
  assert.deepEqual(lapsed.transitions, ["stand-down"], "a lapsed window stands down even with the next storm live — no chaining");
  assert.equal(lapsed.state.kind, "idle");
  const fresh = evaluateStormState(lapsed.state, { ...base, synthetic: [next] }, afterA);
  assert.deepEqual(fresh.transitions, ["arm"], "…and the next tick arms the next storm on its own window");
  assert.ok(fresh.state.kind === "armed" && Date.parse(fresh.state.windowStart) === Date.parse("2026-09-27T10:00") - 2 * 3600_000, "with its own 2 h lead off ITS onset");
}

// 13. #115 re-arm stretching. #114 made a LAPSED window stand down instead of chaining into the next
//     storm (test 12b) — but the re-time branch (#119) runs first, while the window is still current.
//     In the 1 h tail after a trigger expires, `liveTriggers` has already dropped it, so live[0] is
//     the NEXT storm, and "re-time" quietly slid the window onto it: no stand-down, no fresh arm, one
//     armed run across every night of a spell. Re-timing must only follow a trigger that belongs to
//     the held episode (onset within SEGMENT_GAP_H of the held trigger's expiry); a distinct storm
//     waits for the stand-down and arms on its own window.
{
  const mk = (ts: string, g: number): StormForecastHour => ({ ts, tempF: 30, gustMph: g, snowfallIn: 0, weatherCode: 3 });
  // Three windy nights 22:00–01:00Z (4 qualifying hours each), 20 h apart: three DISTINCT storms by
  // the module's own 6 h gap rule, all inside one 3-day forecast body.
  const nights: StormForecastHour[] = [];
  for (const d of [15, 16, 17]) {
    nights.push(mk(`2026-01-${d}T22:00:00Z`, 52), mk(`2026-01-${d}T23:00:00Z`, 55), mk(`2026-01-${d + 1}T00:00:00Z`, 53), mk(`2026-01-${d + 1}T01:00:00Z`, 52));
  }
  const base: StormInputs = { alerts: [], synthetic: [], outageActive: null };
  const at = (iso: string) => new Date(iso);
  const inputsAt = (now: Date): StormInputs => ({ ...base, synthetic: deriveSyntheticTriggers(nights, now.getTime()) });

  // (a) The tail hour. Night 1's trigger expired at 02:00Z, its window runs to 03:00Z, and night 2 is
  //     live 20 h out. That must HOLD, not re-time.
  const armed = evaluateStormState({ kind: "idle" }, inputsAt(at("2026-01-15T12:00:00Z")), at("2026-01-15T12:00:00Z"));
  assert.ok(armed.state.kind === "armed");
  assert.equal(armed.state.windowEnd, "2026-01-16T03:00:00.000Z", "night 1's window: end of its last hour + 1 h tail");
  const held = evaluateStormState(armed.state, inputsAt(at("2026-01-16T02:30:00Z")), at("2026-01-16T02:30:00Z"));
  assert.deepEqual(held.transitions, [], "a distinct later storm must not re-time the window during the tail");
  assert.deepEqual(held.state, armed.state, "the held window is unchanged");

  // (b) The same storm growing a longer tail in the next forecast IS the same episode and still re-times:
  //     gusts now run on to 05:00Z, so the trigger seen at 02:30Z spans 02:00–05:00Z (onset = held expiry).
  const longer = [...nights.slice(0, 4), mk("2026-01-16T02:00:00Z", 52), mk("2026-01-16T03:00:00Z", 52), mk("2026-01-16T04:00:00Z", 52), mk("2026-01-16T05:00:00Z", 52)];
  const grew = evaluateStormState(armed.state, { ...base, synthetic: deriveSyntheticTriggers(longer, Date.parse("2026-01-16T02:30:00Z")) }, at("2026-01-16T02:30:00Z"));
  assert.deepEqual(grew.transitions, ["re-time"], "the held storm running longer than forecast still re-times (#119 intact)");
  assert.equal(grew.state.kind === "armed" && grew.state.windowEnd, "2026-01-16T07:00:00.000Z");

  // (c) The whole spell, ticked every 10 min like the live planner: three arms, three stand-downs, no
  //     re-time, and every stand-down lands within one tick of its own night's expiry + tail.
  let state: StormState = { kind: "idle" };
  const seen: string[] = [];
  const standDowns: string[] = [];
  for (let t = Date.parse("2026-01-15T12:00:00Z"); t <= Date.parse("2026-01-18T12:00:00Z"); t += 10 * 60_000) {
    const r = evaluateStormState(state, inputsAt(new Date(t)), new Date(t));
    state = r.state;
    seen.push(...r.transitions);
    if (r.transitions.includes("stand-down")) standDowns.push(new Date(t).toISOString());
    if (state.kind === "armed") {
      assert.ok(Date.parse(state.windowEnd) - Date.parse(state.windowStart) <= 10 * 3600_000,
        `an armed window spans one night (lead 2 h + 4 h + tail 1 h), not a spell: ${state.windowStart} → ${state.windowEnd}`);
    }
  }
  assert.deepEqual(seen, ["arm", "stand-down", "arm", "stand-down", "arm", "stand-down"], "three storms, three separate armed runs, never a re-time onto the next");
  assert.deepEqual(standDowns, ["2026-01-16T03:10:00.000Z", "2026-01-17T03:10:00.000Z", "2026-01-18T03:10:00.000Z"],
    "each stand-down follows ITS night's expiry + 1 h tail by one tick");
}

// ── the outage feed: why there was no answer, and never the URL (it carries the feed key) ──────────
(async () => {
  const real = globalThis.fetch;
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  try {
    globalThis.fetch = answer(200, [{ hasActiveOutage: false }, { hasActiveOutage: true }]);
    assert.deepEqual(await fetchOutageStatus("http://x/k/secret"), { hasActiveOutage: true });
    globalThis.fetch = answer(200, [{ monitor: "no flag" }]);
    assert.deepEqual(await fetchOutageStatus("http://x/k/secret"), { failure: "it answered without an outage flag" });
    globalThis.fetch = answer(401, { error: "unauthorized" });
    assert.deepEqual(await fetchOutageStatus("http://x/k/secret"), { failure: "it refused the planner's key (HTTP 401)" });
    globalThis.fetch = answer(503, { error: "not_tracking_yet" });
    assert.match((await fetchOutageStatus("http://x/k/secret")).failure!, /not tracking outages yet/);
    globalThis.fetch = (async () => { throw new Error("connect failed http://x/k/secret"); }) as typeof fetch;
    const dead = await fetchOutageStatus("http://x/k/secret");
    assert.equal(dead.failure, "unreachable or unreadable");
    assert.doesNotMatch(JSON.stringify(dead), /secret/, "the key never reaches an email");
    assert.equal(feedFailure(500), "HTTP 500");
  } finally {
    globalThis.fetch = real;
  }
  console.log("storm.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
