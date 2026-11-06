/**
 * @purpose SPAN backup-element power alarm via the SPAN CLOUD API — no tunnel (planner is cloud,
 * SPAN's local API is LAN-only, so we use the same cloud path TempIQ uses). Auths with the SPAN
 * account (SRP via amazon-cognito-identity-js) and polls each circuit's DAY-cumulative energy:
 * HOUR_ENERGY_Q asks measurementAggregation for duration: DAY / calendarWindows: true, so `value` is
 * "kWh so far today" — 0 at the building's local midnight, the day's total at 23:00 (established
 * against stored data in #207; the query's name predates that finding). The alarm differences that
 * running total poll to poll and sums the increments of the trailing 60 minutes: it pages HIGH when
 * the 16.5 kW backup circuit drew more than alarmKwh in any 60-minute window — an idle circuit adds
 * ~0, the element running adds ~0.275 kWh per minute — and clears once the trailing hour is back under
 * the threshold. Independent net vs the HBX's own backup_called DECISION flag (this confirms ACTUAL
 * draw). Config-gated: dormant unless SPAN_USERNAME is set. STANDALONE — A2W's own SPAN login; the
 * pattern is copied from TempIQ (span-cloud.ts), no runtime coupling. The same poll records the pump
 * circuits' day-cumulative value into span_energy for the realized-savings ledger (#207).
 * #124: `value` is normalized by the `unit` SPAN reports beside it (Wh or kWh, any case). A missing or unknown unit, or a
 * non-numeric value, is never guessed: the alarm path reports itself blind (lastError, failStreak) and logs it once.
 * An alarm that cannot read is silent by nature, so blindness() is the separate check that tells the owner (#257 ran
 * blind for 25 minutes with nothing but /health to show it). Energy that arrives across a blind spell LONGER than the
 * alarm window is not stamped on the last 60 min (a run that ended hours ago must not page as "in the last 60 min"):
 * it is reported apart as lastBlindSpell, emailed once if it is an element run, and stays in the day total.
 */
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type CognitoUserSession } from "amazon-cognito-identity-js";
import type { Notify } from "./alertpolicy";
import type { Store } from "./store";

// Public app identifiers (not secrets) — from TempIQ's HAR extraction.
const COGNITO = { userPoolId: "us-west-2_xqz9y67ID", clientId: "21vd907gimk5ctc0pop94l2lip" };
const API_BASE = "https://app-api.prod.span-csp.com";

/** The alarm's window: energy the element drew in the last this-many ms is what is compared to alarmKwh. */
export const BACKUP_WINDOW_MS = 60 * 60_000;
/** lastError's prefix while the backup circuit's energy cannot be read (#124) — /health.span.cloud.last_error */
export const BACKUP_BLIND = "backup-element alarm blind: ";
/** No reading this long and the owner hears about it: a whole alarm window gone, and past SPAN's brief cloud errors. */
export const BLIND_ALERT_MS = BACKUP_WINDOW_MS;

/** #124: SPAN's energy aggregate in kWh, by the unit it reports — or why it cannot be read (nothing is guessed). */
export function energyKwh(m: { value?: unknown; unit?: unknown } | null | undefined): { kwh: number } | { error: string } {
  const raw = m?.value;
  const v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(v)) return { error: `energy value ${JSON.stringify(raw ?? null)} is not a number` };
  const unit = typeof m?.unit === "string" ? m.unit.trim() : "";
  // SPAN's GraphQL spells it KILO_WATT_HOUR (live log, 2026-11-02), so the punctuation and the long form both count
  switch (unit.toLowerCase().replace(/[^a-z]/g, "")) {
    case "kwh": case "kilowatthour": return { kwh: v };
    case "wh": case "watthour": return { kwh: v / 1000 };
    default: return { error: unit ? `energy unit "${unit}" is not Wh or kWh` : "energy unit missing" };
  }
}

const BUILDINGS_Q = `query { data: currentUser { buildings { name buildingId accepted } } }`;
// `currentHour` is a historical alias: with duration: DAY / calendarWindows: true the value is the circuit's
// energy so far TODAY (local calendar day), not the current hour's. Kept as-is so the field name in stored
// evidence and in #207's analysis still matches; the semantics are handled below.
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
  private loggedOk = false;
  /** #124: the unreadable-energy reasons already logged (each once; cleared when the reading is readable again) */
  private loggedBlind = new Set<string>();
  /** edge state: a page is open until the trailing hour is back under alarmKwh (/health.span.cloud.backup_alarmed) */
  public alarmed = false;
  /** kWh the backup circuit drew in the trailing BACKUP_WINDOW_MS — what the alarm compares to alarmKwh */
  public lastHourKwh: number | null = null;
  /** SPAN's day-cumulative reading for the backup circuit at the last successful poll (kWh so far today) */
  public lastDayKwh: number | null = null;
  public lastError: string | null = null;
  /** #187: when the cloud path last answered, and how many ticks in a row have failed since (/health.span.cloud) */
  public lastOkAt: string | null = null;
  public failStreak = 0;
  /**
   * Energy that arrived across the newest blind spell longer than BACKUP_WINDOW_MS, kept OUT of lastHourKwh because when
   * inside the spell it was drawn is unknown (/health.span.cloud.backup_kwh_blind_spell). It is still in lastDayKwh.
   */
  public lastBlindSpell: { kwh: number; from: string; to: string; minutes: number } | null = null;
  // The day counter at the previous good poll, when that poll was, and the per-poll increments still inside the window.
  private prevDayKwh: number | null = null;
  private prevOkMs: number | null = null;
  private increments: { t: number; kwh: number }[] = [];
  private startedAtMs: number | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly circuitMatch: string, // case-insensitive circuit-name substring
    private readonly alarmKwh: number,      // page when the trailing 60 minutes' energy exceeds this (kWh)
    private readonly notify: Notify,
    private readonly fixedBuildingId?: string,
    private readonly store?: Store,         // when set, accumulate pump energy → span_energy
    private readonly pumpMatch?: string,    // case-insensitive substring for the pump circuits (Air-Water)
  ) {
    if (fixedBuildingId) this.buildingId = fixedBuildingId;
  }

  /**
   * No reading of the element's circuit for BLIND_ALERT_MS, else null. Timed from the last good reading, not failStreak,
   * so a hung poll counts too, and a restart restarts the clock. The first call starts it if no poll has yet.
   */
  blindness(): { minutes: number; error: string | null } | null {
    const nowMs = this.now().getTime();
    this.startedAtMs ??= nowMs;
    const blindMs = nowMs - (this.lastOkAt ? Date.parse(this.lastOkAt) : this.startedAtMs);
    return blindMs < BLIND_ALERT_MS ? null : { minutes: Math.round(blindMs / 60_000), error: this.lastError };
  }

  /** The clock — overridable so spanwatch.test.ts can walk a scripted sequence through hour and day boundaries. */
  protected now(): Date {
    return new Date();
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

  /** The HTTP layer — protected so a test can script the GraphQL responses without Cognito or the network. */
  protected async gql(query: string, variables: Record<string, unknown>): Promise<any> {
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

  /**
   * Fold one day-cumulative reading into the trailing-hour window; returns the window's energy (kWh).
   *
   * Why difference the DAY counter here instead of asking SPAN for an HOUR window: (1) the DAY field's
   * semantics are verified against stored data (#207) — an HOUR / calendarWindows variant is not, and
   * the owner's account cannot be exercised from a dev box; (2) a calendar-hour reading restarts at 0
   * every top of the hour, so a continuously running element would clear and re-page hourly, while a
   * trailing window stays up until the element has been off for an hour; (3) the window does not care
   * how often SPAN's cloud refreshes the aggregate — a once-an-hour step of 0.3 kWh pages exactly like
   * a smooth climb. One query, one field, no second alias.
   *
   * A DROP in the counter is SPAN's calendar DAY rolling over at the building's local midnight — the
   * planner's clock never needs to know where that is. That step counts as 0: at most one poll interval
   * (~0.275 kWh at 16.5 kW) of real energy is lost at the crossing, and the following polls keep adding
   * at that rate if the element is still running. The first sample after a start only sets the baseline.
   *
   * An increment is stamped at `nowMs`, which is honest only while the previous good reading is inside the window: the
   * energy arrived in the last 60 min. After a BLIND spell longer than the window (polls failing, or unreadable, #124)
   * the increment is the whole gap's energy, and a run that ended hours ago would page as "in the last 60 min". Such an
   * increment is kept out of the window and returned as `blind` instead (lastBlindSpell, one email if it is an element
   * run): it is not lost — the day total is SPAN's own counter — but it is not pretended to be recent either. A spell
   * shorter than the window is attributed as before: the energy did arrive within the last hour.
   */
  private accrue(dayKwh: number, nowMs: number): { hourKwh: number; blind: SpanWatch["lastBlindSpell"] } {
    let blind: SpanWatch["lastBlindSpell"] = null;
    if (this.prevDayKwh !== null && dayKwh > this.prevDayKwh) {
      const kwh = dayKwh - this.prevDayKwh;
      const gapMs = this.prevOkMs === null ? 0 : nowMs - this.prevOkMs;
      if (gapMs > BACKUP_WINDOW_MS) {
        blind = { kwh, from: new Date(this.prevOkMs as number).toISOString(), to: new Date(nowMs).toISOString(), minutes: Math.round(gapMs / 60_000) };
        this.lastBlindSpell = blind;
      } else this.increments.push({ t: nowMs, kwh });
    }
    this.prevDayKwh = dayKwh;
    this.prevOkMs = nowMs;
    const cutoff = nowMs - BACKUP_WINDOW_MS;
    this.increments = this.increments.filter((x) => x.t > cutoff);
    return { hourKwh: this.increments.reduce((s, x) => s + x.kwh, 0), blind };
  }

  /** #124: warn about an unreadable energy reading the first time it is seen, not every poll. */
  private logBlindOnce(msg: string): void {
    if (this.loggedBlind.has(msg)) return;
    this.loggedBlind.add(msg);
    console.warn(`[spanwatch] ${msg}`);
  }

  /** Poll once. Alarms when the backup circuit drew more than alarmKwh in the trailing 60 minutes. */
  async tick(): Promise<void> {
    this.startedAtMs ??= this.now().getTime();
    try {
      const buildingId = await this.findBuilding();
      const d = await this.gql(HOUR_ENERGY_Q, { buildingId });
      const now = this.now();
      const panels: any[] = d?.data?.building?.multiPanels ?? [];
      let hit: { name: string; e: ReturnType<typeof energyKwh>; raw: string } | null = null;
      let pumpKwh = 0; // sum of the pump (Air-Water) circuits' day-to-date energy (see below)
      for (const p of panels) for (const s of p.spaces ?? []) {
        const name = (s.name ?? "").toLowerCase();
        if (name.includes(this.circuitMatch.toLowerCase())) {
          hit = { name: s.name ?? this.circuitMatch, e: energyKwh(s.currentHour), raw: `${s.currentHour?.value ?? "?"} ${s.currentHour?.unit ?? "?"}` };
        }
        if (this.pumpMatch && name.includes(this.pumpMatch.toLowerCase())) {
          // an unreadable pump circuit is left out, as a non-numeric value always was — never added under a guessed unit
          const e = energyKwh(s.currentHour);
          if ("kwh" in e) pumpKwh += e.kwh;
          else this.logBlindOnce(`pump circuit "${s.name}": ${e.error} — left out of span_energy`);
        }
      }
      // Record the pumps' metered energy. HOUR_ENERGY_Q asks for duration: DAY / calendarWindows: true,
      // so the value is SPAN's DAY-cumulative kWh (0 at local midnight, the day's total at 23:00), not
      // the hour's energy: each span_energy row is a running total and upsertSpanEnergyHour keeps the
      // MAX seen within the hour. Readers take a day's MAX row, never a sum (store.getRealizedDayInputs;
      // deep dive 2026-10-19 §4.1). Stored RAW on purpose — the alarm's differencing below is not applied
      // here. Never fails the alarm path.
      if (this.store && this.pumpMatch) {
        await this.store.upsertSpanEnergyHour(now, pumpKwh).catch((e) => console.error("span_energy upsert failed:", (e as Error).message));
      }
      if (!hit) {
        const names = panels.flatMap((p) => (p.spaces ?? []).map((s: any) => s.name)).filter(Boolean);
        this.lastError = `no circuit matching "${this.circuitMatch}" — available: ${names.join(" | ")}`;
        this.failStreak++;
        console.warn(`[spanwatch] ${this.lastError}`);
        return;
      }
      if ("error" in hit.e) {
        // #124: blind, like a failed read — no page, no clear, no baseline moved; the next readable poll differences
        // against the last readable one
        this.lastError = `${BACKUP_BLIND}circuit "${hit.name}": ${hit.e.error}`; // no live value in it: logged once per reason
        this.failStreak++;
        this.logBlindOnce(this.lastError);
        return;
      }
      const dayKwh = hit.e.kwh;
      for (const k of this.loggedBlind) if (k.startsWith(BACKUP_BLIND)) this.loggedBlind.delete(k); // a recurrence logs again
      this.lastError = null;
      const { hourKwh, blind } = this.accrue(dayKwh, now.getTime());
      this.lastDayKwh = dayKwh;
      this.lastHourKwh = hourKwh;
      this.lastOkAt = now.toISOString();
      this.failStreak = 0;
      if (!this.loggedOk) {
        this.loggedOk = true;
        console.log(`[spanwatch] OK — building ${buildingId}, circuit "${hit.name}" = ${dayKwh} kWh (SPAN: ${hit.raw}) so far today (alarm when > ${this.alarmKwh} kWh in 60 min)`);
      }
      if (blind) {
        // energy from a blind spell longer than the window: said once, apart from the trailing-hour alarm (whose edge
        // state is untouched), at the alarm's own tier when it is an element run — never as "in the last 60 min"
        const when = `between ${blind.from.slice(11, 16)}Z and ${blind.to.slice(11, 16)}Z (${blind.minutes} min with no reading)`;
        console.warn(`[spanwatch] "${hit.name}" drew ${blind.kwh.toFixed(2)} kWh ${when}: when inside that spell is unknown, so it is not counted toward the last 60 min; today's total is ${dayKwh.toFixed(2)} kWh`);
        if (blind.kwh > this.alarmKwh) {
          await this.notify(
            "16.5 kW backup element drew power while the alarm was blind",
            `SPAN "${hit.name}" drew ${blind.kwh.toFixed(2)} kWh ${when} — the resistive element ran at some point in that spell, which the alarm could not see at the time ` +
              `(${dayKwh.toFixed(2)} kWh so far today, ≈$${(dayKwh * 0.3).toFixed(2)}). Legitimate only on a design-cold day; otherwise the HPs aren't keeping up — investigate.`,
            "default",
            { tier: "attention",
              action: "If it wasn't bitterly cold, check both heat pumps are running; the element should only help on the coldest days.",
              facts: [["Blind spell", when], ["Drew", `${blind.kwh.toFixed(2)} kWh`], ["Today", `${dayKwh.toFixed(2)} kWh ≈ $${(dayKwh * 0.3).toFixed(2)}`]] },
          );
        }
      }
      if (hourKwh > this.alarmKwh && !this.alarmed) {
        this.alarmed = true;
        await this.notify(
          "16.5 kW backup element DREW POWER",
          `SPAN "${hit.name}" drew ${hourKwh.toFixed(2)} kWh in the last 60 min (${dayKwh.toFixed(2)} kWh so far today, ≈$${(dayKwh * 0.3).toFixed(2)}) — the resistive element actually ran. Legitimate only on a design-cold day; otherwise the HPs aren't keeping up — investigate.`,
          "high",
          // costs money, never endangers the house (the element IS the heat): worth a look, at most daily
          { tier: "attention", key: "backup-element-power",
            action: "If it isn't bitterly cold, check both heat pumps are running; the element should only help on the coldest days.",
            facts: [["Last hour", `${hourKwh.toFixed(2)} kWh`], ["Today", `${dayKwh.toFixed(2)} kWh ≈ $${(dayKwh * 0.3).toFixed(2)}`]] },
        );
      } else if (hourKwh <= this.alarmKwh && this.alarmed) {
        this.alarmed = false;
        await this.notify("Backup element power cleared", `SPAN "${hit.name}" drew ${hourKwh.toFixed(2)} kWh in the last 60 min (${dayKwh.toFixed(2)} kWh so far today).`, "default",
          { tier: "attention", resolved: true, key: "backup-element-power" });
      }
    } catch (e) {
      // Never alarm on a read/auth failure (transient) — backup_called is the redundant net. Just log.
      this.lastError = (e as Error).message;
      this.failStreak++;
      console.warn(`[spanwatch] tick failed: ${this.lastError}`);
    }
  }
}
