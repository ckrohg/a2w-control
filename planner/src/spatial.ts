/**
 * @purpose Consume TempIQ's spatial world-model (GET /api/insights/spatial-graph — TempIQv2#1600/#1651):
 * the "which zones share warmth on the same level" signal for safe-setback comfort reasoning. Read-only
 * ENRICHMENT — a2w stays standalone: a fetch failure / shape drift degrades to an empty graph and never
 * throws past the HTTP guard (mirrors demand.ts::fetchInsightZones). ADVISORY ONLY for now — wired into
 * TempiqReader.tick() as an observability log; it does NOT change the live demand-floor / buffer-control
 * decision. See knowledge/reference/spatial-graph-api-contract.md + kanban a2w-control#33.
 */

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
