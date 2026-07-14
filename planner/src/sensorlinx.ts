/**
 * @purpose SensorLinx client for the NEW host (api.sensorlinx.co — not TempIQ's legacy
 * mobile. host). Email/password login → 15-min JWT, cached, re-login once on 401/403.
 * Reads: device polling (A-2). Writes: patchDevice() exists ONLY for the guarded
 * human-triggered path in writes.ts (envelope clamp, I1 cross-check, rate limit, audit —
 * see knowledge/reference/hbx-write-api.md). The polling loop never writes.
 */

const BASE = "https://api.sensorlinx.co";
const FETCH_TIMEOUT_MS = 30_000;

export class SensorLinxClient {
  private token: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async login(): Promise<void> {
    const res = await fetch(`${BASE}/account/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`sensorlinx login failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("sensorlinx login: no token in response");
    this.token = body.token;
  }

  /** Request with bearer; one transparent re-login on 401/403 (JWT lives ~15 min). */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.token) await this.login();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await this.login();
        continue;
      }
      if (!res.ok) throw new Error(`sensorlinx ${method} ${path}: HTTP ${res.status}`);
      return res.json();
    }
  }

  private get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  /** Per-section partial PATCH; the response echoes the full updated device (read-back). */
  async patchDevice(
    buildingId: string,
    syncCode: string,
    fields: Record<string, number>,
  ): Promise<Record<string, any>> {
    return (await this.request(
      "PATCH",
      `/buildings/${buildingId}/devices/${syncCode}`,
      fields,
    )) as Record<string, any>;
  }

  /** Full device object (all config fields + live temps/relays/stages). */
  async getDevice(buildingId: string, syncCode: string): Promise<Record<string, any>> {
    const devices = (await this.get(`/buildings/${buildingId}/devices`)) as Record<string, any>[];
    const dev = devices.find((d) => d.syncCode === syncCode);
    if (!dev) {
      throw new Error(
        `device ${syncCode} not found in building ${buildingId} (got: ${devices.map((d) => d.syncCode).join(", ")})`,
      );
    }
    return dev;
  }
}
