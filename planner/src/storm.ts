/**
 * @purpose Storm-mode triggers + pure state machine for the planner (plan §6.11,
 * issue #10). Watches NWS active alerts and the OpenMeteo hourly forecast for
 * storm-grade conditions (extreme cold, high wind, freezing rain, heavy snow),
 * polls OutageWatch for grid outages, and folds every signal — plus manual
 * arm/disarm — through evaluateStormState, a pure idle/armed/active machine the
 * caller drives once per tick. stormCeilingF caps the storm pre-charge target
 * just above the HBX curve target. Unreachable OutageWatch = no signal, never
 * an outage.
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
      expires: p.expires ?? p.ends ?? null,
      headline: String(p.headline ?? event),
    });
  }
  return alerts;
}

export async function fetchStormForecast(lat: string, lon: string): Promise<StormForecastHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,wind_gusts_10m,snowfall,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&forecast_days=3&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenMeteo fetch failed: ${res.status}`);
  const body = (await res.json()) as any;
  const hourly = body?.hourly ?? {};
  const times: string[] = hourly.time ?? [];
  return times.map((ts, i) => ({
    ts,
    tempF: Number(hourly.temperature_2m?.[i] ?? NaN),
    gustMph: Number(hourly.wind_gusts_10m?.[i] ?? NaN),
    snowfallIn: Number(hourly.snowfall?.[i] ?? 0),
    weatherCode: Number(hourly.weather_code?.[i] ?? 0),
  }));
}

function triggerWindow(qualifying: StormForecastHour[]): { onset: string; expires: string } {
  const first = qualifying[0].ts;
  const last = qualifying[qualifying.length - 1].ts;
  return { onset: first, expires: new Date(new Date(last).getTime() + 6 * H).toISOString() };
}

export function deriveSyntheticTriggers(hours: StormForecastHour[]): SyntheticTrigger[] {
  const triggers: SyntheticTrigger[] = [];

  const cold = hours.filter((h) => h.tempF < 0);
  if (cold.length >= 1) {
    triggers.push({
      kind: "extreme-cold",
      detail: `forecast low ${Math.min(...cold.map((h) => h.tempF))}F`,
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

function armFrom(trigger: LiveTrigger, nowMs: number): StormState {
  return {
    kind: "armed",
    trigger: trigger.name,
    windowStart: new Date(Math.min(trigger.onsetMs - 24 * H, nowMs)).toISOString(),
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

  // 5. Armed: hold through the window; stand down after it unless a trigger is still live.
  if (prev.kind === "armed") {
    if (Number.isFinite(prevWindowEndMs) && nowMs <= prevWindowEndMs) {
      return { state: prev, transitions: [] };
    }
    if (live.length === 0) {
      return { state: { kind: "idle" }, transitions: ["stand-down"] };
    }
    return { state: armFrom(live[0], nowMs), transitions: ["re-arm"] };
  }

  // 4. Idle: manual-disarm suppression blocks re-arming until it lapses.
  const suppressedUntilMs = prev.suppressedUntil ? Date.parse(prev.suppressedUntil) : NaN;
  if (Number.isFinite(suppressedUntilMs) && nowMs < suppressedUntilMs) {
    return { state: prev, transitions: [] };
  }
  if (live.length > 0) {
    return { state: armFrom(live[0], nowMs), transitions: ["arm"] };
  }

  // 6. outageActive === null never changes state by itself.
  return { state: { kind: "idle" }, transitions: [] };
}

export function stormCeilingF(hbxCurveTargetF: number | null, capF: number): number {
  return Math.min((hbxCurveTargetF ?? capF) + 3, capF);
}
