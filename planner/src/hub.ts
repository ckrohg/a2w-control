/**
 * @purpose Read-only hub client — GET /api/state (Bearer HUB_CLIENT_TOKEN) for the pump
 * setpoints/online flags the Pi pushes. Used by the I1 monitor. This client never sends
 * commands; the planner's write path (Phase B) will be a separate, deliberate addition.
 */

export interface HubPump {
  id: string;
  name: string;
  online: boolean;
  setpoint_c: number | null;
  // Pi pushes these in every state frame (hub PumpState); typed here for the
  // TempIQ pusher (§A-7). Older hub builds may omit them — keep them optional-null.
  inlet_c?: number | null;
  outlet_c?: number | null;
}

export interface HubState {
  pi_connected: boolean;
  ts: number | null;
  pumps: HubPump[];
}

export class HubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async getState(): Promise<HubState> {
    const res = await fetch(`${this.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`hub GET /api/state: HTTP ${res.status}`);
    const body = (await res.json()) as { pi_connected?: boolean; ts?: number | null; pumps?: HubPump[] };
    return {
      pi_connected: body.pi_connected ?? false,
      ts: body.ts ?? null,
      pumps: Array.isArray(body.pumps) ? body.pumps : [],
    };
  }

  /** Leased setpoint relay (Phase B). The Pi's guardrails (floor, bounds, rate limit,
   *  read-back) decide; a nack is a normal outcome and is returned, never thrown. */
  async sendSetpoint(
    pumpId: string,
    valueC: number,
    leaseMinutes: number,
    source: string,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/command`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pump_id: pumpId, value_c: valueC, lease_minutes: leaseMinutes, source }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (res.ok && body.ok) return { ok: true, detail: `acked ${valueC}°C` };
      return { ok: false, detail: body.detail || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
