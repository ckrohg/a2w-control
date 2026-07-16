<!--
@purpose Consumer contract for TempIQ's spatial world-model endpoint (GET /api/insights/spatial-graph),
for the Optimize/Plan lane to wire into planner/tempiq-read.ts. Producer shipped in TempIQv2 PR #1651
(part of #1600). a2w CONSUMES this — it is not a runtime dependency; degrade gracefully if absent.
-->

# Spatial world-model — insights API contract (for the Optimize/Plan lane)

TempIQ's causal spatial world-model (#1600) is now readable. The Optimize/Plan setback logic can use it
to answer *"can I set this zone back without a comfort hit?"* — a zone with warm **adjacent** neighbors
coasts on borrowed heat.

## Endpoint
`GET https://tempiq.vercel.app/api/insights/spatial-graph`
- Auth: `Authorization: Bearer <TEMPIQ_SURFACE_TOKEN>` (the same surface token `tempiq-read.ts` already uses; property-scoped).
- Read-only, cheap, safe to poll on the existing READ_EVERY_MIN cadence alongside `/zones`, `/cop-measurements`.

## Response
```jsonc
{
  "propertyId": "...", "generatedAt": "ISO",
  "zones": [{ "zoneId", "name", "floor", "building" }],
  "edges": [{
    "sourceZoneId", "sourceName", "targetZoneId", "targetName",
    "relationship": "adjacency" | "vertical" | "system_coupling",   // (null only on legacy untagged)
    "direction": "bidirectional" | "source_to_target",
    "confidence": 0-1,          // world-prior/fused belief
    "strength": 0-1 | null,     // Phase-2 DATA-fused coupling amplitude; null = prior-only (no data yet)
    "overlap": 0-1 | null,      // vertical: partial stack fraction; adjacency: 1
    "via": "<connector>" | null,// e.g. "Upstairs Hallway" — adjacency mediated by a hall (slightly weaker)
    "system": "<name>" | null,  // system_coupling: the shared HVAC unit
    "userConfirmed": bool       // owner ground truth — highest trust
  }],
  "summary": { "adjacency", "vertical", "system_coupling", "untagged", "confirmed", "total" }
}
```

## How to use it (the load-bearing distinction)
- **`relationship='adjacency'` = "shares warmth on the same level"** — THIS is the safe-setback signal. A zone
  adjacent to zones that are currently warm/heating can be set back further before comfort degrades.
  Include `via`-a-hallway adjacency but treat it as slightly weaker (it's already lower-confidence).
- **`system_coupling` ≠ adjacency.** Two rooms on one mini-split that span floors couple *thermally through
  the equipment*, not through a shared wall. Do NOT treat system_coupling as "a warm neighbor next door."
- **`vertical`** = stacked (with a partial `overlap`); heat rises, so an upper zone gets some floor-borne
  help from a warm lower zone — a weaker, directional signal (`source_to_target` = lower→upper).
- Prefer `userConfirmed=true` edges (owner-verified). For unconfirmed, gate on `confidence` (≥0.6 is a
  reasonable floor) and, when present, `strength` (data actually saw the coupling).

## Boundaries
- a2w is standalone — consume this as an **optional enrichment**; if the call fails, fall back to the
  current setback logic. Never make Optimize depend on it to function.
- Producer side is TempIQ #1651. See [[tempiq-worldmodel-representation]] for how the graph is modeled.
