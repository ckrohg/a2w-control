/**
 * @purpose SPAN circuit-power alarm for the 16.5 kW backup element (owner ask 2026-07-17): an
 * INDEPENDENT safety net for when the element's SPAN breaker is re-energized. The HBX's own
 * backup_called flag reports the controller's DECISION to call the backup (breaker-independent);
 * this watches the element's ACTUAL power draw at the SPAN panel and pages HIGH-priority the moment
 * it draws real watts — catching a genuine firing even if the HBX telemetry is delayed or missed.
 *
 * Config-gated: DORMANT unless SPAN_URL is set, so deploying this changes nothing until wired.
 * The planner runs on Railway (cloud) and SPAN's REST API is LAN-local, so point SPAN_URL at the
 * panel through a Cloudflare Tunnel (the project's existing pattern) or any reachable proxy. Reads
 * GET {SPAN_URL}/api/v1/circuits (Bearer SPAN_TOKEN), matches SPAN_BACKUP_CIRCUIT by name, and
 * edge-alerts when instantPowerW crosses SPAN_BACKUP_ALARM_W. A read failure never alarms (the HBX
 * backup_called monitor is the redundant net); it just logs.
 */

export class SpanWatch {
  private alarmed = false;
  public lastPowerW: number | null = null;
  public lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly circuitMatch: string, // case-insensitive name substring
    private readonly alarmW: number,
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
  ) {}

  async tick(): Promise<void> {
    let name = this.circuitMatch;
    let power: number | null = null;
    try {
      const res = await fetch(`${this.url.replace(/\/+$/, "")}/api/v1/circuits`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`SPAN HTTP ${res.status}`);
      const body = (await res.json()) as { circuits?: Record<string, { name?: string; instantPowerW?: number }> };
      const circuits = Object.values(body.circuits ?? {});
      const match = circuits.find((c) => (c.name ?? "").toLowerCase().includes(this.circuitMatch.toLowerCase()));
      if (!match) {
        this.lastError = `no circuit matching "${this.circuitMatch}" (of ${circuits.length})`;
        console.warn(`[spanwatch] ${this.lastError}`);
        return;
      }
      name = match.name ?? this.circuitMatch;
      power = typeof match.instantPowerW === "number" ? Math.abs(match.instantPowerW) : null;
      this.lastError = null;
    } catch (e) {
      // Read failure must NOT alarm (a tunnel hiccup ≠ the element running) — the HBX backup_called
      // monitor covers the decision side. Just record and move on.
      this.lastError = (e as Error).message;
      console.warn(`[spanwatch] read failed: ${this.lastError}`);
      return;
    }
    if (power == null) return;
    this.lastPowerW = power;

    if (power > this.alarmW && !this.alarmed) {
      this.alarmed = true;
      await this.notify(
        "16.5 kW backup element DRAWING POWER",
        `SPAN "${name}" is at ${Math.round(power)} W — the resistive element is actually running (≈$5/hour). Legitimate only on a design-cold day; otherwise the HPs aren't keeping up — investigate.`,
        "high",
      );
    } else if (power <= this.alarmW && this.alarmed) {
      this.alarmed = false;
      await this.notify("Backup element power cleared", `SPAN "${name}" back down to ${Math.round(power)} W.`);
    }
  }
}
