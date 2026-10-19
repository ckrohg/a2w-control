/**
 * @purpose #185 / #187: the delivery OUTBOX for edge-triggered alert episodes (alert_episodes). The row is written
 * first, the page goes out through a delivery-aware sender (index.ts ntfyDelivered: true only when a channel
 * ACKNOWLEDGED it), and notified_at is set only then. retry() re-sends open, unnotified episodes — every poll and
 * after a restart — so a page that failed to deliver is never silently "already alerted" (codex pass 1 on the
 * incident-fixes PR). If even the row cannot be written, the page still goes out once.
 */
export interface AlertStore {
  openAlertEpisode(kind: string, key: string, pumpId: string | null, title: string, detail: string): Promise<number>;
  markAlertNotified(id: number): Promise<void>;
  undeliveredAlertEpisodes(): Promise<{ id: number; kind: string; title: string; detail: string | null }[]>;
}
export type Send = (title: string, body: string) => Promise<boolean>;

interface Unrecorded { kind: string; key: string; pumpId: string | null; title: string; body: string }

export class AlertOutbox {
  /**
   * Episodes whose row could not be written AND whose page was not acknowledged (codex pass 2): kept in memory and
   * retried — persist first, deliver — until one of the two succeeds. A delivered page needs no row to be retried.
   */
  private unrecorded: Unrecorded[] = [];

  constructor(private readonly store: AlertStore, private readonly send: Send, private readonly log: (m: string) => void = (m) => console.error(m)) {}

  async open(kind: string, key: string, pumpId: string | null, title: string, body: string): Promise<boolean> {
    const id = await this.store.openAlertEpisode(kind, key, pumpId, title, body).catch((e) => {
      this.log(`alert episode open failed: ${(e as Error).message}`); return null;
    });
    const delivered = await this.send(title, body);
    if (delivered && id != null) await this.store.markAlertNotified(id).catch((e) => this.log(`alert notified mark failed: ${(e as Error).message}`));
    if (!delivered && id == null) this.unrecorded.push({ kind, key, pumpId, title, body });
    return delivered;
  }

  /** Episodes neither recorded nor delivered (in memory only). */
  pending(): number { return this.unrecorded.length; }

  /**
   * Re-send open, unacknowledged episodes, oldest first; stops at the first failure (channels still down). Unrecorded
   * episodes go first: written to the outbox if the DB is back (then sent with the rest), else sent directly.
   */
  async retry(): Promise<number> {
    let sent = 0;
    const queue = this.unrecorded;
    this.unrecorded = [];
    for (const u of queue) {
      const id = await this.store.openAlertEpisode(u.kind, u.key, u.pumpId, u.title, u.body).catch(() => null);
      if (id != null) continue; // now an outbox row: the loop below delivers it
      if (await this.send(u.title, `${u.body}\n\n(re-sent: the first delivery was not acknowledged by any channel)`)) { sent++; continue; }
      this.unrecorded.push(u);
    }
    for (const a of await this.store.undeliveredAlertEpisodes()) {
      if (!(await this.send(a.title, `${a.detail ?? ""}\n\n(re-sent: the first delivery was not acknowledged by any channel)`))) break;
      await this.store.markAlertNotified(a.id);
      sent++;
    }
    return sent;
  }
}
