/**
 * @purpose Pure pieces of the hub's POST /api/command relay (Phase B leased setpoints): body
 * validation, and settling the pending-ack map exactly once — one entry on its ack, or every
 * setpoint entry when the Pi link drops. Kept out of index.ts (which starts a server on import) so the
 * rules have unit tests (command.test.ts).
 */

export const DEFAULT_COMMAND_SOURCE = "optimizer";

/** Ack detail for commands still in flight when the Pi link goes down (502, not a 10 s stall
 *  misreported as a 504 'ack timeout'). */
export const PI_DISCONNECTED_DETAIL = "Pi disconnected before ack";

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
  /** Fail at once when the Pi link drops. Set only by POST /api/command: a breaker action carries on
   *  on the Pi after the link drops, and its 504 tells the dashboard not to retry until it settles,
   *  so /api/breaker and /api/write-enable keep waiting out their own timeouts as before. */
  failOnDisconnect?: boolean;
}

/**
 * Resolve a pending command exactly once. Clears its timeout and removes it from the map so it
 * can never be resolved twice. Returns false when it was already settled (timeout, duplicate ack).
 */
export function settlePending<A>(pending: Map<string, PendingEntry<A>>, commandId: string, ack: A): boolean {
  const entry = pending.get(commandId);
  if (!entry) return false;
  pending.delete(commandId);
  clearTimeout(entry.timer);
  entry.resolve(ack);
  return true;
}

/** The Pi link dropped: settle every entry pending right now that asked for it (failOnDisconnect),
 *  each exactly once, with the ack `makeAck` builds for its id. The Pi acks only on the socket the
 *  command came in on (hub_client.py), so such an ack can never arrive. Iterates a snapshot of the
 *  ids, so a resolver that touches the map cannot skip or repeat one. Returns how many were settled. */
export function failPendingOnDisconnect<A>(pending: Map<string, PendingEntry<A>>, makeAck: (commandId: string) => A): number {
  let n = 0;
  for (const id of [...pending.keys()]) {
    if (pending.get(id)?.failOnDisconnect !== true) continue;
    if (settlePending(pending, id, makeAck(id))) n++;
  }
  return n;
}
