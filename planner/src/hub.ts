/**
 * @purpose Hub client — GET /api/state (Bearer HUB_CLIENT_TOKEN) for the pump setpoints/online flags and the SPAN
 * breaker snapshot the Pi pushes (I1 monitor, stage watch, backup gate); POST /api/command for Phase B's leased
 * setpoints; POST /api/breaker for the LIVE backup-element gate only (backupgate.ts — also needs HUB_ARM_TOKEN, the
 * same second factor the dashboard releases after a password re-entry; the Pi applies every breaker guard itself).
 */

export interface HubPump {
  id: string;
  name: string;
  online: boolean;
  setpoint_c: number | null;
  // Pi pushes these in every state frame (hub PumpState); typed here for the
  // TempIQ pusher (§A-7). Older hub builds may omit them — keep them optional-null.
  inlet_c?: number | null;
  state?: string | null; // "heating" | "idle" | "offline" — for the unserved-call check
  outlet_c?: number | null;
  // The Pi pushes both of these in every state frame, but they were never declared here, so
  // the planner structurally COULD NOT see them — which is how FINDING-1 hid for two months:
  // Phase B asserted "lease 90m" from its own constant while the Pi held no lease at all.
  // remote_lease_until is the ONLY remote evidence that the revert-to-baseline failsafe is
  // armed (the Pi records a lease only when baseline_setpoint_c is set — poller.py:600).
  remote_lease_until?: number | null;
  write_enabled?: boolean;
  /** COUNT of the pump's active faults (bridge hub_client.py state frame); the codes are in the mirror's pump_snapshots */
  active_faults?: number | null;
}

/** One allowlisted breaker in the Pi's SPAN snapshot (bridge span_control.BreakerController.snapshot). */
export interface HubBreaker {
  name: string;
  found?: boolean;
  relay_state?: "OPEN" | "CLOSED" | string | null;
  /** SPAN instantPowerW — NEGATIVE for consumption on this panel */
  power_w?: number | null;
}
export interface HubSpan {
  ts?: number | null;
  circuits?: HubBreaker[];
  /** the Pi-local fallback (bridge backup_fallback.py), when the bridge has it */
  backup_fallback?: Record<string, unknown> | null;
}

export interface HubState {
  pi_connected: boolean;
  /**
   * When the Pi pushed the frame `pumps` comes from: the Pi's own `time.time()`, UNIX SECONDS
   * (heatpump-bridge/bridge/hub_client.py:227), relayed unchanged by the hub. null until the hub has seen a frame
   * since IT started. The hub keeps serving the last frame after the Pi drops — `pi_connected` says whether the
   * Pi is there NOW, `ts` says how old `pumps` is; the HBX writer refuses I1 checks on either (#167, writes.ts
   * piStateUnverifiable).
   */
  ts: number | null;
  pumps: HubPump[];
  /** the Pi's SPAN breaker snapshot (null: no SPAN on the bridge, or a hub predating it) */
  span?: HubSpan | null;
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
    const body = (await res.json()) as { pi_connected?: boolean; ts?: number | null; pumps?: HubPump[]; span?: HubSpan | null };
    return {
      pi_connected: body.pi_connected ?? false,
      ts: body.ts ?? null,
      pumps: Array.isArray(body.pumps) ? body.pumps : [],
      span: body.span && typeof body.span === "object" ? body.span : null,
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

  /** LIVE backup gate only: one breaker action through the hub → Pi BreakerController. ok = the Pi VERIFIED the relay
   *  read-back. Never throws; a refusal / timeout is a normal outcome the caller retries later. */
  async sendBreaker(circuit: string, action: "close" | "open", armToken: string, source: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/breaker`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "X-Arm-Token": armToken, "Content-Type": "application/json" },
        body: JSON.stringify({ circuit, action, source }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      return { ok: res.ok && body.ok === true, detail: body.detail || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
