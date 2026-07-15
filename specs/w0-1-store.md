# W0-1 — store: storm_events + zone_floor_snapshots (issue #8)

Modify **only** `planner/src/store.ts`. Additive changes; do not touch existing tables,
methods, or their signatures. Follow the file's existing idioms exactly: parameterized
queries, `Number()` coercion on reads, `CREATE TABLE IF NOT EXISTS` inside
`ensureSchema()`, camelCase TS ↔ snake_case SQL.

## Schema additions (inside the existing ensureSchema template string)

```sql
CREATE TABLE IF NOT EXISTS storm_events (
  id         serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  trigger    text NOT NULL,
  detail     jsonb,
  ceiling_f  real
);
CREATE TABLE IF NOT EXISTS zone_floor_snapshots (
  ts             timestamptz PRIMARY KEY,
  zones          jsonb NOT NULL,
  binding_zone   text,
  binding_awt_f  real,
  tank_target_f  real,
  source         text
);
```

## New Store methods (exact signatures)

- `async insertStormEvent(trigger: string, detail: unknown, ceilingF: number | null): Promise<void>`
  — INSERT (detail via `JSON.stringify`).
- `async closeStormEvent(): Promise<void>` — set `ended_at = now()` on the newest open row
  (`ended_at IS NULL AND id = (SELECT max(id) FROM storm_events)` — mirror `closeI1Episode`).
- `async activeStormEvent(): Promise<{ id: number; startedAt: Date; trigger: string; ceilingF: number | null } | null>`
  — newest row with `ended_at IS NULL`, else null.
- `async insertZoneFloorSnapshot(s: { ts: Date; zones: unknown; bindingZone: string | null; bindingAwtF: number | null; tankTargetF: number | null; source: string }): Promise<void>`
  — INSERT with `ON CONFLICT (ts) DO NOTHING`.
- `async latestZoneFloorSnapshot(): Promise<{ ts: Date; bindingZone: string | null; bindingAwtF: number | null; tankTargetF: number | null } | null>`

## Constraints
- TypeScript must compile: `npx -p typescript tsc --noEmit -p planner/tsconfig.json`.
- Update the file's `@purpose` header table list to mention the two new tables.
- No new dependencies. Max 1 file changed.
