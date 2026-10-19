/**
 * @purpose #185 / #187: the delivery OUTBOX for edge-triggered alert episodes (alert_episodes). The row is written
 * first, the page goes out through a delivery-aware sender (index.ts ntfyDelivered: true only when a channel
 * ACKNOWLEDGED it), and notified_at is set only then. retry() re-sends open, unnotified episodes — every loop tick and
 * after a restart — so a page that failed to deliver is never silently "already alerted".
 *
 * Every episode is tracked by its row ID (codex passes 1–4 on the incident-fixes PR): a recovery closes exactly the
 * episodes that were open at that moment — never a recurrence opened afterwards — and a close the DB refused is
 * retried by ID, while those IDs are never re-sent in the meantime. An episode whose row could not be written is held
 * in memory with its delivery status until it can be persisted (then marked notified if it was already heard) or, if
 * still unheard, delivered directly; a recovery cancels it outright.
 */
export interface AlertStore {
  openAlertEpisode(kind: string, key: string, pumpId: string | null, title: string, detail: string): Promise<number>;
  markAlertNotified(id: number): Promise<void>;
  undeliveredAlertEpisodes(): Promise<{ id: number; kind: string; title: string; detail: string | null }[]>;
  closeAlertEpisodeIds(ids: number[]): Promise<void>;
}
export type Send = (title: string, body: string) => Promise<boolean>;

interface Unrecorded { kind: string; key: string; pumpId: string | null; title: string; body: string; delivered: boolean }
const k = (kind: string, key: string) => `${kind}\u0000${key}`;
const RESENT = "\n\n(re-sent: the first delivery was not acknowledged by any channel)";

export class AlertOutbox {
  /** open episode row IDs by kind/key — what a recovery closes */
  private openIds = new Map<string, Set<number>>();
  /** IDs whose close the DB refused: retried every retry(), never re-sent meanwhile */
  private unclosed = new Set<number>();
  /** IDs a channel acknowledged but whose notified_at write failed: the MARK is retried, the page never re-sent */
  private unmarked = new Set<number>();
  /** episodes whose row could not be written (with whether a channel already heard the page) */
  private unrecorded: Unrecorded[] = [];

  constructor(private readonly store: AlertStore, private readonly send: Send, private readonly log: (m: string) => void = (m) => console.error(m)) {}

  /** Re-adopt rows still open in the DB after a restart (restoreAlertState). */
  adopt(rows: { id: number; kind: string; key: string }[]): void {
    for (const r of rows) this.track(r.kind, r.key, r.id);
  }

  private track(kind: string, key: string, id: number): void {
    const s = this.openIds.get(k(kind, key)) ?? new Set<number>();
    s.add(id);
    this.openIds.set(k(kind, key), s);
  }

  async open(kind: string, key: string, pumpId: string | null, title: string, body: string): Promise<boolean> {
    const id = await this.store.openAlertEpisode(kind, key, pumpId, title, body).catch((e) => {
      this.log(`alert episode open failed: ${(e as Error).message}`); return null;
    });
    if (id != null) this.track(kind, key, id);
    const delivered = await this.send(title, body);
    if (delivered && id != null) await this.mark(id);
    if (id == null) this.unrecorded.push({ kind, key, pumpId, title, body, delivered });
    return delivered;
  }

  /**
   * The condition cleared: cancel any unrecorded episode for it, and close exactly the rows open for it NOW (by ID) —
   * a failed close is retried by ID, so an episode opened later for the same kind/key is never closed by it.
   */
  async close(kind: string, key: string): Promise<void> {
    this.unrecorded = this.unrecorded.filter((u) => !(u.kind === kind && u.key === key));
    const ids = [...(this.openIds.get(k(kind, key)) ?? [])];
    this.openIds.delete(k(kind, key));
    if (!ids.length) return;
    for (const id of ids) this.unclosed.add(id);
    await this.flushCloses();
  }

  /** notified_at — on failure the ID is remembered and only the write is retried (codex pass 5) */
  private async mark(id: number): Promise<void> {
    try { await this.store.markAlertNotified(id); this.unmarked.delete(id); }
    catch (e) { this.unmarked.add(id); this.log(`alert notified mark failed (retried, not re-sent): ${(e as Error).message}`); }
  }

  private async flushCloses(): Promise<void> {
    if (!this.unclosed.size) return;
    const ids = [...this.unclosed];
    try { await this.store.closeAlertEpisodeIds(ids); for (const id of ids) this.unclosed.delete(id); }
    catch (e) { this.log(`alert episode close failed (retried): ${(e as Error).message}`); }
  }

  /** Unrecorded episodes (in memory only). */
  pending(): number { return this.unrecorded.length; }
  /** Closes still owed to the DB. */
  pendingCloses(): number { return this.unclosed.size; }

  /**
   * Closes and notified-marks owed first; then unrecorded episodes (persisted if the DB is back — marked notified if
   * already heard — else sent directly if still unheard); then open, unacknowledged rows oldest first, excluding any
   * whose close is pending or that a channel already heard, and any whose kind `canResend` holds back (index.ts: a watch
   * that has not re-evaluated its condition since a restore); stops sending at the first failure. Returns pages sent.
   */
  async retry(canResend: (kind: string) => boolean = () => true): Promise<number> {
    await this.flushCloses();
    for (const id of [...this.unmarked]) await this.mark(id);
    let sent = 0;
    const queue = this.unrecorded;
    this.unrecorded = [];
    for (const u of queue) {
      const id = await this.store.openAlertEpisode(u.kind, u.key, u.pumpId, u.title, u.body).catch(() => null);
      if (id != null) {
        this.track(u.kind, u.key, id);
        if (u.delivered) await this.mark(id);
        continue; // an unheard one is now an outbox row: the loop below delivers it
      }
      if (!u.delivered && (await this.send(u.title, u.body + RESENT))) { sent++; u.delivered = true; }
      this.unrecorded.push(u); // still not durable — keep trying to persist it
    }
    for (const a of await this.store.undeliveredAlertEpisodes()) {
      if (this.unclosed.has(a.id) || this.unmarked.has(a.id)) continue; // resolved, or already heard
      if (!canResend(a.kind)) continue; // its watch has not re-evaluated the condition since a restore (index.ts)
      if (!(await this.send(a.title, `${a.detail ?? ""}${RESENT}`))) break;
      await this.mark(a.id);
      sent++;
    }
    return sent;
  }
}
