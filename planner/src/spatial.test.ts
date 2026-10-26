/**
 * @purpose Assertions for spatial.ts's pure helpers: warmAdjacencyByZone (the bidirectional, adjacency-only,
 * confidence-gated neighbour map), summarizeWarmAdjacency (the read-tick log line) and adjacencyAdjustedFloor
 * (the SHADOW comfort credit that would lower the tank floor when warm-adjacent zones both call).
 * Run with: npx tsx planner/src/spatial.test.ts
 */
import assert from "node:assert/strict";
import { warmAdjacencyByZone, summarizeWarmAdjacency, adjacencyAdjustedFloor, type SpatialEdge, type SpatialGraph } from "./spatial";
import type { FloorResult, ZoneFloor } from "./demand";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const NAMES: Record<string, string> = { living: "Living Room", kitchen: "Kitchen", office: "Office", loft: "Loft", boiler: "Boiler Room" };

function edge(a: string, b: string, over: Partial<SpatialEdge> = {}): SpatialEdge {
  return {
    sourceZoneId: a, sourceName: NAMES[a] ?? a,
    targetZoneId: b, targetName: NAMES[b] ?? b,
    relationship: "adjacency", confidence: 0.9, via: null, userConfirmed: false,
    ...over,
  };
}
const graph = (...edges: SpatialEdge[]): SpatialGraph => ({ edges });

/** A ZoneFloor with only the fields adjacencyAdjustedFloor reads supplied; the rest are inert defaults. */
function zone(zoneId: string, deliveryType: string, awtF: number | null, calling: boolean): ZoneFloor {
  return {
    zoneId, name: NAMES[zoneId] ?? zoneId, deliveryType, awtF, calling,
    verified: null, learned: false, escalatedF: 0, deficitF: 0, localF: null, ceilingF: null,
    ceilingSource: null, roomF: null, setpointF: null,
  };
}

const MARGIN = 4.5; // BUFFER_MARGIN_F
/** FloorResult the way computeFloors would shape it: the binding zone is the highest calling AWT. */
function floorOf(perZone: ZoneFloor[], over: Partial<FloorResult> = {}): FloorResult {
  let binding: ZoneFloor | null = null;
  for (const z of perZone) {
    if (!z.calling || z.awtF == null) continue;
    if (binding === null || z.awtF > binding.awtF!) binding = z;
  }
  return {
    perZone,
    bindingZone: binding?.name ?? null,
    bindingAwtF: binding?.awtF ?? null,
    tankTargetF: binding ? Math.round((binding.awtF! + MARGIN) * 10) / 10 : null,
    bindingVerified: null,
    ...over,
  };
}

// ── warmAdjacencyByZone ─────────────────────────────────────────────────────────────────────────
{
  // adjacency is bidirectional: both endpoints list the other
  const adj = warmAdjacencyByZone(graph(edge("living", "kitchen", { via: "Hall" })));
  assert.equal(adj.size, 2);
  assert.deepEqual(adj.get("living"), {
    name: "Living Room",
    neighbors: [{ zoneId: "kitchen", name: "Kitchen", confidence: 0.9, via: "Hall", confirmed: false }],
  });
  assert.deepEqual(adj.get("kitchen"), {
    name: "Kitchen",
    neighbors: [{ zoneId: "living", name: "Living Room", confidence: 0.9, via: "Hall", confirmed: false }],
  });

  // 'vertical' and 'system_coupling' (and a null relationship) are not physical adjacency
  assert.equal(warmAdjacencyByZone(graph(edge("living", "loft", { relationship: "vertical" }))).size, 0);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "boiler", { relationship: "system_coupling" }))).size, 0);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { relationship: null }))).size, 0);
  const mixed = warmAdjacencyByZone(graph(
    edge("living", "kitchen"),
    edge("living", "loft", { relationship: "vertical" }),
    edge("living", "boiler", { relationship: "system_coupling" }),
  ));
  assert.deepEqual([...mixed.keys()].sort(), ["kitchen", "living"]);
  assert.deepEqual(mixed.get("living")!.neighbors.map((n) => n.zoneId), ["kitchen"]);

  // below minConfidence is dropped unless the owner confirmed it
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: 0.5 }))).size, 0);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: null }))).size, 0);
  const confirmed = warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: 0.1, userConfirmed: true })));
  assert.equal(confirmed.size, 2);
  assert.equal(confirmed.get("living")!.neighbors[0].confirmed, true);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: null, userConfirmed: true }))).size, 2);
  // the threshold is inclusive and tunable (default 0.6)
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: 0.6 }))).size, 2);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: 0.65 })), 0.7).size, 0);
  assert.equal(warmAdjacencyByZone(graph(edge("living", "kitchen", { confidence: 0.65 })), 0.6).size, 2);

  // duplicate edges (same pair, either direction) collapse to one neighbour entry
  const dup = warmAdjacencyByZone(graph(edge("living", "kitchen"), edge("kitchen", "living", { confidence: 0.8 }), edge("living", "kitchen")));
  assert.equal(dup.get("living")!.neighbors.length, 1);
  assert.equal(dup.get("kitchen")!.neighbors.length, 1);
  assert.equal(dup.get("living")!.neighbors[0].confidence, 0.9, "the first edge seen wins");

  // a zone with several neighbours keeps them in edge order
  const fan = warmAdjacencyByZone(graph(edge("living", "kitchen"), edge("office", "living")));
  assert.deepEqual(fan.get("living")!.neighbors.map((n) => n.zoneId), ["kitchen", "office"]);

  // empty graph → empty map
  assert.equal(warmAdjacencyByZone(graph()).size, 0);
}

// ── summarizeWarmAdjacency ──────────────────────────────────────────────────────────────────────
{
  assert.equal(summarizeWarmAdjacency(graph()), "none");
  assert.equal(summarizeWarmAdjacency(graph(edge("living", "loft", { relationship: "vertical" }))), "none");
  const line = summarizeWarmAdjacency(graph(
    edge("living", "kitchen", { userConfirmed: true }),
    edge("living", "office", { confidence: 0.8 }),
  ));
  // zones sorted by name; confirmed neighbours carry the ✓ suffix
  assert.equal(line, "Kitchen←[Living Room✓]; Living Room←[Kitchen✓, Office]; Office←[Living Room]");
  // minConfidence flows through
  assert.equal(summarizeWarmAdjacency(graph(edge("living", "kitchen", { confidence: 0.65 })), 0.7), "none");
}

// ── adjacencyAdjustedFloor ──────────────────────────────────────────────────────────────────────
// a) Two calling baseboard zones sharing a wall: each gets creditF off; the binding zone drops the tank target.
{
  const floor = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)]);
  assert.equal(floor.tankTargetF, 129.5);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.deepEqual(s, {
    baseTankTargetF: 129.5,
    adjustedTankTargetF: 126.5, // (125 − 3) + 4.5
    deltaF: 3,
    adjustedBindingZone: "Living Room",
    creditedZones: ["Living Room", "Kitchen"],
  });
  // creditF is tunable
  assert.equal(adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"], { creditF: 2 }).adjustedTankTargetF, 127.5);
  // adjustedTankTargetF = binding awt + marginF
  assert.equal(adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"], { marginF: 6 }).adjustedTankTargetF, 128);
}

// b) Baseboard never goes below 108 (fin-tube convection floor); a zone already at the floor is not credited.
{
  const floor = floorOf([zone("living", "baseboard", 109, true), zone("kitchen", "baseboard", 109, true)]);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.equal(s.adjustedTankTargetF, 112.5, "108 + 4.5: only 1 °F of the 3 °F credit is available");
  assert.equal(s.deltaF, 1);
  assert.deepEqual(s.creditedZones, ["Living Room", "Kitchen"]);

  const atFloor = floorOf([zone("living", "baseboard", 108, true), zone("kitchen", "baseboard", 108, true)]);
  const t = adjacencyAdjustedFloor(atFloor, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.equal(t.adjustedTankTargetF, 112.5);
  assert.equal(t.deltaF, 0);
  assert.deepEqual(t.creditedZones, []);
}

// c) Radiant / underfloor never go below 95.
{
  for (const type of ["radiant_floor", "underfloor"]) {
    const floor = floorOf([zone("living", type, 96, true), zone("kitchen", type, 96, true)]);
    const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"]);
    assert.equal(s.adjustedTankTargetF, 99.5, `${type}: 95 + 4.5`);
    assert.equal(s.deltaF, 1);
    assert.deepEqual(s.creditedZones, ["Living Room", "Kitchen"]);
  }
  // well above the floor the full credit applies
  const high = floorOf([zone("living", "radiant_floor", 110, true), zone("kitchen", "radiant_floor", 105, true)]);
  assert.equal(adjacencyAdjustedFloor(high, graph(edge("living", "kitchen")), ["living", "kitchen"]).adjustedTankTargetF, 111.5);
}

// d) An unknown deliveryType has no hard floor and therefore gets no credit.
{
  const floor = floorOf([zone("living", "mystery_emitter", 125, true), zone("kitchen", "baseboard", 120, true)]);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.equal(s.adjustedTankTargetF, 129.5, "Living Room keeps 125 and stays binding");
  assert.equal(s.deltaF, 0);
  assert.equal(s.adjustedBindingZone, "Living Room");
  assert.deepEqual(s.creditedZones, ["Kitchen"], "the baseboard neighbour is still credited (not binding)");
}

// e) A neighbour that is not calling shares no warmth: no credit.
{
  const floor = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, false)]);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living"]);
  assert.equal(s.adjustedTankTargetF, 129.5);
  assert.equal(s.deltaF, 0);
  assert.deepEqual(s.creditedZones, []);
  // the explicit call list decides who counts as a warm NEIGHBOUR: Living Room gets no credit because
  // Kitchen is not in the list, even though perZone says Kitchen calls (Kitchen itself is still
  // iterated via its perZone flag and sees Living Room in the list) — the binding zone is untouched
  const stale = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)]);
  const t = adjacencyAdjustedFloor(stale, graph(edge("living", "kitchen")), ["living"]);
  assert.deepEqual(t.creditedZones, ["Kitchen"]);
  assert.equal(t.adjustedBindingZone, "Living Room");
  assert.equal(t.deltaF, 0);
  // and a neighbour with no adjacency edge at all gives nothing
  assert.deepEqual(adjacencyAdjustedFloor(stale, graph(), ["living", "kitchen"]).creditedZones, []);
}

// f) callingZoneIds=null falls back to floor.perZone's calling flags.
{
  const both = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)]);
  const s = adjacencyAdjustedFloor(both, graph(edge("living", "kitchen")), null);
  assert.deepEqual(s.creditedZones, ["Living Room", "Kitchen"]);
  assert.equal(s.deltaF, 3);

  const one = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, false)]);
  const t = adjacencyAdjustedFloor(one, graph(edge("living", "kitchen")), null);
  assert.deepEqual(t.creditedZones, []);
  assert.equal(t.deltaF, 0);
}

// g) The credit moves the binding zone when the credited zone was binding and an uncredited zone is close behind.
{
  const floor = floorOf([
    zone("living", "baseboard", 125, true),
    zone("kitchen", "baseboard", 115, true),
    zone("office", "baseboard", 123, true), // no neighbours
  ]);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen", "office"]);
  assert.equal(s.adjustedBindingZone, "Office");
  assert.equal(s.adjustedTankTargetF, 127.5);
  assert.equal(s.deltaF, 2);
  assert.deepEqual(s.creditedZones, ["Living Room", "Kitchen"]);
}

// h) deltaF = max(0, base − adjusted) rounded to 1 dp; adjustedTankTargetF is rounded to 1 dp too.
{
  const floor = floorOf([zone("living", "baseboard", 125.33, true), zone("kitchen", "baseboard", 120, true)]);
  assert.equal(floor.tankTargetF, 129.8);
  const s = adjacencyAdjustedFloor(floor, graph(edge("living", "kitchen")), ["living", "kitchen"], { creditF: 1.25 });
  assert.equal(s.adjustedTankTargetF, 128.6); // 124.08 + 4.5 = 128.58
  assert.equal(s.deltaF, 1.2);

  // a base target already below the adjusted one never reports a negative saving
  const lowBase = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)], { tankTargetF: 120 });
  const t = adjacencyAdjustedFloor(lowBase, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.equal(t.baseTankTargetF, 120);
  assert.equal(t.adjustedTankTargetF, 126.5);
  assert.equal(t.deltaF, 0);

  // no base target → deltaF 0 but the adjusted target is still reported
  const noBase = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)], { tankTargetF: null });
  const u = adjacencyAdjustedFloor(noBase, graph(edge("living", "kitchen")), ["living", "kitchen"]);
  assert.equal(u.baseTankTargetF, null);
  assert.equal(u.adjustedTankTargetF, 126.5);
  assert.equal(u.deltaF, 0);
}

// i) Nothing calling, or no AWT, → no binding zone and no target.
{
  const idle = floorOf([zone("living", "baseboard", 125, false), zone("kitchen", "minisplit", null, true)]);
  const s = adjacencyAdjustedFloor(idle, graph(edge("living", "kitchen")), ["kitchen"]);
  assert.deepEqual(s, { baseTankTargetF: null, adjustedTankTargetF: null, deltaF: 0, adjustedBindingZone: null, creditedZones: [] });
  const empty = adjacencyAdjustedFloor(floorOf([]), graph(), null);
  assert.equal(empty.adjustedTankTargetF, null);
  assert.equal(empty.adjustedBindingZone, null);
}

// j) minConfidence defaults to 0.7 here (stricter than the log line) and owner confirmation overrides it.
{
  const floor = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)]);
  const weak = graph(edge("living", "kitchen", { confidence: 0.65 }));
  assert.equal(adjacencyAdjustedFloor(floor, weak, ["living", "kitchen"]).deltaF, 0, "0.65 < default 0.7");
  assert.equal(adjacencyAdjustedFloor(floor, weak, ["living", "kitchen"], { minConfidence: 0.6 }).deltaF, 3);
  const confirmed = graph(edge("living", "kitchen", { confidence: 0.1, userConfirmed: true }));
  assert.equal(adjacencyAdjustedFloor(floor, confirmed, ["living", "kitchen"]).deltaF, 3);
  // a vertical neighbour is never a warm neighbour, however confident
  const vertical = graph(edge("living", "kitchen", { relationship: "vertical", confidence: 1, userConfirmed: true }));
  assert.equal(adjacencyAdjustedFloor(floor, vertical, ["living", "kitchen"]).deltaF, 0);
}

// k) Pure: inputs are not mutated.
{
  const floor = floorOf([zone("living", "baseboard", 125, true), zone("kitchen", "baseboard", 120, true)]);
  const g = graph(edge("living", "kitchen"));
  const calling = ["living", "kitchen"];
  const floorBefore = JSON.stringify(floor), graphBefore = JSON.stringify(g), callingBefore = JSON.stringify(calling);
  adjacencyAdjustedFloor(floor, g, calling);
  assert.equal(JSON.stringify(floor), floorBefore);
  assert.equal(JSON.stringify(g), graphBefore);
  assert.equal(JSON.stringify(calling), callingBefore);
}

console.log("spatial.test.ts: all assertions passed");
