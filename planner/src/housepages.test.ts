/**
 * @purpose The four house pages survive a delivery failure (housepages.ts): a page nobody heard goes out again while the
 * condition holds, a condition that clears first owes no all-clear, and an all-clear nobody heard goes out again too.
 */
import assert from "node:assert/strict";
import { HousePages } from "./housepages";
import { Latches, acknowledged, type LatchStore, type Tier } from "./alertpolicy";
import type { HubState } from "./hub";
import type { SlxReading } from "./store";

let now = Date.parse("2027-01-15T08:00:00Z");
Date.now = () => now;
const CYCLE = 5 * 60_000;

type Note = { title: string; body: string; tier: Tier; resolved: boolean; key?: string; facts?: [string, string][] };

function rig() {
  /** the 6bb push and the email; ntfy.sh always answers 200 here, as it does for a topic nobody subscribes to */
  const channels = { up: true, refuse: (_key?: string) => false, hung: null as Promise<void> | null, latchWriteFails: false, throws: false };
  const rows = new Map<string, { tier: string; notifiedAt: Date }>();
  const latchStore: LatchStore = {
    getNotifyLatch: async (k) => rows.get(k) ?? null,
    upsertNotifyLatch: async (k, tier) => { if (channels.latchWriteFails) throw new Error("db blip"); rows.set(k, { tier, notifiedAt: new Date(now) }); },
    deleteNotifyLatch: async (k) => { const r = rows.get(k); rows.delete(k); return r ? { tier: r.tier } : null; },
  };
  const latches = new Latches(latchStore, () => {});
  const heard: Note[] = [];    // reached the owner
  const tried: Note[] = [];    // went to an owner channel, heard or not
  const logged: Note[] = [];   // record tier: nobody's phone
  // the order of index.ts ntfyDelivered: which tier applies, the channels, then the latch for a page someone heard
  const send = async (title: string, body: string, _p: string, o: any): Promise<boolean> => {
    let tier: Tier = o.tier;
    if (o.key && o.resolved) tier = (await latches.release(o.key, o.tier, o.heard)) ?? "record";
    else if (o.key && o.tier !== "record" && !(await latches.due(o.key))) tier = "record";
    const note: Note = { title, body, tier, resolved: !!o.resolved, key: o.key, facts: o.facts };
    if (tier === "record") { logged.push(note); return true; }
    tried.push(note);
    await channels.hung;
    if (channels.throws) throw new Error("send blew up");
    if (!acknowledged({ ownerConfigured: true, ownerAcked: channels.up && !channels.refuse(o.key), ntfyConfigured: true, ntfyAcked: true })) return false;
    heard.push(note);
    if (o.key && !o.resolved) await latches.record(o.key, tier);
    return true;
  };
  const episodes = { opened: 0, closed: 0 };
  const store = {
    openUnservedEpisode: async () => { episodes.opened++; },
    closeUnservedEpisode: async () => { episodes.closed++; },
  } as any;
  const fresh = () => new HousePages({ send, store, stageMap: { 1: "pump1", 2: "pump2" }, dhwFloorF: 116 });
  let pages = fresh();
  const slx = (o: Partial<SlxReading> = {}) => ({ tankF: 118, tankTargetF: 125, outdoorF: 30, stagesCalled: [true, false], ...o }) as SlxReading;
  const hub = (state = "idle") => ({
    pi_connected: true, ts: now / 1000,
    pumps: [{ id: "pump1", name: "Heat Pump 1", online: true, state }, { id: "pump2", name: "Heat Pump 2", online: true, state: "idle" }],
  }) as unknown as HubState;
  // one poll, then everything it asked for has gone out; the "hung channel" block below is the case where it hasn't
  const cycles = async (n: number, f: () => Promise<void>) => { for (let i = 0; i < n; i++) { now += CYCLE; await f(); await pages.settled(); } };
  return {
    get pages() { return pages; }, redeploy: () => { pages = fresh(); }, heard, tried, logged, channels, rows, episodes, slx, hub, cycles,
    // one poll, in pollOnce's order (unserved before DHW)
    noPumpRunning: (n = 1, tankF = 118) => cycles(n, async () => { await pages.unservedCall(slx({ tankF }), hub(), true); await pages.dhwShortfall(slx({ tankF })); }),
    callEnded: (n = 1) => cycles(n, () => pages.unservedCall(slx({ stagesCalled: [false, false] }), null, false)),
    pumpRunning: (n = 1) => cycles(n, () => pages.unservedCall(slx(), hub("heating"), true)),
    tankCold: (n = 1) => cycles(n, () => pages.dhwShortfall(slx({ tankF: 108 }))),
    tankBack: (n = 1) => cycles(n, () => pages.dhwShortfall(slx({ tankF: 118 }))),
    freezing: (n = 1) => cycles(n, () => pages.freezeRisk(slx({ outdoorF: 2, tankF: 100 }))),
    backInRange: (n = 1) => cycles(n, () => pages.freezeRisk(slx({ outdoorF: 20, tankF: 118 }))),
    piDown: (n = 1, outdoorF = 20) => cycles(n, () => pages.piLink(false, outdoorF)),
    piBack: (n = 1) => cycles(n, () => pages.piLink(true, 20)),
  };
}
type Rig = ReturnType<typeof rig>;
const titled = (notes: Note[], re: RegExp) => notes.filter((n) => re.test(n.title));
const allClears = (r: Rig) => r.heard.filter((n) => n.resolved);
const NO_HEAT_POLLS = 9, DHW_POLLS = 12, PI_PAGE_CYCLES = 25; // 2 h below 32 °F: the first read only starts the clock

let finished = false;
process.on("exit", () => { if (!finished) { console.error("housepages.test.ts: stopped early, a test awaited a send that never finished"); process.exitCode = 1; } });

(async () => {
  // ── "no heat" ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    // fails on every channel: sent again each cycle with that cycle's numbers until someone hears it, then never again
    const r = rig();
    r.channels.up = false;
    await r.noPumpRunning(NO_HEAT_POLLS - 1);
    assert.equal(r.tried.length, 0, "not before 45 min");
    await r.noPumpRunning();
    assert.equal(r.tried.length, 1);
    await r.noPumpRunning(2);
    assert.equal(r.tried.length, 3, "sent again every cycle");
    assert.deepEqual(r.pages.allIdle(), { alerted: true, heard: false, streak: 11 }, "/health tells an open page from a heard one");
    assert.equal(r.heard.length, 0);
    assert.equal(r.rows.has("no-heat"), false, "unheard: no latch");
    r.channels.up = true;
    await r.noPumpRunning();
    assert.equal(titled(r.heard, /NO pump/).length, 1);
    assert.match(r.heard[0].body, /~60 min/, "this cycle's numbers, not the first attempt's");
    assert.ok(r.heard[0].facts?.some(([k, v]) => k === "No heat for" && v === "60 min"));
    assert.equal(r.rows.get("no-heat")?.tier, "page");
    await r.noPumpRunning(3);
    assert.equal(titled(r.tried, /NO pump/).length, 4, "heard: never sent again");
    assert.equal(r.episodes.opened, 1, "one incident, one episode row, however many sends it took");
    await r.callEnded();
    assert.equal(r.episodes.closed, 1);
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].key, "no-heat");
    assert.equal(allClears(r)[0].tier, "page");
    await r.callEnded(2);
    assert.equal(allClears(r).length, 1, "once");
  }
  {
    // heat came back before anyone heard: no all-clear, but the episode still closes, on either clear path
    for (const clears of ["callEnded", "pumpRunning"] as const) {
      const r = rig();
      r.channels.up = false;
      await r.noPumpRunning(NO_HEAT_POLLS + 1);
      const attempts = r.tried.length;
      r.channels.up = true;
      await r[clears]();
      assert.equal(r.tried.length, attempts, `${clears}: no all-clear for a page never received`);
      assert.equal(r.episodes.closed, 1, `${clears}: the episode closes anyway`);
      assert.equal(r.logged.length, 0, `${clears}: not even a record line, nothing was sent`);
      assert.equal(r.pages.allIdle().alerted, false);
      // and a later incident starts over: its own 45 min, its own episode
      await r.noPumpRunning(NO_HEAT_POLLS - 1);
      assert.equal(r.heard.length, 0);
      await r.noPumpRunning();
      assert.equal(titled(r.heard, /NO pump/).length, 1);
      assert.equal(r.episodes.opened, 2);
    }
  }
  {
    // a person switched the pump off: the condition no longer holds, so the retries stop
    const r = rig();
    r.channels.up = false;
    await r.noPumpRunning(NO_HEAT_POLLS);
    const stopped = r.hub();
    Object.assign(stopped.pumps[0], { online: false, state: "offline", deliberate_stop: { circuit: "Air-Water 1", since: now / 1000 } });
    const attempts = r.tried.length;
    await r.cycles(2, () => r.pages.unservedCall(r.slx(), stopped, true));
    assert.equal(r.tried.length, attempts, "a pump a person switched off is not a page");
  }
  {
    // a hub read that failed can't judge: nothing sent, nothing cleared
    const r = rig();
    r.channels.up = false;
    await r.noPumpRunning(NO_HEAT_POLLS);
    const attempts = r.tried.length;
    await r.cycles(1, () => r.pages.unservedCall(r.slx(), null, true));
    assert.equal(r.tried.length, attempts);
    assert.equal(r.pages.allIdle().alerted, true);
  }
  {
    // the all-clear fails: sent again each cycle until heard, with the second clear path's words if that is what holds
    const r = rig();
    await r.noPumpRunning(NO_HEAT_POLLS);
    r.channels.up = false;
    await r.callEnded(2);
    assert.equal(titled(r.tried, /cleared/).length, 2, "sent again");
    assert.equal(r.episodes.closed, 1, "the episode closes once");
    r.channels.up = true;
    await r.pumpRunning();
    assert.equal(allClears(r).length, 1);
    assert.match(allClears(r)[0].body, /running against the call/);
    assert.equal(allClears(r)[0].tier, "page", "at the page's tier, with its latch long gone");
    await r.callEnded(2);
    assert.equal(titled(r.tried, /cleared/).length, 3, "heard: once");
  }

  // ── tank cold ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    r.channels.up = false;
    await r.tankCold(DHW_POLLS - 1);
    assert.equal(r.tried.length, 0, "not before 60 min");
    await r.tankCold(3);
    assert.equal(r.tried.length, 3, "sent again every cycle");
    r.channels.up = true;
    await r.tankCold();
    assert.equal(r.heard.length, 1);
    assert.match(r.heard[0].body, /~75 min/, "this cycle's numbers");
    await r.tankCold(2);
    assert.equal(r.tried.length, 4, "heard: never sent again");
    await r.tankBack();
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].key, "dhw-shortfall");
  }
  {
    const r = rig();
    r.channels.up = false;
    await r.tankCold(DHW_POLLS + 1);
    r.channels.up = true;
    await r.tankBack(2);
    assert.equal(r.heard.length, 0, "no all-clear for a page never received");
    assert.equal(r.logged.length, 0);
  }
  {
    const r = rig();
    await r.tankCold(DHW_POLLS);
    r.channels.up = false;
    await r.tankBack(2);
    r.channels.up = true;
    await r.tankBack(2);
    assert.equal(allClears(r).length, 1, "a failed all-clear goes out again, once heard never again");
    assert.equal(allClears(r)[0].tier, "page");
  }

  // ── tank cold while "no heat" is open: one incident, one page ──────────────────────────────────────────────────
  {
    // "no heat" heard: the cold tank is its symptom
    const r = rig();
    await r.noPumpRunning(DHW_POLLS, 108);
    assert.equal(titled(r.tried, /DHW/).length, 0, "no second page");
    assert.equal(titled(r.logged, /DHW/).length, 1, "the record line, once");
    await r.noPumpRunning(2, 108);
    assert.equal(titled(r.logged, /DHW/).length, 1);
    await r.tankBack();
    assert.equal(allClears(r).length, 0, "and no all-clear for a page that never went out");
  }
  {
    // "no heat" heard by nobody: it does NOT silence the cold tank. Before, the flag read "open" and neither was heard
    const r = rig();
    r.channels.up = false;
    await r.noPumpRunning(DHW_POLLS, 108);
    assert.equal(titled(r.tried, /DHW/).length, 1, "tried at page tier: nothing else has reached the owner");
    assert.equal(titled(r.logged, /DHW/).length, 0);
    // channels back: "no heat" goes first in the poll, so the owner gets the one page
    r.channels.up = true;
    await r.noPumpRunning(1, 108);
    assert.equal(titled(r.heard, /NO pump/).length, 1);
    assert.equal(titled(r.heard, /DHW/).length, 0, "one incident, one page");
    assert.equal(titled(r.logged, /DHW/).length, 1, "the unheard page became the record line");
  }
  {
    // "no heat" still can't get through but the cold-tank page can: hear it, then hear the incident
    const r = rig();
    r.channels.refuse = (key) => key === "no-heat";
    await r.noPumpRunning(DHW_POLLS, 108);
    assert.equal(titled(r.heard, /DHW/).length, 1);
    assert.equal(titled(r.heard, /DHW/)[0].tier, "page");
    r.channels.refuse = () => false;
    await r.noPumpRunning(1, 108);
    assert.equal(titled(r.heard, /NO pump/).length, 1);
  }
  {
    // the switch reads the page, not the leftover state: with "no heat" over and its all-clear still failing, a tank
    // that goes cold is its own incident
    const r = rig();
    await r.noPumpRunning(NO_HEAT_POLLS);
    r.channels.up = false;
    await r.callEnded();
    r.channels.up = true;
    r.channels.refuse = (key) => key === "no-heat";
    await r.tankCold(DHW_POLLS);
    assert.equal(titled(r.heard, /DHW/).length, 1);
  }

  // ── freeze risk ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    r.channels.up = false;
    await r.freezing(3);
    assert.equal(r.tried.length, 3, "sent again every cycle");
    r.channels.up = true;
    await r.cycles(1, () => r.pages.freezeRisk(r.slx({ outdoorF: 1, tankF: 99 })));
    assert.equal(r.heard.length, 1);
    assert.match(r.heard[0].body, /Outdoor 1°F with the buffer only 99°F/, "this cycle's numbers");
    await r.freezing(2);
    assert.equal(r.tried.length, 4, "heard: never sent again");
    await r.backInRange();
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].key, "freeze-risk");
  }
  {
    const r = rig();
    r.channels.up = false;
    await r.freezing(2);
    r.channels.up = true;
    await r.backInRange(2);
    assert.equal(r.heard.length, 0, "no all-clear for a page never received");
  }
  {
    const r = rig();
    await r.freezing();
    r.channels.up = false;
    await r.backInRange(2);
    assert.equal(r.heard.length, 1, "the phone still shows it");
    assert.equal(r.rows.has("freeze-risk"), false, "no latch left to swallow the next page");
    r.channels.up = true;
    await r.backInRange(2);
    assert.equal(allClears(r).length, 1, "a failed all-clear goes out again, once heard never again");
    assert.equal(allClears(r)[0].tier, "page");
  }
  {
    // it comes back while the all-clear is failing: that is a page again, which replaces the old alert
    const r = rig();
    await r.freezing();
    r.channels.up = false;
    await r.backInRange();
    r.channels.up = true;
    await r.freezing(2);
    assert.equal(titled(r.heard, /Freeze-risk advisory/).length, 2);
    await r.backInRange(2);
    assert.equal(allClears(r).length, 1);
  }
  {
    // ...and if that page fails too, the phone still shows the first one, so the all-clear stays owed
    const r = rig();
    await r.freezing();
    r.channels.up = false;
    await r.backInRange();
    await r.freezing();
    await r.backInRange();
    r.channels.up = true;
    await r.backInRange();
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].tier, "page");
  }
  {
    // no outdoor or tank reading can't judge: neither side runs
    const r = rig();
    r.channels.up = false;
    await r.freezing();
    await r.cycles(1, () => r.pages.freezeRisk(r.slx({ outdoorF: null })));
    assert.equal(r.tried.length, 1);
  }

  // ── Pi unreachable ───────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    r.channels.up = false;
    await r.piDown(PI_PAGE_CYCLES - 1);
    assert.equal(r.tried.length, 0, "not before 2 h");
    assert.equal(titled(r.logged, /Pi disconnected/).length, 1, "the record line at 10 min, once");
    await r.piDown(3);
    assert.equal(r.tried.length, 3, "sent again every cycle");
    r.channels.up = true;
    await r.piDown();
    assert.equal(r.heard.length, 1);
    assert.match(r.heard[0].body, /~2\.3 h/, "this cycle's numbers");
    await r.piDown(2);
    assert.equal(r.tried.length, 4, "heard: never sent again");
    await r.piBack();
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].key, "pi-unreachable");
    assert.equal(allClears(r)[0].tier, "page");
    await r.piBack(2);
    assert.equal(allClears(r).length, 1, "once");
  }
  {
    // back before anyone heard: the record line of the 10-min alert, no all-clear
    const r = rig();
    r.channels.up = false;
    await r.piDown(PI_PAGE_CYCLES + 1);
    const attempts = r.tried.length;
    r.channels.up = true;
    await r.piBack(2);
    assert.equal(r.tried.length, attempts, "no all-clear for a page never received");
    assert.equal(titled(r.logged, /Pi reconnected/).length, 1);
    assert.equal(titled(r.logged, /Pi reconnected/)[0].key, undefined, "not the page's all-clear");
  }
  {
    // a short dropout never pages and never leaves anything owed
    const r = rig();
    await r.piDown(4);
    await r.piBack(2);
    assert.equal(r.tried.length, 0);
    assert.equal(titled(r.logged, /Pi reconnected/).length, 1);
  }
  {
    // the all-clear fails: sent again though the 10-min edge has reset, and never doubled by the record line
    const r = rig();
    await r.piDown(PI_PAGE_CYCLES);
    r.channels.up = false;
    await r.piBack(2);
    assert.equal(titled(r.tried, /Pi reconnected/).length, 2, "sent again");
    assert.equal(titled(r.logged, /Pi reconnected/).length, 0);
    r.channels.up = true;
    await r.piBack(2);
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].tier, "page");
  }

  // ── a heard page whose latch write failed: the owner still gets the all-clear ─────────────────────────────────────
  {
    const r = rig();
    r.channels.latchWriteFails = true;
    await r.freezing();
    assert.equal(r.heard.length, 1);
    assert.equal(r.rows.has("freeze-risk"), false, "the DB blip: no latch");
    r.channels.latchWriteFails = false;
    await r.backInRange();
    assert.equal(allClears(r).length, 1, "the page was heard, so the all-clear is due without a latch");
    assert.equal(allClears(r)[0].tier, "page");
  }

  // ── a thaw doesn't put a page nobody heard back to sleep ──────────────────────────────────────────────────────
  {
    const r = rig();
    r.channels.up = false;
    await r.piDown(PI_PAGE_CYCLES, 25);
    assert.equal(r.tried.length, 1, "due at 2 h, it is 25 °F");
    await r.piDown(2, 33);
    assert.equal(r.tried.length, 3, "still sent every cycle above 32 °F");
    r.channels.up = true;
    await r.piDown(1, 33);
    assert.equal(r.heard.length, 1);
    await r.piBack();
    // and the next outage starts over, at that outage's threshold
    await r.piDown(PI_PAGE_CYCLES, 33);
    assert.equal(titled(r.tried, /Pi unreachable/).length, 4, "above 32 °F a new outage waits for 12 h");
  }

  // ── a channel that hangs never holds the poll ─────────────────────────────────────────────────────────────────
  const prompt = async (what: string, p: Promise<unknown>) => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} waited on a send`)), 500); });
    await Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  const hang = (r: Rig) => { let release = () => {}; r.channels.hung = new Promise<void>((res) => { release = res; }); return () => { r.channels.hung = null; release(); }; };
  {
    const r = rig();
    await r.noPumpRunning(NO_HEAT_POLLS - 1, 118);
    await r.piDown(PI_PAGE_CYCLES - 1, 2);                                    // the next read makes the Pi page due
    const free = hang(r);
    const s = r.slx({ tankF: 100, outdoorF: 2 });
    for (let i = 0; i < 16; i++) {
      now += CYCLE;
      await prompt("no heat", r.pages.unservedCall(s, r.hub(), true));
      await prompt("tank cold", r.pages.dhwShortfall(s));
      await prompt("freeze risk", r.pages.freezeRisk(s));
      await prompt("Pi unreachable", r.pages.piLink(false, 2));
    }
    assert.equal(r.tried.length, 1, "one send on the wire, the rest wait in line");
    free();
    await r.pages.settled();
    assert.equal(titled(r.heard, /NO pump/).length, 1, "one page, not one per cycle it waited");
    assert.match(titled(r.heard, /NO pump/)[0].body, /~45 min/, "the send on the wire keeps its numbers");
    assert.equal(titled(r.heard, /Freeze-risk/).length, 1);
    assert.equal(titled(r.heard, /Pi unreachable/).length, 1);
    assert.equal(titled(r.logged, /DHW/).length, 1, "behind \"no heat\" in line, so it saw that page heard: one incident, one page");
    assert.equal(titled(r.heard, /DHW/).length, 0);
    assert.equal(titled(r.logged, /NO pump|Freeze-risk/).length, 0, "nothing queued behind a heard page went out as a re-fire");
  }
  {
    // the page still in line takes the newest cycle's numbers
    const r = rig();
    await r.tankCold(DHW_POLLS - 1);
    const free = hang(r);
    await prompt("tank cold", r.pages.dhwShortfall(r.slx({ tankF: 108 })));   // on the wire
    for (const [outdoorF, tankF] of [[2, 100], [4, 101], [1, 99]]) await prompt("freeze risk", r.pages.freezeRisk(r.slx({ outdoorF, tankF })));
    free();
    await r.pages.settled();
    assert.equal(titled(r.tried, /advisory/).length, 1, "three cycles in line, one send");
    assert.match(titled(r.heard, /advisory/)[0].body, /Outdoor 1°F with the buffer only 99°F/);
  }
  {
    // it clears while its page is on the wire: nothing else goes out until the next cycle, which owes the all-clear
    const r = rig();
    const free = hang(r);
    await prompt("freeze risk", r.pages.freezeRisk(r.slx({ outdoorF: 2, tankF: 100 })));
    await prompt("freeze risk", r.pages.freezeRisk(r.slx({ outdoorF: 20, tankF: 118 })));
    free();
    await r.pages.settled();
    assert.equal(r.heard.length, 1);
    assert.equal(allClears(r).length, 0);
    await r.backInRange();
    assert.equal(allClears(r).length, 1);
  }
  {
    // it comes back while the all-clear is on the wire: the next cycle pages again
    const r = rig();
    await r.freezing();
    const free = hang(r);
    await prompt("freeze risk", r.pages.freezeRisk(r.slx({ outdoorF: 20, tankF: 118 })));
    await prompt("freeze risk", r.pages.freezeRisk(r.slx({ outdoorF: 2, tankF: 100 })));
    free();
    await r.pages.settled();
    assert.equal(allClears(r).length, 1);
    await r.freezing();
    assert.equal(titled(r.heard, /advisory/).length, 2);
  }

  {
    // a send that throws costs that attempt, not the queue, and never reaches the poll
    const r = rig();
    r.channels.throws = true;
    await r.freezing();
    await r.piDown();
    r.channels.throws = false;
    await r.freezing();
    assert.equal(titled(r.heard, /advisory/).length, 1, "the next cycle's send still runs");
  }

  // ── what #251 and the latch already gave: unchanged ───────────────────────────────────────────────────────────
  {
    // a redeploy's re-fire of a heard page is suppressed, reads as heard, and its all-clear still goes
    const r = rig();
    await r.freezing();
    r.redeploy();
    await r.freezing(2);
    assert.equal(r.tried.length, 1, "no re-page");
    assert.equal(r.heard.length, 1);
    assert.equal(titled(r.logged, /Freeze-risk advisory/).length, 1, "the suppressed re-fire, once");
    await r.backInRange();
    assert.equal(allClears(r).length, 1);
    assert.equal(allClears(r)[0].tier, "page");
  }
  {
    // a redeploy while a page is unheard loses nothing: no latch, so it fires again when the condition has held again
    const r = rig();
    r.channels.up = false;
    await r.freezing();
    r.redeploy();
    r.channels.up = true;
    await r.freezing();
    assert.equal(r.heard.length, 1);
  }

  // ── the outage feed's silence: one email, not a page; an email nobody got goes again ──────────
  {
    const r = rig();
    const silent = { hours: 2.1, why: "the outage feed has not answered for 126 min; assuming the grid", failure: "it refused the planner's key (HTTP 401)" };
    r.channels.up = false;
    await r.cycles(2, async () => r.pages.outageFeed(silent));
    assert.equal(r.heard.length, 0);
    assert.equal(r.tried.length, 2, "nobody got it: it goes out again");
    r.channels.up = true;
    await r.cycles(3, async () => r.pages.outageFeed({ ...silent, hours: 2.6 }));
    assert.equal(r.heard.length, 1, "once per silence");
    const n = r.heard[0];
    assert.equal(n.tier, "attention", "an email: nothing is wrong with the house");
    assert.equal(n.key, "outage-feed-silent");
    assert.match(n.body, /refused the planner's key/);
    assert.match(n.body, /~2\.6 h/, "the newest numbers");
    await r.cycles(2, async () => r.pages.outageFeed(null));
    const clears = () => [...r.heard, ...r.logged].filter((l) => l.resolved && l.key === "outage-feed-silent");
    assert.equal(clears().length, 1, "one all-clear");
    assert.equal(clears()[0].tier, "attention", "route() keeps an attention all-clear off every channel");
    assert.equal(r.rows.has("outage-feed-silent"), false, "the latch is released, so the next silence emails again");
    await r.cycles(2, async () => r.pages.outageFeed(null));
    assert.equal(clears().length, 1, "a quiet feed sends nothing");
  }

  finished = true;
  console.log("housepages.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
