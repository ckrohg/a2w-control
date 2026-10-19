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

export class AlertOutbox {
  constructor(private readonly store: AlertStore, private readonly send: Send, private readonly log: (m: string) => void = (m) => console.error(m)) {}

  async open(kind: string, key: string, pumpId: string | null, title: string, body: string): Promise<boolean> {
    const id = await this.store.openAlertEpisode(kind, key, pumpId, title, body).catch((e) => {
      this.log(`alert episode open failed: ${(e as Error).message}`); return null;
    });
    const delivered = await this.send(title, body);
    if (delivered && id != null) await this.store.markAlertNotified(id).catch((e) => this.log(`alert notified mark failed: ${(e as Error).message}`));
    return delivered;
  }

  /** Re-send open, unacknowledged episodes, oldest first; stops at the first failure (channels still down). */
  async retry(): Promise<number> {
    let sent = 0;
    for (const a of await this.store.undeliveredAlertEpisodes()) {
      if (!(await this.send(a.title, `${a.detail ?? ""}\n\n(re-sent: the first delivery was not acknowledged by any channel)`))) break;
      await this.store.markAlertNotified(a.id);
      sent++;
    }
    return sent;
  }
}
