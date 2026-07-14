/**
 * @purpose SensorLinx read client for the NEW host (api.sensorlinx.co — not TempIQ's
 * legacy mobile. host). Email/password login → 15-min JWT, cached, re-login once on
 * 401/403. READ-ONLY by design in Phase A-2; the guarded write adapter is Phase C
 * (see knowledge/reference/hbx-write-api.md).
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

  /** GET with bearer; one transparent re-login on 401/403 (JWT lives ~15 min). */
  private async get(path: string): Promise<unknown> {
    if (!this.token) await this.login();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await this.login();
        continue;
      }
      if (!res.ok) throw new Error(`sensorlinx GET ${path}: HTTP ${res.status}`);
      return res.json();
    }
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
