# W0-2 — demand.ts: TempIQ insights client + service-floor engine (issue #9, plan §6.9)

Create **one new file**: `planner/src/demand.ts`. No other files. `@purpose` header
required. No new npm dependencies (global `fetch`, `AbortSignal.timeout` — same style as
`shadow.ts`'s `fetchForecast`).

## Types (exported)

```ts
export interface InsightZone {
  id: string;
  name: string;
  deliveryType: string;          // "baseboard" | "radiant_floor" | "mini_split" | "dhw" | ...
  uaBtuHrF: number | null;
  thermalMassBtuF: number | null;
  confidence: number | null;
}
export interface ZoneFloor { zoneId: string; name: string; deliveryType: string; awtF: number | null; calling: boolean }
export interface FloorResult {
  perZone: ZoneFloor[];
  bindingZone: string | null;    // zone NAME with the highest active floor
  bindingAwtF: number | null;
  tankTargetF: number | null;    // bindingAwtF + BUFFER_MARGIN_F, rounded to 1 decimal
}
```

## Constants + pure functions (exported)

- `export const BUFFER_MARGIN_F = 4.5;` — buffer→emitter margin (plan §6.9, measure via reg 2051 later).
- `export function requiredAwtF(deliveryType: string, outdoorF: number, roomF = 68): number | null`
  - `baseboard`: `f = clamp((65 − outdoorF) / 60, 0, 1)`; `awt = roomF + (135 − roomF) · f^(1/1.35)`;
    return `max(awt, 108)` (fin-tube convection floor). Examples the eval asserts:
    outdoor 5 → 135±0.5; outdoor 30 → within [111, 116]; outdoor 50 → exactly 108; outdoor 70 → 108.
  - `radiant_floor` / `underfloor`: `95 + ((55 − clamp(outdoorF, 5, 55)) / 50) · 15` →
    outdoor 5 → 110; outdoor 60 → 95.
  - everything else (`mini_split`, `dhw`, unknown): return `null` (DHW/sanitize floors
    live in shadow.ts; mini-splits don't draw on the tank).
- `export function computeFloors(zones: InsightZone[], callingZoneIds: string[] | null, outdoorF: number): FloorResult`
  - `callingZoneIds === null` (no live call feed yet — TempIQ#1506): treat every zone with a
    non-null floor as calling (conservative).
  - Otherwise a zone is calling iff its id is in the list.
  - `bindingZone` = calling zone with max `awtF`; no calling zones → binding fields null
    (callers fall back to idle floors).

## TempIQ client

- `export async function fetchInsightZones(baseUrl: string, token: string): Promise<InsightZone[]>`
  — `GET {baseUrl}/api/insights/zones`, header `Authorization: Bearer {token}`,
  `AbortSignal.timeout(15_000)`; non-200 → throw. Map the response's zones array
  defensively (missing fields → null); accept both `{ zones: [...] }` and bare `[...]`.
- `export class DemandFeed`
  - `constructor(baseUrl: string, token: string)`
  - `async refresh(): Promise<void>` — fetch + cache zones, set `lastSuccessAt`; errors are
    caught and logged (`console.warn`), never thrown.
  - `isHealthy(): boolean` — `lastSuccessAt` within 30 minutes.
  - `zones(): InsightZone[]` — cached (empty array before first success).
  - `proposeFloor(outdoorF: number, callingZoneIds?: string[] | null): FloorResult | null`
    — null when unhealthy (**degraded mode: A2W never depends on TempIQ**, plan §6.9);
    otherwise `computeFloors(cached, callingZoneIds ?? null, outdoorF)`.
  - `status(): { healthy: boolean; zoneCount: number; lastSuccessAt: string | null }`

## Constraints
- Pure functions must be side-effect free (evaluable by direct import).
- `npx -p typescript tsc --noEmit -p planner/tsconfig.json` passes. Max 1 file changed.
