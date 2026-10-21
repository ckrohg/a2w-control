/**
 * @purpose Pure peer-counting rules for the non-blocking single-writer guard (#36), split out of index.ts so the
 * redeploy case is testable. Every A2W planner deploy used to log a phantom "Second planner instance detected":
 * the old container's planner_instances row outlived the container (its shutdown drop came last and a 12 s hard exit
 * could beat it), and the 12-min INSTANCE_FRESH_MS window kept counting it as live (2026-10-20 21:47 ET: d2df60d3ffb4
 * listed as a peer for ~12 min after it stopped). A live planner heartbeats once per poll, so a row older than
 * ~1.5 polls belongs to a dead process, and a dead row's heartbeat_at never moves — so a peer is "sustained" only when
 * it is seen on two consecutive polls AND its heartbeat advanced in between. Age alone is not enough: a row left ~1 min
 * before SIGTERM is still under 1.5 polls when the successor polls again 5 min later. INSTANCE_FRESH_MS still governs
 * the writer lease; this is only the peer count.
 */

/** ageMs and heartbeatAtMs both come from the DB (its clock and its stored timestamp), never the client clock. */
export interface PeerHeartbeat { instanceId: string; ageMs: number; heartbeatAtMs: number }

/** A peer whose last heartbeat is older than this is treated as gone: 1.5× the poll leaves a slow poll room. */
export function peerLiveMs(pollSeconds: number): number {
  return Math.round(1.5 * pollSeconds * 1000);
}

/** Ids of peers that heartbeated within maxAgeMs (DB-clock age). */
export function livePeers(rows: PeerHeartbeat[], maxAgeMs: number): string[] {
  return rows.filter((r) => Number.isFinite(r.ageMs) && r.ageMs <= maxAgeMs).map((r) => r.instanceId);
}

/**
 * One poll of the guard: the peers live now, and the ones that were also live on the previous poll and have heartbeated
 * since ("sustained"). Requiring two consecutive polls filters a rolling redeploy's brief overlap; requiring the
 * heartbeat to advance filters a dead container's leftover row. `next` (id → heartbeat) is `prev` on the next poll.
 */
export function observePeers(prev: ReadonlyMap<string, number>, rows: PeerHeartbeat[], maxAgeMs: number):
  { peers: string[]; sustained: string[]; next: Map<string, number> } {
  const fresh = rows.filter((r) => Number.isFinite(r.ageMs) && r.ageMs <= maxAgeMs && Number.isFinite(r.heartbeatAtMs));
  const sustained = fresh.filter((r) => { const before = prev.get(r.instanceId); return before != null && r.heartbeatAtMs > before; })
    .map((r) => r.instanceId);
  return { peers: fresh.map((r) => r.instanceId), sustained, next: new Map(fresh.map((r) => [r.instanceId, r.heartbeatAtMs])) };
}
