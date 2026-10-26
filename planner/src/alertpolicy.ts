/**
 * @purpose The owner alert policy (knowledge/reference/alert-policy.md, 2026-10-20). Every notification declares a TIER;
 * this file is the one place that turns a tier into channels. The owner got ~420 A2W emails in the 30 days to
 * 2026-10-20 and almost none needed a human, so the bar is: notify on OUTCOMES (the house is at risk, or a person must
 * physically do something), never on the system's internal mechanics.
 *
 *   page       6bb phone push + email   the house is at risk, or a human must act soon
 *   attention  email only               nothing is wrong right now, but someone should look this week
 *   record     neither                  ntfy log + DB row + dashboard + Monday digest
 *
 * All-clears are never their own notification: a resolved call carries the tier of the alert it resolves, and only a
 * PAGE gets one (6bb replaces the alert by tag, plus one email so the inbox thread is closed). Attention and record
 * all-clears are record-only.
 *
 * Keyed alerts are latched in the DB (notify_latches), so a redeploy that loses the in-memory edge state never re-pages
 * a condition already sent, and a condition still true is re-sent at most once per RENOTIFY_MS.
 */
export type Tier = "page" | "attention" | "record";

export interface Route { push: boolean; email: boolean }

export type NotifyOpts = {
  /** who should hear it. Required: every call site has to be classified. */
  tier: Tier;
  /** an all-clear: `tier` is the tier of the alert it resolves (only a page gets one) */
  resolved?: boolean;
  /** latch key (notify_latches): suppresses a redeploy's re-fire and replaces the 6bb push on resolve */
  key?: string;
  /** email only (alertemail.ts): what the owner should do — boxed at the top. Required in spirit for page/attention. */
  action?: string;
  /** email only: a short label/value table under the action */
  facts?: [string, string][];
  /** email only: a complete custom HTML body (the pump-health digest) instead of the standard layout */
  html?: string;
};
export type Notify = (title: string, body: string, priority: string, opts: NotifyOpts) => Promise<unknown>;

export function route(tier: Tier, resolved = false): Route {
  if (resolved) return tier === "page" ? { push: true, email: true } : { push: false, email: false };
  return { push: tier === "page", email: tier !== "record" };
}

/** Subject lines carry the tier, so the inbox reads at a glance. */
export function tierSubject(title: string, tier: Tier, resolved = false): string {
  const t = title.trim();
  const core = t.replace(/^[\u26A0\u2705\u2713\u{1F6A8}\uFE0F\s]+/u, "").replace(/^\s*A2W\s*[:—-]\s*/i, "").trim() || t;
  if (resolved) return `✅ A2W RESOLVED — ${core}`;
  if (tier === "page") return `🚨 A2W — ${core}`;
  if (tier === "attention") return `A2W needs a look — ${core}`;
  return /^a2w\b/i.test(t) ? t : `A2W — ${t}`;
}

/** A condition still true after a restart (or never resolved) is re-sent at most this often. */
export const RENOTIFY_MS = 24 * 3_600_000;
/** More pages than this in 7 days means the alerting itself is broken: logged loudly, surfaced on /health. */
export const PAGE_BUDGET_PER_WEEK = 3;

export interface LatchStore {
  getNotifyLatch(key: string): Promise<{ tier: string; notifiedAt: Date } | null>;
  upsertNotifyLatch(key: string, tier: Tier): Promise<void>;
  deleteNotifyLatch(key: string): Promise<{ tier: string } | null>;
}

export class Latches {
  constructor(private readonly store: LatchStore, private readonly log: (m: string) => void = (m) => console.error(m)) {}

  /** True when this open should reach the owner's channels. A DB failure fails OPEN: a duplicate beats a lost page. */
  async claim(key: string, tier: Tier, nowMs = Date.now()): Promise<boolean> {
    try {
      const row = await this.store.getNotifyLatch(key);
      if (row && nowMs - row.notifiedAt.getTime() < RENOTIFY_MS) return false;
      await this.store.upsertNotifyLatch(key, tier);
      return true;
    } catch (e) {
      this.log(`notify latch claim failed for ${key} (sending anyway): ${(e as Error).message}`);
      return true;
    }
  }

  /**
   * Release on resolve. Returns the tier the alert was SENT at, or null when nothing was sent for it (so no all-clear
   * is due). A DB failure returns the caller's tier: an extra all-clear beats a page left hanging.
   */
  async release(key: string, fallback: Tier): Promise<Tier | null> {
    try {
      const row = await this.store.deleteNotifyLatch(key);
      return row ? (row.tier as Tier) : null;
    } catch (e) {
      this.log(`notify latch release failed for ${key}: ${(e as Error).message}`);
      return fallback;
    }
  }
}

/** Rolling 7-day page count. */
export class PageBudget {
  private pages: number[] = [];
  note(nowMs = Date.now()): number {
    this.pages = this.pages.filter((t) => nowMs - t < 7 * 86_400_000);
    this.pages.push(nowMs);
    return this.pages.length;
  }
  count(nowMs = Date.now()): number { return this.pages.filter((t) => nowMs - t < 7 * 86_400_000).length; }
  over(nowMs = Date.now()): boolean { return this.count(nowMs) > PAGE_BUDGET_PER_WEEK; }
}

/** Tier for an alert_episodes kind (the outbox): one place, so a new watch has to be classified here. */
export function episodeTier(kind: string): Tier {
  if (kind.startsWith("pump_")) return "attention";       // promoted pump-health checks: a real equipment trend
  if (kind === "backup_gate") return "attention";          // A2W closed the element breaker itself: worth knowing, not acting
  // #212: a pump a person switched off is still off hours later while the HBX calls for it — the one reminder per stop
  // (a forgotten switch-off in January): someone has to switch it back on
  if (kind === "stopped_reminder") return "page";
  // stage_unserved / fault_called / span_local_stale: symptoms that the one "no heat" incident (checkUnserved) and the
  // bridge's sustained-fault and Pi-unreachable pages already cover — record them, never page them twice.
  return "record";
}

/** Pi unreachable: page sooner when it's cold, because then the Pi is the thing keeping the plant optimal and visible. */
export function piUnreachablePageAfterS(outdoorF: number | null): number {
  return outdoorF != null && outdoorF < 32 ? 2 * 3600 : 12 * 3600;
}
