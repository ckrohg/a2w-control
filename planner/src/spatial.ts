/**
 * @purpose Consume TempIQ's spatial world-model (GET /api/insights/spatial-graph — TempIQv2#1600/#1651):
 * the "which zones share warmth on the same level" signal for safe-setback comfort reasoning. Read-only
 * ENRICHMENT — a2w stays standalone: a fetch failure / shape drift degrades to an empty graph and never
 * throws past the HTTP guard (mirrors demand.ts::fetchInsightZones). SHADOW / ADVISORY ONLY — wired into
 * TempiqReader.tick() (observability log) and, behind ADJACENCY_SETBACK_SHADOW, the demand-floor path
 * (adjacencyAdjustedFloor: what the tank floor WOULD be if warm-adjacent zones borrowed heat). NEITHER
 * changes the live demand-floor / buffer-control decision — they only log the potential deeper-setback
 * savings for validation. See knowledge/reference/spatial-graph-api-contract.md + kanban a2w-control#33.
 */

import type { FloorResult } from "./demand";

export interface SpatialEdge {
  sourceZoneId: string;
  sourceName: string;
  targetZoneId: string;
  targetName: string;
  relationship: string | null; // "adjacency" | "vertical" | "system_coupling" | null
  confidence: number | null;
  via: string | null; // connector name when adjacency is mediated by a hallway
  userConfirmed: boolean;
}

export interface SpatialGraph {
  edges: SpatialEdge[];
}

export interface WarmNeighbor {
  zoneId: string;
  name: string;
  confidence: number | null;
  via: string | null; // "Upstairs Hallway" etc. — via-a-connector adjacency (slightly weaker)
  confirmed: boolean;
}

/**
 * GET {baseUrl}/api/insights/spatial-graph. Defensive like the other insight readers: throws only past
 * the HTTP guard; an unexpected body shape degrades to an empty edge list (never throws downstream).
 */
export async function fetchInsightSpatialGraph(baseUrl: string, token: string): Promise<SpatialGraph> {
  const res = await fetch(`${baseUrl}/api/insights/spatial-graph`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`tempiq spatial-graph: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const raw = Array.isArray((body as { edges?: unknown[] })?.edges)
    ? (body as { edges: unknown[] }).edges
    : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const edges: SpatialEdge[] = raw
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return {
        sourceZoneId: str(o.sourceZoneId),
        sourceName: str(o.sourceName),
        targetZoneId: str(o.targetZoneId),
        targetName: str(o.targetName),
        relationship: typeof o.relationship === "string" ? o.relationship : null,
        confidence: num(o.confidence),
        via: typeof o.via === "string" && o.via ? o.via : null,
        userConfirmed: o.userConfirmed === true,
      };
    })
    .filter((e) => e.sourceZoneId.length > 0 && e.targetZoneId.length > 0);
  return { edges };
}

/**
 * PURE — the "shares warmth on the same level" signal. For each zone, the ADJACENT zones
 * (relationship='adjacency') at or above `minConfidence` (owner-confirmed edges always count).
 * Adjacency is bidirectional, so both endpoints list the other. `system_coupling` and `vertical`
 * are EXCLUDED — they are not physical adjacency and must not be read as "a warm neighbor next door".
 */
export function warmAdjacencyByZone(
  graph: SpatialGraph,
  minConfidence = 0.6,
): Map<string, { name: string; neighbors: WarmNeighbor[] }> {
  const out = new Map<string, { name: string; neighbors: WarmNeighbor[] }>();
  const link = (zoneId: string, name: string, nb: WarmNeighbor) => {
    let entry = out.get(zoneId);
    if (!entry) {
      entry = { name, neighbors: [] };
      out.set(zoneId, entry);
    }
    if (!entry.neighbors.some((n) => n.zoneId === nb.zoneId)) entry.neighbors.push(nb);
  };
  for (const e of graph.edges) {
    if (e.relationship !== "adjacency") continue;
    if (!e.userConfirmed && (e.confidence ?? 0) < minConfidence) continue;
    link(e.sourceZoneId, e.sourceName, { zoneId: e.targetZoneId, name: e.targetName, confidence: e.confidence, via: e.via, confirmed: e.userConfirmed });
    link(e.targetZoneId, e.targetName, { zoneId: e.sourceZoneId, name: e.sourceName, confidence: e.confidence, via: e.via, confirmed: e.userConfirmed });
  }
  return out;
}

/** Human-readable advisory line for the read-tick log: which zones have warm adjacency. */
export function summarizeWarmAdjacency(graph: SpatialGraph, minConfidence = 0.6): string {
  const adj = warmAdjacencyByZone(graph, minConfidence);
  if (adj.size === 0) return "none";
  return [...adj.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((z) => `${z.name}←[${z.neighbors.map((n) => n.confirmed ? `${n.name}✓` : n.name).join(", ")}]`)
    .join("; ");
}

// ── Adjacency-aware setback (SHADOW) ─────────────────────────────────────────────────────────────
// The savings hypothesis: the tank floor is set by the single BINDING zone (highest required AWT among
// calling hydronic zones). A calling zone whose warm-adjacent neighbor is ALSO calling loses ~no heat
// across that shared wall, so it needs less water temp — a bounded comfort credit can lower its floor
// and, if it was binding, lower the whole tank target → a deeper buffer setback (savings). This is
// SHADOW ONLY: it recomputes an alternate floor for logging, never the live setpoint.

export interface AdjacencyFloorShadow {
  baseTankTargetF: number | null;
  adjustedTankTargetF: number | null;
  deltaF: number; // savings = base − adjusted, °F (>= 0)
  adjustedBindingZone: string | null;
  creditedZones: string[]; // calling zones that received the comfort credit
}

/** Emitter hard AWT floors (°F) the credit must never cross — mirror demand.ts::requiredAwtF minimums:
 * baseboard fin-tube convection floor 108, radiant/underfloor 95. Unknown types get no floor (no credit). */
const HARD_AWT_FLOOR_F: Record<string, number> = { baseboard: 108, radiant_floor: 95, underfloor: 95 };

/**
 * PURE / SHADOW — recompute the tank floor giving each CALLING zone a bounded comfort credit (`creditF`,
 * default 3°F) when it has a warm-adjacency neighbor (conf >= `minConfidence`, owner-confirmed always
 * counts) that is ALSO calling. The credit is floored at the emitter's hard AWT minimum. Never mutates
 * inputs, never actuates. `callingZoneIds=null` (stale /calls) → treat every zone with a floor as calling
 * (the same conservative posture computeFloors uses), which yields NO credit unless neighbors also call.
 */
export function adjacencyAdjustedFloor(
  floor: FloorResult,
  graph: SpatialGraph,
  callingZoneIds: string[] | null,
  opts: { creditF?: number; marginF?: number; minConfidence?: number } = {},
): AdjacencyFloorShadow {
  const creditF = opts.creditF ?? 3;
  const marginF = opts.marginF ?? 4.5; // BUFFER_MARGIN_F
  const warmAdj = warmAdjacencyByZone(graph, opts.minConfidence ?? 0.7);
  const calling = new Set(
    callingZoneIds ?? floor.perZone.filter((z) => z.calling).map((z) => z.zoneId),
  );

  const creditedZones: string[] = [];
  let binding: { name: string; awt: number } | null = null;
  for (const zf of floor.perZone) {
    if (!zf.calling || zf.awtF == null) continue;
    const neighbors = warmAdj.get(zf.zoneId)?.neighbors ?? [];
    const hasWarmCallingNeighbor = neighbors.some((n) => calling.has(n.zoneId));
    let awt = zf.awtF;
    if (hasWarmCallingNeighbor) {
      const hardFloor = HARD_AWT_FLOOR_F[zf.deliveryType];
      const adjusted = hardFloor == null ? awt : Math.max(awt - creditF, hardFloor);
      if (adjusted < awt) {
        awt = adjusted;
        creditedZones.push(zf.name);
      }
    }
    if (binding === null || awt > binding.awt) binding = { name: zf.name, awt };
  }

  const adjustedTankTargetF = binding ? Math.round((binding.awt + marginF) * 10) / 10 : null;
  const baseTankTargetF = floor.tankTargetF;
  const deltaF =
    baseTankTargetF != null && adjustedTankTargetF != null
      ? Math.max(0, Math.round((baseTankTargetF - adjustedTankTargetF) * 10) / 10)
      : 0;
  return {
    baseTankTargetF,
    adjustedTankTargetF,
    deltaF,
    adjustedBindingZone: binding?.name ?? null,
    creditedZones,
  };
}

/**
 * SHADOW wiring: fetch the graph and LOG what the tank floor would be if warm-adjacent zones borrowed
 * heat. Never throws (a2w stays standalone), never changes the live floor/setpoint. Gated by the caller
 * on ADJACENCY_SETBACK_SHADOW. `creditF`/`minConfidence` are env-tunable (ADJACENCY_CREDIT_F, _MIN_CONF).
 */
export async function logAdjacencyShadowFloor(
  floor: FloorResult,
  callingZoneIds: string[] | null,
  baseUrl: string,
  token: string,
): Promise<void> {
  try {
    const graph = await fetchInsightSpatialGraph(baseUrl, token);
    const creditF = Number(process.env.ADJACENCY_CREDIT_F ?? 3) || 3;
    const minConfidence = Number(process.env.ADJACENCY_MIN_CONF ?? 0.7) || 0.7;
    const s = adjacencyAdjustedFloor(floor, graph, callingZoneIds, { creditF, minConfidence });
    if (s.deltaF > 0) {
      console.log(
        `[demand] adjacency-setback SHADOW: floor ${s.baseTankTargetF}°F → ${s.adjustedTankTargetF}°F ` +
          `(−${s.deltaF}°F, binding ${s.adjustedBindingZone}, credited: ${s.creditedZones.join(", ")}) — NOT applied`,
      );
    } else {
      console.log(
        `[demand] adjacency-setback SHADOW: no deeper setback (floor ${s.baseTankTargetF}°F; no calling zone has a warm calling neighbor)`,
      );
    }
  } catch (e) {
    console.warn(`[demand] adjacency-setback SHADOW skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
