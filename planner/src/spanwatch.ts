/**
 * @purpose SPAN backup-element power alarm via the SPAN CLOUD API — no tunnel (planner is cloud,
 * SPAN's local API is LAN-only, so we use the same cloud path TempIQ uses). Auths with the SPAN
 * account (SRP via amazon-cognito-identity-js), polls the per-circuit current-hour energy, and pages
 * HIGH-priority when the 16.5 kW backup circuit consumes real energy this hour — an idle circuit reads
 * ~0 kWh, the element running spikes it to kWh within a minute. Independent net vs the HBX's own
 * backup_called DECISION flag (this confirms ACTUAL draw). Config-gated: dormant unless SPAN_USERNAME
 * is set. STANDALONE — A2W's own SPAN login; the pattern is copied from TempIQ (span-cloud.ts), no
 * runtime coupling. Detection latency ~1h (SPAN's hourly energy aggregation) — fine here: the element
 * runs for hours, and backup_called is the instant signal.
 */
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type CognitoUserSession } from "amazon-cognito-identity-js";
import type { Store } from "./store";

// Public app identifiers (not secrets) — from TempIQ's HAR extraction.
const COGNITO = { userPoolId: "us-west-2_xqz9y67ID", clientId: "21vd907gimk5ctc0pop94l2lip" };
const API_BASE = "https://app-api.prod.span-csp.com";

const BUILDINGS_Q = `query { data: currentUser { buildings { name buildingId accepted } } }`;
const HOUR_ENERGY_Q = `
  query getCurrentHourEnergy($buildingId: String!) {
    data: currentUser {
      building: specificBuilding(buildingId: $buildingId) {
        buildingId
        multiPanels { panelId spaces {
          spaceId name state
          currentHour: measurementAggregation(type: ENERGY_OVER_TIME, window: {
            duration: DAY, windowsBack: 0, resolution: HOURLY, partialComparison: false, calendarWindows: true
          }) { value unit }
        } }
      }
    }
  }`;

export class SpanWatch {
  private token: string | null = null;
  private tokenExpMs = 0;
  private buildingId: string | null = null;
  private alarmed = false;
  private loggedOk = false;
  public lastKwh: number | null = null;
  public lastError: string | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly circuitMatch: string, // case-insensitive circuit-name substring
    private readonly alarmKwh: number,      // page when this hour's energy exceeds this (kWh)
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
    private readonly fixedBuildingId?: string,
    private readonly store?: Store,         // when set, accumulate pump energy → span_energy
    private readonly pumpMatch?: string,    // case-insensitive substring for the pump circuits (Air-Water)
  ) {
    if (fixedBuildingId) this.buildingId = fixedBuildingId;
  }

  /** SRP login (amazon-cognito-identity-js), same as TempIQ. Returns a JWT access token. */
  private auth(): Promise<string> {
    return new Promise((resolve, reject) => {
      const pool = new CognitoUserPool({ UserPoolId: COGNITO.userPoolId, ClientId: COGNITO.clientId });
      const user = new CognitoUser({ Username: this.username, Pool: pool });
      user.authenticateUser(new AuthenticationDetails({ Username: this.username, Password: this.password }), {
        onSuccess: (s: CognitoUserSession) => {
          this.tokenExpMs = s.getAccessToken().getExpiration() * 1000;
          resolve(s.getAccessToken().getJwtToken());
        },
        onFailure: (e) => reject(new Error(`SPAN Cognito auth failed: ${e.message}`)),
      });
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpMs - 60_000) return this.token;
    this.token = await this.auth();
    return this.token;
  }

  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SPAN GraphQL ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as { data?: any; errors?: unknown };
    if (j.errors) throw new Error(`SPAN GraphQL errors: ${JSON.stringify(j.errors).slice(0, 160)}`);
    return j.data;
  }

  private async findBuilding(): Promise<string> {
    if (this.buildingId) return this.buildingId;
    const d = await this.gql(BUILDINGS_Q, {});
    const buildings: any[] = d?.data?.buildings ?? [];
    const b = buildings.find((x) => x.accepted) ?? buildings[0];
    if (!b?.buildingId) throw new Error("no SPAN building found for this account");
    this.buildingId = b.buildingId as string;
    return this.buildingId;
  }

  /** Poll once. Alarms when the backup circuit's current-hour energy exceeds alarmKwh. */
  async tick(): Promise<void> {
    try {
      const buildingId = await this.findBuilding();
      const d = await this.gql(HOUR_ENERGY_Q, { buildingId });
      const panels: any[] = d?.data?.building?.multiPanels ?? [];
      let hit: { name: string; kwh: number; unit: string } | null = null;
      let pumpKwh = 0; // sum of the pump (Air-Water) circuits' current-hour energy
      for (const p of panels) for (const s of p.spaces ?? []) {
        const name = (s.name ?? "").toLowerCase();
        if (name.includes(this.circuitMatch.toLowerCase())) {
          const v = Number(s.currentHour?.value);
          hit = { name: s.name ?? this.circuitMatch, kwh: Number.isFinite(v) ? v : 0, unit: s.currentHour?.unit ?? "?" };
        }
        if (this.pumpMatch && name.includes(this.pumpMatch.toLowerCase())) {
          const v = Number(s.currentHour?.value);
          if (Number.isFinite(v)) pumpKwh += v;
        }
      }
      // Accumulate the pumps' metered energy for the current hour (SPAN's per-hour value grows then
      // resets; upsertSpanEnergyHour keeps the MAX seen). Never fails the alarm path.
      if (this.store && this.pumpMatch) {
        await this.store.upsertSpanEnergyHour(new Date(), pumpKwh).catch((e) => console.error("span_energy upsert failed:", (e as Error).message));
      }
      if (!hit) {
        const names = panels.flatMap((p) => (p.spaces ?? []).map((s: any) => s.name)).filter(Boolean);
        this.lastError = `no circuit matching "${this.circuitMatch}" — available: ${names.join(" | ")}`;
        console.warn(`[spanwatch] ${this.lastError}`);
        return;
      }
      this.lastError = null;
      this.lastKwh = hit.kwh;
      if (!this.loggedOk) {
        this.loggedOk = true;
        console.log(`[spanwatch] OK — building ${buildingId}, circuit "${hit.name}" = ${hit.kwh} ${hit.unit} this hour (alarm > ${this.alarmKwh} kWh)`);
      }
      if (hit.kwh > this.alarmKwh && !this.alarmed) {
        this.alarmed = true;
        await this.notify(
          "16.5 kW backup element DREW POWER",
          `SPAN "${hit.name}" consumed ${hit.kwh.toFixed(2)} kWh this hour — the resistive element actually ran (≈$${(hit.kwh * 0.3).toFixed(2)} so far). Legitimate only on a design-cold day; otherwise the HPs aren't keeping up — investigate.`,
          "high",
        );
      } else if (hit.kwh <= this.alarmKwh && this.alarmed) {
        this.alarmed = false;
        await this.notify("Backup element power cleared", `SPAN "${hit.name}" back to ${hit.kwh.toFixed(2)} kWh this hour.`);
      }
    } catch (e) {
      // Never alarm on a read/auth failure (transient) — backup_called is the redundant net. Just log.
      this.lastError = (e as Error).message;
      console.warn(`[spanwatch] tick failed: ${this.lastError}`);
    }
  }
}
