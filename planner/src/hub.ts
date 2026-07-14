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
}
