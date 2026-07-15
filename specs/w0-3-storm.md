# W0-3 — storm.ts: triggers + state machine (issue #10, plan §6.11)

Create **one new file**: `planner/src/storm.ts`. No other files. `@purpose` header
required. No new npm dependencies.

## Types (exported)

```ts
export interface StormAlert { event: string; severity: string; tier: "arm" | "notice"; onset: string | null; expires: string | null; headline: string }
export interface SyntheticTrigger { kind: string; detail: string; onset: string; expires: string }
export type StormState =
  | { kind: "idle"; suppressedUntil?: string }
  | { kind: "armed"; trigger: string; windowStart: string; windowEnd: string }
  | { kind: "active"; trigger: string; windowEnd: string };
export interface StormInputs {
  alerts: StormAlert[];
  synthetic: SyntheticTrigger[];
  outageActive: boolean | null;   // null = OutageWatch unreachable (NO signal)
  manual?: { armHours?: number; disarm?: boolean };
}
```

## Fetchers (exported)

- `export async function fetchNwsAlerts(lat: string, lon: string): Promise<StormAlert[]>`
  — `GET https://api.weather.gov/alerts/active?point={lat},{lon}` with headers
  `User-Agent: a2w-control-planner (ckrohg@me.com)` and `Accept: application/geo+json`,
  `AbortSignal.timeout(15_000)`. Keep only features whose `properties.event` matches
  `/winter storm|ice storm|blizzard|high wind|extreme cold|wind chill/i`; `tier` = "arm"
  when the event name contains "Warning", else "notice".
- `export async function fetchStormForecast(lat: string, lon: string): Promise<{ ts: string; tempF: number; gustMph: number; snowfallIn: number; weatherCode: number }[]>`
  — OpenMeteo (`api.open-meteo.com/v1/forecast`) with
  `hourly=temperature_2m,wind_gusts_10m,snowfall,weather_code`,
  `temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=3&timezone=auto`.
- `export function deriveSyntheticTriggers(hours: ReturnType-of-above): SyntheticTrigger[]`
  (pure) — emit one trigger per condition met anywhere in the horizon:
  - `extreme-cold`: any `tempF < 0`
  - `high-wind`: `gustMph > 45` in ≥3 hours
  - `freezing-rain`: `weatherCode` 66 or 67 in ≥2 hours
  - `heavy-snow`: total `snowfallIn ≥ 8`
  `onset` = first qualifying hour, `expires` = last qualifying hour + 6 h.
- `export async function fetchOutageStatus(baseUrl: string): Promise<{ hasActiveOutage: boolean } | null>`
  — `GET {baseUrl}/api/status`, 10 s timeout; **any** failure (network, non-200, parse)
  returns `null`, never throws. Unreachable = no signal, NEVER = outage.

## State machine (pure — the eval imports and drives it)

`export function evaluateStormState(prev: StormState, inputs: StormInputs, now: Date): { state: StormState; transitions: string[] }`

Rules, in priority order:
1. `manual.disarm` → `idle` with `suppressedUntil` = now + 12 h; transition "manual-disarm".
2. `manual.armHours` → `armed`, trigger "manual", window now … now + armHours h.
3. `outageActive === true` → `active` (trigger = prev trigger or "outage"), windowEnd =
   max(prev windowEnd, now + 6 h); `outageActive === false` while `active` → leave active
   only when now > windowEnd (debounce), else stay.
4. While idle and not suppressed: the earliest "arm"-tier alert or synthetic trigger with
   `expires > now` arms: windowStart = min(onset − 24 h, now), windowEnd = expires + 6 h.
5. `armed` with now > windowEnd and no live trigger → `idle`; transition "stand-down".
6. `outageActive === null` never changes state by itself.

`export function stormCeilingF(hbxCurveTargetF: number | null, capF: number): number`
— `min((hbxCurveTargetF ?? capF) + 3, capF)`.

## Constraints
- `evaluateStormState`, `deriveSyntheticTriggers`, `stormCeilingF` are pure (no I/O, no Date.now() — `now` is a parameter).
- `npx -p typescript tsc --noEmit -p planner/tsconfig.json` passes. Max 1 file changed.
