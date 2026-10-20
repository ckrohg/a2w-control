/**
 * @purpose #187 (incident 2026-10-16 F5): the SPAN-LOCAL heartbeat. Every future safety action on SPAN (element arm, any
 * self-heal) depends on the Pi's LAN poller (bridge span_local.py → exporter → the mirror's `span_readings`, ~25 s),
 * not on the cloud path spanwatch.ts polls — and on Oct 15 23:43Z the cloud failed while nothing reported whether the
 * local stream still ran. This reads the newest local sample per circuit (store.spanLocalLatest) beside spanwatch's
 * own cloud state for /health.span, and pages HIGH, edge-triggered, when the local stream is older than
 * SPAN_LOCAL_STALE_S (and once on recovery). The cloud failing ALONE shows on /health but never pages. Pure.
 */

export const SPAN_LOCAL_STALE_S = 15 * 60;

export interface SpanCloudState {
  enabled: boolean;
  last_ok_at: string | null;
  fail_streak: number;
  last_error: string | null;
  /** the backup-element alarm (spanwatch.ts): kWh the element circuit drew in the trailing 60 min — what is compared
   *  to SPAN_BACKUP_ALARM_KWH — the day-cumulative SPAN reading it is derived from, and whether a page is open */
  backup_kwh_last_hour?: number | null;
  backup_kwh_today?: number | null;
  backup_alarmed?: boolean;
}

export interface SpanHealth {
  /** when this was computed — /health serves it from memory; an old one means the check itself is failing */
  computed_at: string;
  /** false = the mirror table is absent in this DB (rehearsal) — nothing can be said */
  local_table: boolean;
  /** age of the NEWEST local sample of any circuit; null when the table is absent or empty */
  local_last_reading_age_s: number | null;
  circuits_seen: { name: string; last_ts: string; age_s: number }[];
  local_stale: boolean | null;
  cloud: SpanCloudState;
}

/** byName = newest span_readings ts (epoch s, the Pi's clock) per circuit name; null when the table is absent. */
export function spanHealth(byName: Record<string, number> | null, nowS: number, cloud: SpanCloudState): SpanHealth {
  const circuits = Object.entries(byName ?? {})
    .map(([name, ts]) => ({ name, last_ts: new Date(ts * 1000).toISOString(), age_s: Math.max(0, Math.round(nowS - ts)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const newest = circuits.length ? Math.min(...circuits.map((c) => c.age_s)) : null;
  return {
    computed_at: new Date(nowS * 1000).toISOString(),
    local_table: byName !== null,
    local_last_reading_age_s: newest,
    circuits_seen: circuits,
    local_stale: newest == null ? null : newest > SPAN_LOCAL_STALE_S,
    cloud,
  };
}

/** Edge-triggered: one high page when the local stream goes stale, one resolved notice when it returns. */
export class SpanLocalAlarm {
  private alerted = false;
  /** A restart re-adopts an open span_local_stale episode (alert_episodes): no second page, and recovery still closes it. */
  restore(open: boolean): void { this.alerted = open; }
  step(h: SpanHealth): { title: string; body: string; priority: "high" | "default"; resolved: boolean } | null {
    if (h.local_stale === null) return null; // absent / empty table: no evidence either way — never page on it
    if (h.local_stale && !this.alerted) {
      this.alerted = true;
      const cloud = h.cloud.enabled
        ? (h.cloud.fail_streak > 0 ? `The SPAN cloud path is failing too (${h.cloud.fail_streak} in a row: ${h.cloud.last_error ?? "?"}).`
          : `The SPAN cloud path still answers (last ok ${h.cloud.last_ok_at ?? "never"}).`)
        : "The SPAN cloud watch is not configured.";
      return {
        title: "⚠ SPAN local stream stale",
        body: `The newest SPAN local sample is ${Math.round((h.local_last_reading_age_s ?? 0) / 60)} min old (limit ${SPAN_LOCAL_STALE_S / 60} min). ` +
          `The Pi's LAN poller (span_local.py → span_readings) is the path every SPAN safety action depends on. ${cloud} ` +
          `Check the Pi link (/health.pi) and the panel's local API.`,
        priority: "high", resolved: false,
      };
    }
    if (!h.local_stale && this.alerted) {
      this.alerted = false;
      return { title: "SPAN local stream recovered", body: `Newest local sample ${h.local_last_reading_age_s} s old.`, priority: "default", resolved: true };
    }
    return null;
  }
}
