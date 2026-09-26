/**
 * @purpose Storm-mode triggers + pure state machine for the planner (plan §6.11,
 * issue #10). Watches NWS active alerts and the OpenMeteo hourly forecast for
 * storm-grade conditions (extreme cold, high wind, freezing rain, heavy snow),
 * polls OutageWatch for grid outages, and folds every signal — plus manual
 * arm/disarm — through evaluateStormState, a pure idle/armed/active machine the
 * caller drives once per tick. stormCeilingF caps the storm pre-charge target
 * just above the HBX curve target. Unreachable OutageWatch = no signal, never
 * an outage; a forecast whose units we cannot read = no signal either (#112).
 */

export interface StormAlert {
  event: string;
  severity: string;
  tier: "arm" | "notice";
  onset: string | null;
  expires: string | null;
  headline: string;
}

export interface SyntheticTrigger {
  kind: string;
  detail: string;
  onset: string;
  expires: string;
}

export type StormState =
  | { kind: "idle"; suppressedUntil?: string }
  | { kind: "armed"; trigger: string; windowStart: string; windowEnd: string }
  | { kind: "active"; trigger: string; windowEnd: string };

export interface StormInputs {
  alerts: StormAlert[];
  synthetic: SyntheticTrigger[];
  outageActive: boolean | null; // null = OutageWatch unreachable (NO signal)
  manual?: { armHours?: number; disarm?: boolean };
}

export interface StormForecastHour {
  ts: string;
  tempF: number;
  gustMph: number;
  snowfallIn: number;
  weatherCode: number;
}

const H = 3600_000;
/**
 * #114/#119: pre-charge lead. The old `min(onset - 24h, now)` did not mean "start 24 h early" —
 * because `now` is always the smaller term until onset is within 24 h, it meant "start the moment
 * a trigger appears," which is why an armed window could shape the plan for days. The whole bank
 * is captured in the 3-6 h before onset (#114), so lead from onset and do NOT clamp to now: a
 * windowStart in the future is exactly the "armed but not yet shaping" state index.ts already
 * honours via its `startMs` gate.
 */
const PRECHARGE_LEAD_H = 4;
/** #119: don't re-time an armed window for forecast jitter smaller than this. */
const RETIME_MIN_SHIFT_MS = 1 * H;
const NWS_EVENT_RE = /winter storm|ice storm|blizzard|high wind|extreme cold|wind chill/i;

export async function fetchNwsAlerts(lat: string, lon: string): Promise<StormAlert[]> {
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "a2w-control-planner (ckrohg@me.com)",
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`NWS alerts fetch failed: ${res.status}`);
  const body = (await res.json()) as any;
  const alerts: StormAlert[] = [];
  for (const feature of body?.features ?? []) {
    const p = feature?.properties ?? {};
    const event = String(p.event ?? "");
    if (!NWS_EVENT_RE.test(event)) continue;
    alerts.push({
      event,
      severity: String(p.severity ?? "Unknown"),
      tier: event.includes("Warning") ? "arm" : "notice",
      onset: p.onset ?? p.effective ?? null,
      // #118: `ends` is when the WEATHER stops; `expires` is only when NWS must reissue the
      // bulletin. `expires` is always present on an active alert, so the old `expires ?? ends`
      // made `ends` dead code and read every warning short — 31 h short on the 2026-09-25 High
      // Wind Warning. `ends` can legitimately be null on some alert types, so keep the fallback.
      expires: p.ends ?? p.expires ?? null,
      headline: String(p.headline ?? event),
    });
  }
  return alerts;
}

/**
 * Unit normalisation for the forecast body (#112). Every threshold in
 * deriveSyntheticTriggers is written in °F / mph / inch, and the request below asks for
 * exactly those — but on 2026-09-23 the planner armed storm mode off eleven gust-hours
 * "above 45 mph" whose real peak was 31.3 mph, i.e. plain km/h. ASKING for a unit is not
 * the same as RECEIVING one, so the response's own `hourly_units` is what we convert from.
 * An unrecognised or absent unit throws: stormTriggerPoll's catch then leaves the synthetic
 * cache empty, and a forecast we cannot interpret arms nothing — the same fail-safe this
 * module already applies to an unreachable OutageWatch.
 */
const UNIT_CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  temperature_2m: {
    "°f": (v) => v,
    f: (v) => v,
    "°c": (v) => (v * 9) / 5 + 32,
    c: (v) => (v * 9) / 5 + 32,
  },
  wind_gusts_10m: {
    // Open-Meteo spells the mph label "mp/h" (verified live 2026-09-23); "mph" is kept as an alias
    // because the REQUEST uses that spelling and a future response may too.
    "mp/h": (v) => v,
    mph: (v) => v,
    "km/h": (v) => v / 1.609344,
    kmh: (v) => v / 1.609344,
    "m/s": (v) => v * 2.2369363,
    ms: (v) => v * 2.2369363,
    kn: (v) => v * 1.1507794,
    kt: (v) => v * 1.1507794,
    knots: (v) => v * 1.1507794,
  },
  snowfall: {
    inch: (v) => v,
    in: (v) => v,
    cm: (v) => v / 2.54,
    mm: (v) => v / 25.4,
  },
};

export function unitConverter(field: string, unit: unknown): (v: number) => number {
  const table = UNIT_CONVERSIONS[field];
  if (!table) throw new Error(`no unit table for ${field}`);
  const fn = table[String(unit ?? "").trim().toLowerCase()];
  if (!fn) throw new Error(`OpenMeteo returned ${field} in an unusable unit: ${unit ?? "(absent)"}`);
  return fn;
}

/** Pure half of fetchStormForecast — exported so the units contract is testable without a fetch. */
export function parseStormForecast(body: any): StormForecastHour[] {
  const hourly = body?.hourly ?? {};
  const units = body?.hourly_units ?? {};
  // Resolved BEFORE the map so an unusable unit fails the whole poll rather than silently
  // mixing converted and raw hours.
  const toF = unitConverter("temperature_2m", units.temperature_2m);
  const toMph = unitConverter("wind_gusts_10m", units.wind_gusts_10m);
  const toInch = unitConverter("snowfall", units.snowfall);
  const times: string[] = hourly.time ?? [];
  // NaN survives every converter, so absent readings stay NaN and fail the threshold filters.
  return times.map((ts, i) => ({
    ts,
    tempF: toF(Number(hourly.temperature_2m?.[i] ?? NaN)),
    gustMph: toMph(Number(hourly.wind_gusts_10m?.[i] ?? NaN)),
    snowfallIn: toInch(Number(hourly.snowfall?.[i] ?? 0)),
    weatherCode: Number(hourly.weather_code?.[i] ?? 0),
  }));
}

export async function fetchStormForecast(lat: string, lon: string): Promise<StormForecastHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,wind_gusts_10m,snowfall,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&forecast_days=3&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenMeteo fetch failed: ${res.status}`);
  return parseStormForecast(await res.json());
}

function triggerWindow(qualifying: StormForecastHour[]): { onset: string; expires: string } {
  const first = qualifying[0].ts;
  const last = qualifying[qualifying.length - 1].ts;
  return { onset: first, expires: new Date(new Date(last).getTime() + 6 * H).toISOString() };
}

export function deriveSyntheticTriggers(hours: StormForecastHour[]): SyntheticTrigger[] {
  const triggers: SyntheticTrigger[] = [];

  // North Shore (5A coastal) design temp ~7°F: a sub-0°F bar almost never fires here, so a
  // genuine cold snap never pre-charged. Bar is <10°F sustained ≥3 h (matches the wind ≥3 h /
  // freezing-rain ≥2 h sustained-count pattern) — fires on a real cold event, not every dip.
  const cold = hours.filter((h) => h.tempF < 10);
  if (cold.length >= 3) {
    triggers.push({
      kind: "extreme-cold",
      detail: `forecast low ${Math.min(...cold.map((h) => h.tempF))}F across ${cold.length} h`,
      ...triggerWindow(cold),
    });
  }

  const windy = hours.filter((h) => h.gustMph > 45);
  if (windy.length >= 3) {
    triggers.push({
      kind: "high-wind",
      detail: `gusts to ${Math.max(...windy.map((h) => h.gustMph))} mph across ${windy.length} h`,
      ...triggerWindow(windy),
    });
  }

  const icy = hours.filter((h) => h.weatherCode === 66 || h.weatherCode === 67);
  if (icy.length >= 2) {
    triggers.push({
      kind: "freezing-rain",
      detail: `freezing rain in ${icy.length} forecast hours`,
      ...triggerWindow(icy),
    });
  }

  const snowy = hours.filter((h) => h.snowfallIn > 0);
  const totalSnowIn = snowy.reduce((sum, h) => sum + h.snowfallIn, 0);
  if (totalSnowIn >= 8) {
    triggers.push({
      kind: "heavy-snow",
      detail: `${totalSnowIn.toFixed(1)} in total snowfall`,
      ...triggerWindow(snowy),
    });
  }

  return triggers;
}

export async function fetchOutageStatus(baseUrl: string): Promise<{ hasActiveOutage: boolean } | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/status`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    // OutageWatch returns an ARRAY of monitor statuses (verified live 2026-07-14);
    // accept both shapes and report an outage if any monitor has one.
    const monitors = Array.isArray(body) ? body : [body];
    const flags = monitors.map((m) => m?.hasActiveOutage).filter((v) => typeof v === "boolean");
    if (!flags.length) return null;
    return { hasActiveOutage: flags.some(Boolean) };
  } catch {
    return null;
  }
}

interface LiveTrigger {
  name: string;
  onsetMs: number;
  expiresMs: number;
}

function liveTriggers(inputs: StormInputs, nowMs: number): LiveTrigger[] {
  const live: LiveTrigger[] = [];
  for (const a of inputs.alerts) {
    if (a.tier !== "arm") continue;
    const expiresMs = a.expires ? Date.parse(a.expires) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    const onsetMs = a.onset ? Date.parse(a.onset) : NaN;
    live.push({ name: a.event, onsetMs: Number.isFinite(onsetMs) ? onsetMs : nowMs, expiresMs });
  }
  for (const t of inputs.synthetic) {
    const expiresMs = Date.parse(t.expires);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    const onsetMs = Date.parse(t.onset);
    live.push({ name: t.kind, onsetMs: Number.isFinite(onsetMs) ? onsetMs : nowMs, expiresMs });
  }
  live.sort((a, b) => a.onsetMs - b.onsetMs);
  return live;
}

/** Always the armed variant — narrowed so callers can read the window without re-narrowing. */
function armFrom(trigger: LiveTrigger): Extract<StormState, { kind: "armed" }> {
  return {
    kind: "armed",
    trigger: trigger.name,
    windowStart: new Date(trigger.onsetMs - PRECHARGE_LEAD_H * H).toISOString(),
    windowEnd: new Date(trigger.expiresMs + 6 * H).toISOString(),
  };
}

export function evaluateStormState(
  prev: StormState,
  inputs: StormInputs,
  now: Date,
): { state: StormState; transitions: string[] } {
  const nowMs = now.getTime();

  // 1. Manual disarm always wins; suppress re-arming for 12 h.
  if (inputs.manual?.disarm) {
    return {
      state: { kind: "idle", suppressedUntil: new Date(nowMs + 12 * H).toISOString() },
      transitions: ["manual-disarm"],
    };
  }

  // 2. Manual arm.
  const armHours = inputs.manual?.armHours;
  if (armHours && armHours > 0) {
    return {
      state: {
        kind: "armed",
        trigger: "manual",
        windowStart: now.toISOString(),
        windowEnd: new Date(nowMs + armHours * H).toISOString(),
      },
      transitions: ["manual-arm"],
    };
  }

  const prevWindowEndMs =
    prev.kind === "armed" || prev.kind === "active" ? Date.parse(prev.windowEnd) : NaN;

  // 3. A confirmed grid outage activates immediately.
  if (inputs.outageActive === true) {
    const trigger = prev.kind === "armed" || prev.kind === "active" ? prev.trigger : "outage";
    const windowEndMs = Math.max(
      Number.isFinite(prevWindowEndMs) ? prevWindowEndMs : 0,
      nowMs + 6 * H,
    );
    return {
      state: { kind: "active", trigger, windowEnd: new Date(windowEndMs).toISOString() },
      transitions: prev.kind === "active" ? [] : ["outage-activate"],
    };
  }

  // Debounce: outage cleared (or unreachable) while active — hold until the window closes.
  if (prev.kind === "active") {
    if (Number.isFinite(prevWindowEndMs) && nowMs <= prevWindowEndMs) {
      return { state: prev, transitions: [] };
    }
    return { state: { kind: "idle" }, transitions: ["stand-down"] };
  }

  const live = liveTriggers(inputs, nowMs);

  // 5. Armed: re-time as the forecast sharpens, hold through the window, stand down after it
  //    unless a trigger is still live.
  if (prev.kind === "armed") {
    // #119: a window computed at arm time used to be frozen until it lapsed, so a storm that
    // shifted left the window behind — live on 2026-09-25, the held window ended 8 h before the
    // forecast peak. Re-time to the current best trigger when it has moved more than the jitter
    // threshold. A MANUAL arm is the owner's explicit window and is never re-timed by a forecast.
    // Re-timing applies only while the held window is still CURRENT. Once it has lapsed the
    // existing stand-down / re-arm path owns the decision — re-time must not pre-empt it.
    if (Number.isFinite(prevWindowEndMs) && nowMs <= prevWindowEndMs) {
      if (prev.trigger !== "manual" && live.length > 0) {
        const candidate = armFrom(live[0]);
        if (Math.abs(Date.parse(candidate.windowEnd) - prevWindowEndMs) > RETIME_MIN_SHIFT_MS) {
          return { state: candidate, transitions: ["re-time"] };
        }
      }
      return { state: prev, transitions: [] };
    }
    if (live.length === 0) {
      return { state: { kind: "idle" }, transitions: ["stand-down"] };
    }
    return { state: armFrom(live[0]), transitions: ["re-arm"] };
  }

  // 4. Idle: manual-disarm suppression blocks re-arming until it lapses.
  const suppressedUntilMs = prev.suppressedUntil ? Date.parse(prev.suppressedUntil) : NaN;
  if (Number.isFinite(suppressedUntilMs) && nowMs < suppressedUntilMs) {
    return { state: prev, transitions: [] };
  }
  if (live.length > 0) {
    return { state: armFrom(live[0]), transitions: ["arm"] };
  }

  // 6. outageActive === null never changes state by itself.
  return { state: { kind: "idle" }, transitions: [] };
}

/**
 * Storm pre-charge ceiling: the curve target raised by `stepF`, never above `capF`.
 *
 * `stepF` defaults to 3 °F, which is what has shipped since 2026-07-14 and is deliberately
 * unchanged here — but it buys only ~0.8 kWh thermal (~a third of a shower, ~2.6 h of coast).
 * `knowledge/reference/storm-precharge-economics.md` measures the trade and argues for 10 °F
 * (to `strictCapF` 135): ~1.6 showers and ~12.8 h of coast for ~$0.39, with an 8 % COP penalty.
 * That is a change to this house's heating behaviour and is the owner's call (#114), so it is
 * exposed as a parameter rather than silently redefined.
 */
export function stormCeilingF(hbxCurveTargetF: number | null, capF: number, stepF = 3): number {
  return Math.min((hbxCurveTargetF ?? capF) + stepF, capF);
}
