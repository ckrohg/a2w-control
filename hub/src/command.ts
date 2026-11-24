/**
 * @purpose Pure pieces of the hub's POST /api/command relay (Phase B leased setpoints): body
 * validation, and settling the pending-ack map exactly once — one entry on its ack, or every
 * setpoint entry when the Pi link drops or is replaced. Kept out of index.ts (which starts a server on import) so the
 * rules have unit tests (command.test.ts).
 */

export const DEFAULT_COMMAND_SOURCE = "optimizer";

/** Detail of the 504 for a setpoint still in flight when the Pi link goes down (or its socket is
 *  replaced). 504, not 502: the Pi may have applied the write and only the ack was lost, so the
 *  outcome is unknown — a 502 would make the dashboard say "Rejected". The text MUST begin with
 *  "no Pi connected": planner/src/owneralerts.ts matches /no Pi connected/i to classify the failure
 *  as "Pi unreachable", even when the Pi has reconnected by the time it re-reads the hub state. */
export const PI_DISCONNECTED_DETAIL = "no Pi connected: the link dropped before the ack, so the write may or may not have been applied";

export interface SetpointCommand {
  pump_id: string;
  value_c: number;
  lease_minutes: number | null;
  source: string;
}

export type ParsedCommand = { ok: true; cmd: SetpointCommand } | { ok: false; detail: string };

/** Validate a POST /api/command body. Every `detail` is the route's 400 message, verbatim. */
export function parseCommandBody(body: unknown): ParsedCommand {
  const b = (body ?? {}) as Record<string, unknown>;
  const pumpId = b.pump_id;
  const valueC = b.value_c;

  if (typeof pumpId !== "string" || pumpId.length === 0) {
    return { ok: false, detail: "pump_id is required (string)" };
  }
  if (typeof valueC !== "number" || !Number.isFinite(valueC)) {
    return { ok: false, detail: "value_c is required (number)" };
  }

  let leaseMinutes: number | null = null;
  if (b.lease_minutes !== undefined && b.lease_minutes !== null) {
    if (typeof b.lease_minutes !== "number" || !Number.isFinite(b.lease_minutes)) {
      return { ok: false, detail: "lease_minutes must be a number when provided" };
    }
    leaseMinutes = b.lease_minutes;
  }

  let source = DEFAULT_COMMAND_SOURCE;
  if (b.source !== undefined && b.source !== null) {
    if (typeof b.source !== "string") {
      return { ok: false, detail: "source must be a string when provided" };
    }
    source = b.source;
  }

  return { ok: true, cmd: { pump_id: pumpId, value_c: valueC, lease_minutes: leaseMinutes, source } };
}

export interface PendingEntry<A> {
  resolve: (ack: A) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Called instead of `resolve` when the Pi link drops (or its socket is replaced) before the ack:
   *  a separate path from `resolve`, so a lost link can never be mistaken for the Pi's nack. Set
   *  only by POST /api/command: a breaker action carries on on the Pi after the link drops, and its
   *  504 tells the dashboard not to retry until it settles, so /api/breaker and /api/write-enable
   *  leave this unset and keep waiting out their own timeouts as before. */
  onLinkLost?: () => void;
}

/** Remove an entry and clear its timer; undefined when it was already settled. */
function take<A>(pending: Map<string, PendingEntry<A>>, commandId: string): PendingEntry<A> | undefined {
  const entry = pending.get(commandId);
  if (!entry) return undefined;
  pending.delete(commandId);
  clearTimeout(entry.timer);
  return entry;
}

/**
 * Resolve a pending command exactly once. Clears its timeout and removes it from the map so it
 * can never be resolved twice. Returns false when it was already settled (timeout, duplicate ack).
 */
export function settlePending<A>(pending: Map<string, PendingEntry<A>>, commandId: string, ack: A): boolean {
  const entry = take(pending, commandId);
  if (!entry) return false;
  entry.resolve(ack);
  return true;
}

/** The Pi link dropped or was replaced: settle every entry pending right now that has an
 *  `onLinkLost`, each exactly once, by calling it. The Pi acks only on the socket the command came
 *  in on (hub_client.py), so such an ack can never arrive. Iterates a snapshot of the ids, so a
 *  callback that touches the map cannot skip or repeat one. Returns how many were settled. */
export function failPendingOnDisconnect<A>(pending: Map<string, PendingEntry<A>>): number {
  let n = 0;
  for (const id of [...pending.keys()]) {
    if (!pending.get(id)?.onLinkLost) continue;
    const entry = take(pending, id);
    if (entry) { entry.onLinkLost!(); n++; }
  }
  return n;
}
