/**
 * @purpose The four owner pages the planner decides from each cycle's reading: "no heat", tank cold, freeze risk and Pi
 * unreachable (knowledge/reference/alert-policy.md). They live here rather than in index.ts because index.ts can't be
 * imported in a test, and each page's own edge is the thing worth testing.
 *
 * Every page is a PageEdge. It counts as sent only once a channel acknowledged it (index.ts ntfyDelivered): until then it
 * goes out again every cycle the condition still holds, with that cycle's numbers, and a condition that clears first owes
 * no all-clear. An all-clear no channel acknowledged goes out again the same way. One the email acknowledged counts as
 * heard even if the 6bb push failed, so the phone can still show an alert that is over. Same rule as Phase B's two pages
 * (phaseb.ts ownerAlerts). Not AlertOutbox: its send path carries no key, action or facts, so a re-sent page would lose
 * its email layout and the 6bb replace-by-tag.
 *
 * The two attention emails (outage feed silent, element alarm blind) and the R02 daily watch (owner's decision,
 * 2026-11-04: R02 three or more times on one pump in a local day → one email per pump per day) ride the same PageEdge.
 */
import { piUnreachablePageAfterS, type NotifyOpts, type Tier } from "./alertpolicy";
import type { HubState } from "./hub";
import { etDay, etDayStart } from "./pumphealth";
import { calledStagesAllStopped } from "./stagewatch";
import type { SlxReading, Store } from "./store";
import { piStateUnverifiable } from "./writes";

/** °F for an email fact ("?" when unknown). */
export const f0 = (v: number | null | undefined) => (v == null ? "?" : `${Math.round(v)} °F`);

/** The delivery-aware sender (index.ts ntfyDelivered): false when nobody heard it. */
export type SendPage = (title: string, body: string, priority: string, opts: NotifyOpts) => Promise<boolean>;

type Job = () => Promise<unknown>;

/**
 * Sends run here, one at a time and in the order they were asked for, never inside the poll. With every channel timing
 * out one send takes ~100 s, so four of them awaited in the tick would push the lease renew and Phase B back and make
 * the overlap guard (index.ts loop) skip ticks. The poll says what it wants sent and moves on. The guard doesn't cover
 * these; running one at a time does, and only a job here changes a PageEdge's state.
 */
class SendQueue {
  private jobs: Job[] = [];
  private draining: Promise<void> | null = null;

  add(job: Job): void {
    this.jobs.push(job);
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
      await job().catch((e) => console.error("[pages] send failed:", (e as Error).message));
    }
    this.draining = null;
  }

  /** Everything asked for so far has gone out. */
  async settled(): Promise<void> { while (this.draining) await this.draining; }
}

/**
 * One page's delivery state. holding() runs on every cycle the condition holds, cleared() on every cycle it is clear; a
 * cycle that can't tell runs neither.
 *   heard  the alert went out and the condition has not cleared since
 *   owed   a page reached the owner and they have not heard it ended. Not the same thing: a record-tier open (a cold tank
 *          during "no heat") is heard, so it isn't sent again, but nobody got it, so it owes nothing
 */
export class PageEdge {
  heard = false;
  private owed = false;
  /** What this page wants sent next. The newest wins: a send waiting in line takes this cycle's numbers, and no backlog builds. */
  private wanted: Job | null = null;
  constructor(private readonly key: string, private readonly queue: SendQueue) {}

  get owesAllClear(): boolean { return this.owed; }

  private want(job: Job | null): void {
    const inLine = this.wanted != null;
    this.wanted = job;
    if (job && !inLine) this.queue.add(async () => { const next = this.wanted; this.wanted = null; await next?.(); });
  }

  /** `tier` is asked when the send runs, after whatever went ahead of it. */
  holding(send: (tier: Tier) => Promise<boolean>, tier: () => Tier = () => "page"): void {
    this.want(this.heard ? null : async () => {
      if (this.heard) return;
      const at = tier();
      // Back before its all-clear was heard, this is a page again and replaces the old alert by tag. The all-clear stays
      // owed either way: if this page fails too, the phone still shows the first one.
      this.heard = await send(at);
      if (!this.heard) console.error(`[pages] no channel acknowledged ${this.key}: sending it again next cycle`);
      else if (at === "page") this.owed = true;
    });
  }

  /** `heard` tells ntfyDelivered the owner heard the page, so the all-clear is due whatever the latch says. */
  cleared(send: (heard: boolean) => Promise<boolean>): void {
    this.want(!this.heard && !this.owed ? null : async () => {
      if (!this.heard && !this.owed) return;
      const acked = await send(this.owed);
      this.heard = false;
      this.owed = this.owed && !acked;
      if (!acked) console.error(`[pages] no channel acknowledged the ${this.key} all-clear: sending it again next cycle`);
    });
  }
}

// Owner alert policy: 29 of 36 unserved calls in Sept–Oct cleared within 15 min (start-up, defrost). The buffer tank
// carries the house for hours, so only a call left unserved this long is a page.
const UNSERVED_PAGE_POLLS = 9; // ~45 min at the 5-min poll
const DHW_SHORTFALL_F = 113;   // below the 45 °C unattended floor → clearly cold for delivery (normal cycle bottoms ~117°F)
const DHW_SHORTFALL_POLLS = 12; // ~60 min sustained at the 5-min poll — a draw dip recovers well inside that (alert-policy.md)
const FREEZE_OUTDOOR_F = 5;  // design-day outdoor
const FREEZE_TANK_F = 105;   // buffer has fallen below the DHW-ready floor while it's this cold out
const PI_QUIET_ALERT_S = 600;

// ── R02 daily watch (owner's decision, 2026-11-04) ──────────────────────────────────────────────────────────────────
/** R02 occurrences on one pump within one local (America/New_York) day that make the email. */
export const R02_DAILY_COUNT = 3;
/** How far back the mirror is read: the email's 30-day count, and the window index.ts asks store.faultEdges for. */
export const R02_HISTORY_DAYS = 30;

/**
 * A fault_on this soon after an onset that has no fault_off yet is the same occurrence re-logged (the bridge restarted
 * while the code was held: its in-memory edge state starts empty, so it logs the onset again). Later than this it is a new
 * occurrence whose predecessor's clear was never logged (the code cleared while the bridge was down): R02 holds 1–3 min,
 * so an unbounded merge would have swallowed every later onset for the rest of the window.
 */
export const FAULT_RELOG_S = 10 * 60;

/** One edge of a fault code in the bridge's event log (store.faultEdges): `on` = fault_on, else fault_off. */
export interface FaultEdge { pumpId: string; ts: number; on: boolean }
/** One occurrence: the code appeared after being absent. clearedAfterS = null when no fault_off was logged (still set if it is the latest). */
export interface FaultOccurrence { ts: number; clearedAfterS: number | null }

/**
 * Edges → occurrences per pump, oldest first. A fault_on opens one, the next fault_off closes it. A second fault_on with
 * no fault_off between is the SAME occurrence when it comes within FAULT_RELOG_S (a code held across polls counts once,
 * whatever the log says), else a new one. A fault_off with nothing open (its onset is before the window) is ignored.
 */
export function faultOccurrences(edges: FaultEdge[]): Record<string, FaultOccurrence[]> {
  const out: Record<string, FaultOccurrence[]> = {};
  const open: Record<string, FaultOccurrence | undefined> = {};
  for (const e of [...edges].sort((a, b) => a.ts - b.ts)) {
    const cur = open[e.pumpId];
    if (e.on) {
      if (cur && e.ts - cur.ts <= FAULT_RELOG_S) continue;
      const o: FaultOccurrence = { ts: e.ts, clearedAfterS: null };
      (out[e.pumpId] ??= []).push(o);
      open[e.pumpId] = o;
    } else if (cur) {
      cur.clearedAfterS = Math.max(0, Math.round(e.ts - cur.ts));
      open[e.pumpId] = undefined;
    }
  }
  return out;
}

/** "3:12 PM" in the house's time zone. */
const hhmm = (s: number) => new Date(s * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
/** `latest`: the pump's newest occurrence, the only one a missing fault_off means "still set" for. */
const clearedWords = (o: FaultOccurrence, latest: boolean) =>
  o.clearedAfterS != null ? `cleared itself after ${Math.max(1, Math.round(o.clearedAfterS / 60))} min` : latest ? "still set" : "cleared, time not logged";

interface R02Watch { edge: PageEdge; today: FaultOccurrence[]; days30: number }

export class HousePages {
  private readonly queue = new SendQueue();
  private readonly noHeat = new PageEdge("no-heat", this.queue);
  private readonly dhw = new PageEdge("dhw-shortfall", this.queue);
  private readonly freeze = new PageEdge("freeze-risk", this.queue);
  private readonly pi = new PageEdge("pi-unreachable", this.queue);
  private readonly feed = new PageEdge("outage-feed-silent", this.queue);
  private readonly elementWatch = new PageEdge("element-alarm-blind", this.queue);
  private unservedStreak = 0;
  private unservedEpisodeOpen = false;
  private dhwShortfallStreak = 0;
  private piDisconnectedSince: number | null = null;
  private piQuietAlerted = false;
  private piPageDue = false;
  /** R02 daily watch, one edge per pump (`r02-recurring:<pumpId>`), created the first time a pump shows an R02. */
  private readonly r02 = new Map<string, R02Watch>();

  constructor(private readonly d: {
    send: SendPage;
    store: Pick<Store, "openUnservedEpisode" | "closeUnservedEpisode">;
    stageMap: Record<string, string>;
    dhwFloorF: number;
  }) {}

  /** Every send asked for so far has finished (the one-shot run, tests). The poll never waits for this. */
  settled(): Promise<void> { return this.queue.settled(); }

  /** /health.unserved.all_idle. alerted: an episode is open; heard: its page reached someone. */
  allIdle(): { alerted: boolean; heard: boolean; streak: number } {
    return { alerted: this.unservedEpisodeOpen, heard: this.noHeat.heard, streak: this.unservedStreak };
  }

  /**
   * Called-but-not-running (owner ask 2026-07-15; §8.1's capacity-outage rule made live): an HBX stage call is up but NO
   * pump's compressors are running. Requires the condition to persist (normal call-to-start ramps are innocent). This is
   * the alarm HP2's silent winter failure never had, and the exact state the A-4 power-cycle produced. Episodes persist
   * for the incident log, one per incident however many sends its page takes. `st` is this cycle's hub read, null if it
   * failed.
   */
  async unservedCall(reading: SlxReading, st: HubState | null, anyStageCall: boolean): Promise<void> {
    if (!anyStageCall) return this.unservedCleared("The heat call ended or a pump is running again.");
    if (!st) return; // hub unreachable — can't judge; don't false-alarm
    if (st.pumps.some((p) => p.online && p.state === "heating")) return this.unservedCleared("A pump is running against the call again.");
    if (!piStateUnverifiable(st) && calledStagesAllStopped(reading.stagesCalled, this.d.stageMap, st.pumps)) {
      // #212: every called stage's pump was switched off by a person (6bb / SPAN app / the panel). No heat is the owner's
      // choice, not a failure: the stage watch's one stopped_reminder covers a forgotten switch-off. The streak restarts.
      this.unservedStreak = 0;
      return;
    }
    this.unservedStreak++;
    if (this.unservedStreak < UNSERVED_PAGE_POLLS) return;
    const detail = `HBX stage call active ~${this.unservedStreak * 5} min with no pump running (tank ${reading.tankF ?? "?"}°F / target ${reading.tankTargetF ?? "?"}°F)`;
    if (!this.unservedEpisodeOpen) {
      this.unservedEpisodeOpen = true;
      await this.d.store.openUnservedEpisode(detail).catch(() => {});
    }
    this.noHeat.holding(() => this.d.send(
      "⚠ Heat call active but NO pump is running",
      `${detail}. Causes: pump powered off, failure-to-start (the HP2 winter pattern), or a write-disabled/faulted unit. The tank is falling while HBX waits.`,
      "high",
      // THE "no heat" incident: the per-stage unserved/fault-called episodes are its record-only symptoms
      { tier: "page", key: "no-heat",
        action: "Check both heat pumps: is each one powered on, and is either showing a fault code? Power-cycling a faulted pump's breaker at the SPAN panel often clears it.",
        facts: [["No heat for", `${this.unservedStreak * 5} min`], ["Tank", `${f0(reading.tankF)} (target ${f0(reading.tankTargetF)})`],
                ["Outdoor", f0(reading.outdoorF)],
                ["Pumps", st.pumps.map((p) => `${p.name ?? p.id}: ${p.online ? p.state ?? "?" : "offline"}`).join(" · ")]] },
    ));
  }

  private async unservedCleared(body: string): Promise<void> {
    this.unservedStreak = 0;
    if (this.unservedEpisodeOpen) {
      this.unservedEpisodeOpen = false;
      await this.d.store.closeUnservedEpisode().catch(() => {});
    }
    this.noHeat.cleared((heard) => this.d.send("Unserved call cleared", body, "default", { tier: "page", resolved: true, key: "no-heat", heard }));
  }

  /** DHW-comfort shortfall (owner ask 2026-07-16, load-bearing now that autopilot holds a low buffer):
   *  the buffer sits BELOW the DHW-ready floor for a SUSTAINED period — the HPs can't hold hot-water temp
   *  (a big draw, a genuine capacity shortfall, or a stuck-low autopilot target). This is the gap I8 does
   *  NOT cover: I8 verifies a daily HOT soak; this catches the opposite — the tank running too COLD to
   *  shower. Detection + high-priority page only (the HBX's own bkLag escalates to the element on a real
   *  drawn-down call, breaker permitting; auto-raising the target here would fight autopilot's rate-limit). */
  async dhwShortfall(reading: SlxReading): Promise<void> {
    const tankF = reading.tankF;
    if (tankF == null) return;
    if (tankF >= DHW_SHORTFALL_F) {
      this.dhwShortfallStreak = 0;
      this.dhw.cleared((heard) => this.d.send("DHW shortfall cleared", `Buffer back to ${tankF.toFixed(0)}°F — hot water recovered.`, "default", { tier: "page", resolved: true, key: "dhw-shortfall", heard }));
      return;
    }
    this.dhwShortfallStreak++;
    if (this.dhwShortfallStreak < DHW_SHORTFALL_POLLS) return;
    // one incident, one page: a cold tank while the "no heat" page is open is that incident's symptom (Oct 11 and
    // Oct 15 2026, HP2 E21: both fired for the same outage). Only a page someone HEARD covers it: if "no heat" failed on
    // every channel, this is another chance to reach them. Asked when the send runs, behind unservedCall's in the queue,
    // so a cycle that gets "no heat" through sends this as its record.
    this.dhw.holding((tier) => this.d.send(
      "⚠ DHW comfort shortfall — buffer running cold",
      `Buffer ${tankF.toFixed(0)}°F, below the ${Math.round(this.d.dhwFloorF)}°F DHW-ready floor for ~${this.dhwShortfallStreak * 5} min — the heat pumps aren't holding hot-water temp (big draw, capacity shortfall, or a stuck-low target). Showers may run lukewarm. If it persists: turn the SPAN breaker ON so the element can help, or raise the target on the Control page.`,
      "high",
      { tier, key: "dhw-shortfall",
        action: "Turn the backup element breaker ON at the SPAN panel so it can help, or raise the tank target on the Control page.",
        facts: [["Tank", `${f0(tankF)} for ${this.dhwShortfallStreak * 5} min`], ["Hot-water floor", f0(this.d.dhwFloorF)]] },
    ), () => (this.noHeat.heard ? "record" : "page"));
  }

  /**
   * The outage feed has been silent for hours (generator.ts silence), so the supply is a guess until it answers. An email,
   * not a page: nothing is wrong with the house, but a dead feed is otherwise visible only in /health. Goes out once per
   * silence, like the pages, and its all-clear is record-only (alertpolicy.ts route).
   */
  outageFeed(silent: { hours: number; why: string; failure: string | null } | null): void {
    if (!silent) {
      this.feed.cleared((heard) => this.d.send("Outage feed answering again", "The planner can tell the grid from the generator again.", "default", { tier: "attention", resolved: true, key: "outage-feed-silent", heard }));
      return;
    }
    const failure = silent.failure ?? "no answer yet";
    this.feed.holding((tier) => this.d.send(
      "Outage feed silent",
      `The planner has not heard from 6bb's outage feed for ~${silent.hours.toFixed(1)} h (${failure}). Until it answers, the planner cannot see a grid outage: ${silent.why}.`,
      "default",
      { tier, key: "outage-feed-silent",
        action: "Check that 6bb is running, and that OUTAGE_FEED_KEY there matches the key in the planner's OUTAGEWATCH_URL.",
        facts: [["Silent for", `${silent.hours.toFixed(1)} h`], ["Last failure", failure]] },
    ), () => "attention");
  }

  /**
   * The element's power alarm has had no reading from SPAN for an hour (spanwatch.ts blindness). An alarm that can't read
   * can't say so, and #257 proved it: it ran blind with nothing but /health to show it. An email, not a page: the element's
   * breaker is kept OPEN, so nothing is drawing. The element can't be seen until this clears.
   */
  elementAlarm(blind: { minutes: number; error: string | null } | null): void {
    if (!blind) {
      this.elementWatch.cleared((heard) => this.d.send("Element alarm reading again", "SPAN's reading of the backup element is back, so the alarm can see it again.", "default", { tier: "attention", resolved: true, key: "element-alarm-blind", heard }));
      return;
    }
    const error = (blind.error ?? "no reading yet").slice(0, 200);
    this.elementWatch.holding((tier) => this.d.send(
      "Element alarm blind",
      `The alarm that watches the backup element has had no reading from SPAN for ~${blind.minutes} min (${error}). If the element ran now, nothing would page.`,
      "default",
      { tier, key: "element-alarm-blind",
        action: "Until this clears, nothing warns you if the element runs. If SPAN's own app is working, the fault is on the planner's side: ask a Claude session to look.",
        facts: [["No reading for", `${blind.minutes} min`], ["Last error", error]] },
    ), () => "attention");
  }

  /**
   * R02 keeps coming back (owner's decision, 2026-11-04). R02 is "Drive 1 compressor abnormal start (phase loss /
   * reverse)", register 2112 bit 8; on HP1 it sets and clears itself in 1–3 min, but the manual says it needs service.
   * The owner chose to watch it: R02_DAILY_COUNT or more occurrences on one pump within one local day is one ATTENTION
   * email for that pump that day, sent again until a channel acknowledges it, and never again that day however many
   * more there are. Nothing switches. No all-clear email: the day rolling over is a record-only "cleared" that releases
   * the latch, so the next day that reaches the count emails again (alertpolicy.ts route). Only R02 is counted (index.ts
   * asks store.faultEdges for that code alone), so P17 anti-freeze or any other code can never reach this.
   *
   * `edges` are the mirror's fault_on/fault_off rows for R02 over R02_HISTORY_DAYS (store.faultEdges): the bridge's
   * own edge detector, so a code held across polls is one row and one occurrence (faultOccurrences), and a 1–3 min R02
   * the 5-min hub poll would miss still counts. null = the read failed: can't judge, so nothing moves this cycle. The
   * local day because the owner's word was "today", the mirror's timestamps make it one filter, and a rolling 24 h would
   * let one bad evening email twice (its evening and the next morning).
   */
  r02Recurring(edges: FaultEdge[] | null, nowS: number, nameOf: (id: string) => string): void {
    if (!edges) return;
    const dayStartS = etDayStart(etDay(nowS));
    const all = faultOccurrences(edges);
    for (const id of new Set([...Object.keys(all), ...this.r02.keys()])) {
      const occ = all[id] ?? [];
      const today = occ.filter((o) => o.ts >= dayStartS);
      let w = this.r02.get(id);
      if (!w) this.r02.set(id, w = { edge: new PageEdge(`r02-recurring:${id}`, this.queue), today: [], days30: 0 });
      w.today = today; w.days30 = occ.length;
      const key = `r02-recurring:${id}`;
      const name = nameOf(id);
      if (today.length < R02_DAILY_COUNT) {
        // a new day (or a quiet one): record-only by policy, and it releases the latch for the next day's email
        w.edge.cleared((heard) => this.d.send(`${name}: R02 count reset for the day`, `A new day: ${name}'s R02 count starts from zero.`, "default",
          { tier: "attention", resolved: true, key, heard }));
        continue;
      }
      const n = today.length;
      const list = today.map((o, i) => `${hhmm(o.ts)} (${clearedWords(o, i === n - 1)})`);
      const stillSet = today[n - 1].clearedAfterS == null;
      w.edge.holding((tier) => this.d.send(
        `${name}: R02 ${n} times today`,
        `${name} has shown fault R02 (compressor abnormal start: phase loss or reverse rotation) ${n} times today: ${list.join(", ")}. ` +
          (stillSet ? "The latest one is still set. " : "Each one cleared itself. ") +
          `${occ.length} in the last ${R02_HISTORY_DAYS} days. Nothing has been switched: the manual says R02 needs service, so this is a note to book it.`,
        "default",
        { tier, key,
          action: `Book a service visit for ${name}: the manual says R02 needs service.`,
          facts: [["Pump", name], ["R02 today", `${n}`], ["Times", list.join(" · ")],
                  ["Self-cleared", stillSet ? "not yet (the latest is still set)" : "yes, every one"],
                  [`Last ${R02_HISTORY_DAYS} days`, `${occ.length}`]] },
      ), () => "attention");
    }
  }

  /** /health.pump_health.r02: today's R02 count per pump, when, whether the email reached someone, and the 30-day count. */
  r02Status(): Record<string, { today: number; times_et: string[]; emailed: boolean; days_30: number }> {
    return Object.fromEntries([...this.r02].map(([id, w]) => [id, {
      today: w.today.length, times_et: w.today.map((o, i) => `${hhmm(o.ts)} ${clearedWords(o, i === w.today.length - 1)}`), emailed: w.edge.heard, days_30: w.days30,
    }]));
  }

  /** Freeze-risk advisory (owner ask 2026-07-16): deep cold AND a low buffer at the same time. The HBX
   *  P17 anti-freeze is the hard device-side backstop; this is planner visibility so the owner knows to
   *  confirm the HPs are keeping up + the element breaker is on. Rare (design-cold only). */
  async freezeRisk(reading: SlxReading): Promise<void> {
    const { outdoorF, tankF } = reading;
    if (outdoorF == null || tankF == null) return;
    if (outdoorF <= FREEZE_OUTDOOR_F && tankF < FREEZE_TANK_F) {
      this.freeze.holding(() => this.d.send(
        "⚠ Freeze-risk advisory",
        `Outdoor ${outdoorF.toFixed(0)}°F with the buffer only ${tankF.toFixed(0)}°F. The HBX P17 anti-freeze is the hard backstop, but confirm the HPs are keeping up and the SPAN breaker is on for the element.`,
        "urgent",
        { tier: "page", key: "freeze-risk", // house-threatening, intervene now
          action: "Make sure both heat pumps are running and the backup element breaker is ON at the SPAN panel.",
          facts: [["Outdoor", f0(outdoorF)], ["Tank", f0(tankF)]] },
      ));
    } else {
      this.freeze.cleared((heard) => this.d.send("Freeze-risk cleared", `Outdoor ${outdoorF.toFixed(0)}°F / buffer ${tankF.toFixed(0)}°F — back in range.`, "default", { tier: "page", resolved: true, key: "freeze-risk", heard }));
    }
  }

  /** The Pi going quiet (#122 Wave 2). `connected` is index.ts's cached hub read, null before the first one. */
  async piLink(connected: boolean | null, outdoorF: number | null): Promise<void> {
    if (connected === null) return;      // no reading yet this process; say nothing
    if (!connected) {
      this.piDisconnectedSince ??= Date.now();
      const downS = Math.round((Date.now() - this.piDisconnectedSince) / 1000);
      if (downS >= PI_QUIET_ALERT_S && !this.piQuietAlerted) {
        this.piQuietAlerted = true;
        this.queue.add(() => this.d.send("Pi disconnected", `The bridge has been disconnected for ~${Math.round(downS / 60)} min.`, "high", { tier: "record" }));
      }
      // THE "Pi unreachable" incident (hub dead-man, SPAN-local stale and I8-blind are its record-only symptoms). The
      // pumps hold their lease-reverted setpoints and the HBX keeps running its curve without the Pi, so this is a
      // page only after hours — sooner when it is freezing out (piUnreachablePageAfterS). Once due it stays due: a thaw
      // must not put a page nobody heard back to sleep until the 12 h mark.
      this.piPageDue ||= downS >= piUnreachablePageAfterS(outdoorF);
      if (!this.piPageDue) return;
      this.pi.holding(() => this.d.send(
        "Pi unreachable",
        `The heat-pump bridge (Pi) has not reported for ~${(downS / 3600).toFixed(1)} h` +
          (outdoorF != null ? ` with ${Math.round(outdoorF)}°F outside` : "") + `. The pumps hold their ` +
          `lease-reverted setpoints and the HBX keeps heating on its own curve, but A2W cannot see or optimize the plant. ` +
          `Check the Pi's power and the house internet/WiFi (the Pi is 6bb-a2w-control at 192.168.184.197).`,
        "high",
        { tier: "page", key: "pi-unreachable",
          action: "Check the Pi (6bb-a2w-control) has power, and that the house internet and WiFi are up. Unplugging and replugging the Pi is safe.",
          facts: [["Silent for", `${(downS / 3600).toFixed(1)} h`], ["Outdoor", f0(outdoorF)]] },
      ));
      return;
    }
    if (this.pi.owesAllClear) {
      this.pi.cleared((heard) => this.d.send("Pi reconnected", "The bridge is pushing state again.", "default", { tier: "page", resolved: true, key: "pi-unreachable", heard }));
    } else if (this.piQuietAlerted) {
      this.queue.add(() => this.d.send("Pi reconnected", "The bridge is pushing state again.", "default", { tier: "record", resolved: true }));
    }
    this.piDisconnectedSince = null; this.piQuietAlerted = false; this.piPageDue = false;
  }
}
