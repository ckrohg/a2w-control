/**
 * @purpose Assertions for the SPAN backup-element alarm (spanwatch.ts). The cloud field it reads is SPAN's
 * DAY-cumulative kWh (#207), so the alarm must page on energy drawn in the trailing 60 minutes, never on the
 * day's running total: a total that climbs by less than the threshold within any hour never pages (the old
 * `dayKwh > threshold` compare would have); one that jumps by more pages once; the page clears in the next hour
 * without the element; the local-midnight counter reset neither pages nor clears on its own; a restart's first
 * sample is only a baseline; and the pump path still stores the RAW day-cumulative value. The GraphQL layer and
 * the clock are scripted by overriding SpanWatch.gql / SpanWatch.now — no Cognito, no network.
 * #124: the value is normalized by SPAN's unit (Wh / kWh, any case) and a 16.5 kW run pages in both; an unknown or
 * missing unit is never guessed — the alarm path is blind (no page, no clear), logged once. #257 review: energy that
 * arrives across a blind spell LONGER than the alarm window is not stamped on the last 60 min — it is reported apart
 * (lastBlindSpell, one email if it is an element run) and the day total stays SPAN's own counter.
 * evaluateHourEnergy (pure) / SpanWatch.applyHourEnergy: a 300 Wh step sits EXACTLY on the 0.3 kWh threshold and
 * does not page while 301 Wh does; several circuits matching SPAN_BACKUP_CIRCUIT → one warning and the last wins (as
 * before); the pump sum across two Air-Water circuits in mixed units reaches span_energy as kWh and an unreadable
 * pump circuit is left out of it; the no-match path is unchanged.
 * Run with: npx tsx planner/src/spanwatch.test.ts
 */
import assert from "node:assert/strict";
import { BACKUP_BLIND, BACKUP_WINDOW_MS, SpanWatch, energyKwh, evaluateHourEnergy, type SpanPanel, type SpanSpace } from "./spanwatch";
import type { Store } from "./store";

const ALARM_KWH = 0.3;
const ELEMENT_KWH_PER_MIN = 16.5 / 60; // 0.275 — one minute of the resistive element

/** A SpanWatch whose GraphQL answers come from `reading` (or, when set, the scripted `spaces`) and whose clock is `nowMs`. */
class FakeSpan extends SpanWatch {
  nowMs: number;
  reading = { backup: 0, pumps: 0 };
  /** #124: the unit SPAN reports — `value` is published in it (kWh × 1000 for Wh); anything else is sent as-is */
  unit: string | undefined = "KILO_WATT_HOUR"; // what SPAN really sends
  /** when set, every GraphQL call throws it — the catch path (SPAN's cloud down, a timeout) */
  fail: string | null = null;
  /** when set, gql answers with exactly these spaces (any value/unit) instead of `reading` */
  spaces: SpanSpace[] | null = null;
  readonly pages: { title: string; body: string; priority?: string; tier?: string; resolved?: boolean }[] = [];
  readonly upserts: { hour: string; kwh: number }[] = [];
  constructor(startIso: string, o: { circuit?: string; pumps?: string; store?: boolean } = {}) {
    const pages: FakeSpan["pages"] = [];
    const upserts: FakeSpan["upserts"] = [];
    const store = o.store === false ? undefined : ({ upsertSpanEnergyHour: async (hour: Date, kwh: number) => { upserts.push({ hour: hour.toISOString(), kwh }); } } as unknown as Store);
    super("user", "pass", o.circuit ?? "buffer tank", ALARM_KWH, async (title, body, priority, opts) => { pages.push({ title, body, priority, tier: opts.tier, resolved: !!opts.resolved }); }, "bld-1", store, o.pumps ?? "air-water");
    this.nowMs = Date.parse(startIso);
    // the field initializers above ran after super(); point them at the arrays the callbacks captured
    (this as { pages: FakeSpan["pages"] }).pages = pages;
    (this as { upserts: FakeSpan["upserts"] }).upserts = upserts;
  }
  protected override now(): Date { return new Date(this.nowMs); }
  protected override async gql(_query: string, _variables: Record<string, unknown>): Promise<any> {
    if (this.fail) throw new Error(this.fail);
    const m = (kwh: number) => ({ value: /^(wh|watt_hour)$/i.test(this.unit ?? "") ? kwh * 1000 : kwh, unit: this.unit });
    const spaces: SpanSpace[] = this.spaces ?? [
      { spaceId: "s1", name: "Buffer Tank", state: "CLOSED", currentHour: m(this.reading.backup) },
      { spaceId: "s2", name: "Air-Water 1", state: "CLOSED", currentHour: m(this.reading.pumps / 2) },
      { spaceId: "s3", name: "Air-Water 2", state: "CLOSED", currentHour: m(this.reading.pumps / 2) },
    ];
    return { data: { building: { buildingId: "bld-1", multiPanels: [{ panelId: "p1", spaces }] } } };
  }
  /** advance the clock `minutes`, publish the day-cumulative readings, poll once */
  async poll(minutes: number, backupToday: number, pumpsToday = 0): Promise<void> {
    this.nowMs += minutes * 60_000;
    this.reading = { backup: backupToday, pumps: pumpsToday };
    await this.tick();
  }
  /** advance the clock `minutes`, publish exactly these spaces (value + unit as SPAN would send them), poll once */
  async pollSpaces(minutes: number, ...spaces: SpanSpace[]): Promise<void> {
    this.nowMs += minutes * 60_000;
    this.spaces = spaces;
    await this.tick();
  }
  get iso(): string { return new Date(this.nowMs).toISOString(); }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const near = (a: number | null, b: number, msg?: string) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ≈${b}, got ${a}`);
const space = (name: string, value: unknown, unit: unknown): SpanSpace => ({ spaceId: name.toLowerCase().replace(/\W+/g, "-"), name, state: "CLOSED", currentHour: { value, unit } });
const panel = (...spaces: SpanSpace[]): SpanPanel[] => [{ panelId: "nj-2312-003t6", spaces }];
/** run `fn` with console.warn captured and console.log silenced; returns the captured warnings */
async function withWarns(fn: (warns: string[]) => Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  const origWarn = console.warn, origLog = console.log;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  console.log = () => {};
  try { await fn(warns); } finally { console.warn = origWarn; console.log = origLog; }
  return warns;
}

(async () => {

// ── 1. a running total that climbs by LESS than the threshold within any hour never pages ─────────────────────────
// 0.004 kWh/min of standby for three hours: today's total reaches 0.72 kWh (the old compare paged at 0.3) while no
// 60-minute window ever holds more than 0.24.
{
  const w = new FakeSpan("2026-10-19T23:30:00Z"); // 19:30 ET
  let total = 0;
  await w.poll(0, total);
  for (let m = 1; m <= 180; m++) { total = r3(total + 0.004); await w.poll(1, total); }
  assert.equal(w.pages.length, 0, "a slow climb below the threshold per hour must not page");
  assert.equal(w.lastDayKwh, 0.72, "the raw day total is still reported");
  assert.ok(w.lastDayKwh! > ALARM_KWH, "…and it is above the threshold the OLD code compared it to");
  assert.equal(r2(w.lastHourKwh!), 0.24, "the trailing hour holds 60 × 0.004");
  assert.equal(w.alarmed, false);
}
// ── 2. the element runs: one HIGH page within two polls; no repeat while it keeps running ─────────────────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z");
  await w.poll(0, 0.05);
  await w.poll(1, 0.05);
  assert.equal(w.pages.length, 0, "a flat total never pages");
  await w.poll(1, r2(0.05 + ELEMENT_KWH_PER_MIN)); // 0.33 today, +0.28 in one minute
  assert.equal(w.pages.length, 0, "0.28 kWh in the window is not yet > 0.3");
  await w.poll(1, r2(0.05 + 2 * ELEMENT_KWH_PER_MIN)); // 0.6 today, 0.55 in the window
  assert.equal(w.pages.length, 1, "the second minute of element draw pages");
  assert.equal(w.pages[0].priority, "high");
  assert.equal(w.pages[0].tier, "attention", "an element draw costs money but never endangers the house: email, no phone");
  assert.equal(w.pages[0].title, "16.5 kW backup element DREW POWER");
  assert.match(w.pages[0].body, /drew 0\.55 kWh in the last 60 min \(0\.60 kWh so far today/);
  assert.equal(w.alarmed, true);
  for (let m = 0; m < 30; m++) await w.poll(1, r2(w.lastDayKwh! + ELEMENT_KWH_PER_MIN)); // keeps running half an hour
  assert.equal(w.pages.length, 1, "edge-triggered: no repeat while the element keeps running");
  assert.ok(w.lastHourKwh! > 8, `the trailing hour reflects the draw (${w.lastHourKwh})`);
  assert.ok(Math.abs(w.lastDayKwh! - (0.6 + 30 * ELEMENT_KWH_PER_MIN)) < 0.2, `the raw day total is reported (${w.lastDayKwh}; r2 rounds each step up)`);
}
// ── 3. the element stops: the page clears within the next hour, once ──────────────────────────────────────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z");
  await w.poll(0, 0);
  await w.poll(1, 0.4); // 0.4 kWh in one minute — the element ran
  assert.equal(w.pages.length, 1);
  const stoppedAt = w.nowMs;
  let clearedAfterMin: number | null = null;
  for (let m = 1; m <= 90 && clearedAfterMin === null; m++) {
    await w.poll(1, 0.4); // flat: the element is off
    if (w.pages.length === 2) clearedAfterMin = (w.nowMs - stoppedAt) / 60_000;
  }
  assert.equal(w.pages.length, 2, "the page clears");
  assert.equal(w.pages[1].title, "Backup element power cleared");
  assert.equal(w.pages[1].priority, "default", "the clear is a default-priority notice");
  assert.equal(w.pages[1].resolved, true, "and an all-clear: record-only, since the alarm was attention tier");
  assert.match(w.pages[1].body, /drew 0\.00 kWh in the last 60 min \(0\.40 kWh so far today\)/);
  assert.equal(clearedAfterMin, BACKUP_WINDOW_MS / 60_000, "exactly when the draw leaves the 60-minute window");
  assert.equal(w.alarmed, false);
  for (let m = 0; m < 30; m++) await w.poll(1, 0.4);
  assert.equal(w.pages.length, 2, "no repeat of the clear");
}
// ── 4. local midnight: the counter drops to 0 — no page, no clear on its own; the window carries the draw across ────
// 2026-10-20T03:50Z is 23:50 ET; SPAN's calendar day rolls over at 04:00Z.
{
  const w = new FakeSpan("2026-10-20T03:50:00Z");
  await w.poll(0, 1.5);           // 23:50 ET — 1.5 kWh earlier today, element off
  await w.poll(1, 1.5);
  await w.poll(1, 1.9);           // 23:52 — +0.4 in a minute: the element ran
  assert.equal(w.pages.length, 1, "pages before midnight");
  await w.poll(1, 2.25);          // 23:53 — +0.35, then it stops
  for (let m = 54; m <= 59; m++) await w.poll(1, 2.25);
  assert.equal(w.iso, "2026-10-20T03:59:00.000Z");
  await w.poll(1, 0.0);           // 00:00 ET — SPAN's DAY window rolled over
  assert.equal(w.lastDayKwh, 0, "the new day's total");
  assert.equal(w.pages.length, 1, "the reset is neither a page nor a clear");
  assert.equal(w.alarmed, true, "the 23:52–23:53 draw is still inside the trailing hour");
  assert.equal(r2(w.lastHourKwh!), 0.75, "the window kept the pre-midnight increments");
  let clearedAt: string | null = null;
  for (let m = 1; m <= 70 && clearedAt === null; m++) { await w.poll(1, 0.0); if (w.pages.length === 2) clearedAt = w.iso; }
  assert.equal(clearedAt, "2026-10-20T04:53:00.000Z", "clears an hour after the last increment, across the day boundary");
  // and a draw that starts right after midnight pages normally — nothing is stuck to the day total
  await w.poll(1, r2(ELEMENT_KWH_PER_MIN));
  await w.poll(1, r2(2 * ELEMENT_KWH_PER_MIN));
  assert.equal(w.pages.length, 3, "a post-midnight draw pages again");
  assert.equal(w.pages[2].priority, "high");
}
// ── 5. a restart mid-day: the first sample is a baseline, however large today's total already is ──────────────────
{
  const w = new FakeSpan("2026-10-19T20:00:00Z");
  await w.poll(0, 12.3); // the element ran this morning; the old code paged here on every restart
  assert.equal(w.pages.length, 0, "no page on the first sample");
  assert.equal(w.lastHourKwh, 0);
  assert.equal(w.lastDayKwh, 12.3);
  await w.poll(1, 12.3);
  assert.equal(w.pages.length, 0);
  await w.poll(1, 12.7);
  assert.equal(w.pages.length, 1, "…and a real increment after it pages");
}
// ── 6. the pump path is untouched: the RAW day-cumulative sum goes to span_energy on every poll (#207) ─────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z");
  await w.poll(0, 0, 10.0);
  await w.poll(1, 0, 10.5);
  await w.poll(29, 0, 11.2);
  await w.poll(1, 0, 11.2);  // 00:01Z — the next hour
  assert.deepEqual(w.upserts.map((u) => u.kwh), [10.0, 10.5, 11.2, 11.2], "raw running totals, never differenced");
  assert.deepEqual(w.upserts.map((u) => u.hour), [
    "2026-10-19T23:30:00.000Z", "2026-10-19T23:31:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-20T00:01:00.000Z",
  ], "stamped with the poll's clock; the store truncates to the hour and keeps the max");
  assert.equal(w.pages.length, 0, "pump energy never touches the alarm");
}
// ── 7. #124 units: SPAN's value is normalized by the unit it reports. A 16.5 kW element run trips in Wh and in kWh ─────
{
  // the pure conversion, case-insensitive
  assert.deepEqual(energyKwh({ value: 2750, unit: "Wh" }), { kwh: 2.75 });
  assert.deepEqual(energyKwh({ value: 2750, unit: "WH" }), { kwh: 2.75 });
  assert.deepEqual(energyKwh({ value: 2.75, unit: "kWh" }), { kwh: 2.75 });
  assert.deepEqual(energyKwh({ value: 2.75, unit: "KILO_WATT_HOUR" }), { kwh: 2.75 }, "the live spelling");
  assert.deepEqual(energyKwh({ value: 2750, unit: "WATT_HOUR" }), { kwh: 2.75 });
  assert.deepEqual(energyKwh({ value: "2.75", unit: " KWH " }), { kwh: 2.75 });
  assert.ok("error" in energyKwh({ value: 2.75, unit: "MWh" }));
  assert.ok("error" in energyKwh({ value: 2.75 }), "a missing unit is not kWh");
  assert.ok("error" in energyKwh({ value: null, unit: "kWh" }), "a missing value is not 0");

  for (const unit of ["Wh", "wh", "kWh", "kwh"]) {
    const w = new FakeSpan("2026-10-19T23:30:00Z");
    w.unit = unit;
    await w.poll(0, 0.05, 4.0);
    await w.poll(1, 0.05, 4.0);
    for (let m = 1; m <= 2; m++) await w.poll(1, r3(0.05 + m * ELEMENT_KWH_PER_MIN), 4.0); // the element runs 2 min
    assert.equal(w.pages.length, 1, `${unit}: the element run pages`);
    assert.equal(w.pages[0].title, "16.5 kW backup element DREW POWER");
    assert.match(w.pages[0].body, /drew 0\.55 kWh in the last 60 min \(0\.60 kWh so far today/, `${unit}: reported in kWh`);
    assert.equal(r3(w.lastDayKwh!), 0.6, `${unit}: the day total is in kWh`);
    assert.equal(w.lastError, null);
    assert.deepEqual(w.upserts.map((u) => r3(u.kwh)), [4, 4, 4, 4], `${unit}: the pump path is in kWh too`);
  }
  // Wh read as kWh would have paged on standby: 4 Wh/min is 0.004 kWh/min — the slow climb of case 1 never pages
  {
    const w = new FakeSpan("2026-10-19T23:30:00Z");
    w.unit = "Wh";
    let total = 0;
    await w.poll(0, total);
    for (let m = 1; m <= 90; m++) { total = r3(total + 0.004); await w.poll(1, total); }
    assert.equal(w.pages.length, 0, "Wh standby is not a kWh element run");
  }
}
// ── 8. #124 unknown or missing unit: no guess — the alarm path is blind (lastError, failStreak), logged once ───────────
{
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const w = new FakeSpan("2026-10-19T23:30:00Z");
    await w.poll(0, 0.05);
    await w.poll(1, 0.05);
    w.unit = "MWh"; // a unit we do not know: the element run below must NOT page off a guessed scale
    for (let m = 1; m <= 5; m++) await w.poll(1, r3(0.05 + m * ELEMENT_KWH_PER_MIN));
    assert.equal(w.pages.length, 0, "an unknown unit never pages");
    assert.equal(w.alarmed, false);
    assert.equal(w.failStreak, 5, "every blind poll counts, like a failed read");
    assert.ok(w.lastError?.startsWith(BACKUP_BLIND), w.lastError ?? "");
    assert.match(w.lastError!, /circuit "Buffer Tank": energy unit "MWh" is not Wh or kWh/);
    assert.equal(w.lastDayKwh, 0.05, "the last READABLE day total stays");
    const backupWarns = warned.filter((x) => x.includes(BACKUP_BLIND));
    assert.equal(backupWarns.length, 1, `logged once, not every poll: ${backupWarns.join(" | ")}`);
    assert.equal(warned.filter((x) => x.includes('pump circuit "Air-Water 1"')).length, 1, "the pump circuits are logged once each too");

    w.unit = undefined; // missing: a different reason, logged once
    await w.poll(1, 2.0);
    await w.poll(1, 2.0);
    assert.match(w.lastError!, /energy unit missing/);
    assert.equal(warned.filter((x) => x.includes(BACKUP_BLIND)).length, 2);
    assert.equal(w.pages.length, 0);

    // readable again: differenced against the last readable poll — the energy drawn while blind is not lost. This blind
    // spell was 8 min, inside the 60-min window, so the energy DID arrive within the last hour and is attributed to it;
    // a spell longer than the window is case 10's.
    w.unit = "kWh";
    await w.poll(1, 2.0);
    assert.equal(w.lastError, null);
    assert.equal(w.failStreak, 0);
    assert.equal(w.pages.length, 1, "the run that happened during a SHORT blind spell pages once the reading is readable");
    assert.equal(r2(w.lastHourKwh!), 1.95);
    assert.equal(w.lastBlindSpell, null, "an 8-min spell is not a blind spell the window cannot place");

    // blind while alarmed: no clear either
    w.unit = "";
    for (let m = 0; m < 90; m++) await w.poll(1, 2.0);
    assert.equal(w.alarmed, true, "a blind spell never clears the page");
    assert.equal(w.pages.length, 1);
  } finally {
    console.warn = warn;
  }
}

// ── the alarm says when it can't read: timed from the last good reading, so brief cloud errors stay quiet ──────
{
  const w = new FakeSpan("2026-11-02T18:00:00Z");
  assert.equal(w.blindness(), null, "the first look starts the clock");
  w.nowMs += 59 * 60_000;
  assert.equal(w.blindness(), null, "59 min with no poll yet");
  w.nowMs += 60_000;
  assert.deepEqual(w.blindness(), { minutes: 60, error: null }, "never read since the start: it counts from there");
  await w.poll(0, 0);
  assert.equal(w.blindness(), null, "a good reading clears it");
  w.unit = "PARSECS"; // what #257 did: every poll answers, none can be read
  for (let m = 0; m < 59; m++) await w.poll(1, 0);
  assert.equal(w.blindness(), null, "59 min blind: still quiet");
  await w.poll(1, 0);
  const b = w.blindness()!;
  assert.equal(b.minutes, 60);
  assert.match(b.error!, /PARSECS/, "it says why");
  assert.equal(w.failStreak, 60);
  w.unit = "KILO_WATT_HOUR";
  await w.poll(1, 0);
  assert.equal(w.blindness(), null, "readable again");
  // a poll that hangs never bumps failStreak, so the clock can't depend on it
  w.nowMs += 61 * 60_000;
  assert.equal(w.failStreak, 0);
  assert.equal(w.blindness()!.minutes, 61, "no poll came back at all");
  // SPAN's brief errors: one bad poll in many never adds up
  const q = new FakeSpan("2026-11-02T18:00:00Z");
  await q.poll(0, 0);
  for (let m = 0; m < 180; m++) {
    q.unit = m % 10 === 9 ? undefined : "KILO_WATT_HOUR";
    await q.poll(1, 0);
    assert.equal(q.blindness(), null, "an occasional failure resets on the next good poll");
  }
}

// ── 10. #257 finding 4: a blind spell LONGER than the window — the gap's energy is not "in the last 60 min" ──────────
// The element ran 30 min at the start of a 2-h unreadable spell and stopped. Before the fix the whole 8.25 kWh was
// stamped at the first readable poll and paged as "drew 8.25 kWh in the last 60 min", hours after the run ended.
{
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const w = new FakeSpan("2026-11-03T06:00:00Z"); // 01:00 ET, far from SPAN's midnight
    await w.poll(0, 0.5);
    await w.poll(1, 0.5);
    w.unit = "MWh"; // unreadable from here: the reading keeps climbing while the element runs, then goes flat
    let total = 0.5;
    for (let m = 1; m <= 30; m++) { total = r3(total + ELEMENT_KWH_PER_MIN); await w.poll(1, total); }
    for (let m = 31; m <= 120; m++) await w.poll(1, total);
    assert.equal(w.pages.length, 0, "blind: nothing pages");
    assert.equal(w.blindness()!.minutes, 120, "the owner heard about the blind spell itself (#276)");
    w.unit = "KILO_WATT_HOUR";
    await w.poll(1, total); // 121 min after the last good reading
    assert.equal(w.lastError, null);
    assert.equal(w.alarmed, false, "a run that ended 90 min ago is not a run in the last 60 min");
    assert.equal(w.lastHourKwh, 0, "the gap's energy is kept out of the rolling window");
    assert.equal(r3(w.lastDayKwh!), r3(0.5 + 30 * ELEMENT_KWH_PER_MIN), "the day total is SPAN's own counter: nothing lost");
    assert.equal(r2(w.lastBlindSpell!.kwh), 8.25, "the gap's energy is reported apart, as the blind spell's");
    assert.equal(w.lastBlindSpell!.minutes, 121);
    assert.equal(w.lastBlindSpell!.from, "2026-11-03T06:01:00.000Z");
    assert.equal(w.lastBlindSpell!.to, "2026-11-03T08:02:00.000Z");
    assert.equal(w.pages.length, 1, "an element run inside the spell is still told — once, apart from the trailing-hour alarm");
    assert.equal(w.pages[0].title, "16.5 kW backup element drew power while the alarm was blind");
    assert.equal(w.pages[0].priority, "default");
    assert.equal(w.pages[0].tier, "attention", "same tier as the element alarm: email, no phone");
    assert.equal(w.pages[0].resolved, false);
    assert.match(w.pages[0].body, /drew 8\.25 kWh between 06:01Z and 08:02Z \(121 min with no reading\)/);
    assert.match(w.pages[0].body, /8\.75 kWh so far today/);
    assert.doesNotMatch(w.pages[0].body, /in the last 60 min/, "never claims the energy is recent");
    assert.equal(warned.filter((x) => /drew 8\.25 kWh between 06:01Z and 08:02Z/.test(x)).length, 1, "logged once");
    // the hour after: no clear is owed (nothing was alarmed) and nothing pages off the old energy
    for (let m = 0; m < 70; m++) await w.poll(1, total);
    assert.equal(w.pages.length, 1);
    assert.equal(w.alarmed, false);
    assert.equal(w.lastHourKwh, 0);
    // a real run after the spell pages normally, with the day total intact
    await w.poll(1, r3(total + ELEMENT_KWH_PER_MIN));
    await w.poll(1, r3(total + 2 * ELEMENT_KWH_PER_MIN));
    assert.equal(w.pages.length, 2, "a run NOW pages as before");
    assert.equal(w.pages[1].title, "16.5 kW backup element DREW POWER");
    assert.match(w.pages[1].body, /drew 0\.55 kWh in the last 60 min \(9\.30 kWh so far today/);
    assert.equal(w.alarmed, true);
  } finally {
    console.warn = warn;
  }
  // the catch path behaves the same: SPAN's cloud down for 3 h, the element ran 10 min somewhere in it
  {
    const w = new FakeSpan("2026-11-03T06:00:00Z");
    await w.poll(0, 1.0);
    w.fail = "SPAN GraphQL 502: bad gateway";
    for (let m = 1; m <= 180; m++) await w.poll(1, 1.0);
    assert.equal(w.failStreak, 180);
    w.fail = null;
    const total = r3(1.0 + 10 * ELEMENT_KWH_PER_MIN); // 3.75: ten minutes of element, sometime in those 3 h
    await w.poll(1, total);
    assert.equal(w.pages.length, 1);
    assert.equal(w.pages[0].title, "16.5 kW backup element drew power while the alarm was blind");
    assert.equal(w.alarmed, false, "not 'in the last 60 min'");
    assert.equal(w.lastHourKwh, 0);
    assert.equal(r2(w.lastBlindSpell!.kwh), 2.75);
    assert.equal(w.lastBlindSpell!.minutes, 181);
    assert.equal(w.lastDayKwh, total, "the day total is right");
    assert.equal(w.failStreak, 0);
  }
  // below the threshold the spell's energy is only recorded (standby, or a short element blip): no email, not in the hour
  {
    const w = new FakeSpan("2026-11-03T06:00:00Z");
    await w.poll(0, 1.0);
    w.fail = "timeout";
    for (let m = 1; m <= 90; m++) await w.poll(1, 1.0);
    w.fail = null;
    await w.poll(1, 1.2);
    assert.equal(w.pages.length, 0, "0.2 kWh over 91 min is not an element run");
    assert.equal(w.lastHourKwh, 0);
    assert.equal(r2(w.lastBlindSpell!.kwh), 0.2);
    assert.equal(w.lastDayKwh, 1.2);
  }
  // a blind spell shorter than the window is attributed as before (case 8): the energy did arrive within the last hour
  {
    const w = new FakeSpan("2026-11-03T06:00:00Z");
    await w.poll(0, 1.0);
    w.fail = "timeout";
    for (let m = 1; m <= 59; m++) await w.poll(1, 1.0);
    w.fail = null;
    await w.poll(1, 1.5); // 60 min since the last good reading: not longer than the window
    assert.equal(w.pages.length, 1);
    assert.equal(w.pages[0].title, "16.5 kW backup element DREW POWER");
    assert.equal(r2(w.lastHourKwh!), 0.5);
    assert.equal(w.lastBlindSpell, null);
  }
}

// ═══ #124: the decision is split from the fetch — evaluateHourEnergy (pure) feeds SpanWatch.applyHourEnergy ═══════════

// ── 11. evaluateHourEnergy: Wh on the backup circuit, pumps summed across two Air-Water circuits in mixed units ─────
{
  const r = evaluateHourEnergy(panel(
    space("Backup Element", 450, "WH"),
    space("Air-Water 1", 1200, "WH"),
    space("Air-Water 2", 0.8, "KWH"),
    space("Kitchen", 2000, "WH"),
  ), "backup", "air-water");
  assert.equal(r.hit?.name, "Backup Element");
  assert.deepEqual(r.hit?.e, { kwh: 0.45 }, "backup Wh → kWh");
  assert.equal(r.hit?.raw, "450 WH", "what SPAN sent, verbatim, for the OK log");
  near(r.pumpKwh, 2.0, "1200 Wh + 0.8 kWh");
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.names, ["Backup Element", "Air-Water 1", "Air-Water 2", "Kitchen"]);
  // kWh pass-through, matches case-insensitive, no pumpMatch → pumpKwh 0
  const k = evaluateHourEnergy(panel(space("BACKUP", 0.31, "kWh"), space("AIR-WATER 1", 3, "kWh")), "Backup", undefined);
  assert.deepEqual(k.hit?.e, { kwh: 0.31 });
  assert.equal(k.pumpKwh, 0, "no pumpMatch configured → 0, as before");
  assert.equal(evaluateHourEnergy(panel(space("BACKUP", 0.31, "kWh"), space("AIR-WATER 1", 3, "kWh")), "Backup", "Air-Water").pumpKwh, 3);
}
// ── 12. unknown / missing unit on the backup circuit → the error, not a guess; panels spanning two objects ───────────
{
  const r = evaluateHourEnergy([
    { panelId: "a", spaces: [space("Air-Water 1", 100, "WH")] },
    { panelId: "b", spaces: [space("Backup Element", 450, "J")] },
  ], "backup", "air-water");
  assert.deepEqual(r.hit?.e, { error: 'energy unit "J" is not Wh or kWh' });
  assert.equal(r.hit?.raw, "450 J");
  assert.equal(r.pumpKwh, 0.1, "pumps still accumulate when only the backup unit is bad");
  assert.deepEqual(r.warnings, []);
  const missing = evaluateHourEnergy(panel({ name: "Backup Element", currentHour: null }), "backup");
  assert.ok(missing.hit && "error" in missing.hit.e, "currentHour null → unreadable");
  assert.equal(missing.hit?.raw, "? ?");
}
// ── 13. several circuits match → one warning naming them all, LAST wins (today's behaviour, now visible) ─────────────
{
  const r = evaluateHourEnergy(panel(space("Backup Element", 0.1, "KWH"), space("Backup Pump", 0.9, "KWH")), "backup");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /2 circuits match "backup"/);
  assert.match(r.warnings[0], /"Backup Element", "Backup Pump"/);
  assert.match(r.warnings[0], /using the last, "Backup Pump"/);
  assert.equal(r.hit?.name, "Backup Pump");
  assert.deepEqual(r.hit?.e, { kwh: 0.9 });
}
// ── 14. an unreadable PUMP circuit is left out of the sum and named; the backup decision is unaffected ───────────────
{
  const r = evaluateHourEnergy(panel(space("Backup Element", 0, "KWH"), space("Air-Water 1", 1, "KWH"), space("Air-Water 2", 7, "BTU")), "backup", "air-water");
  assert.equal(r.pumpKwh, 1, "the readable circuit counts; nothing is added under a guessed unit");
  assert.deepEqual(r.warnings, ['pump circuit "Air-Water 2": energy unit "BTU" is not Wh or kWh — left out of span_energy']);
  assert.deepEqual(r.hit?.e, { kwh: 0 });
}
// ── 15. no match → hit null, every name listed; empty / malformed input is harmless ─────────────────────────────────
{
  const r = evaluateHourEnergy(panel(space("Kitchen", 1, "KWH"), space("Garage", 2, "KWH")), "backup", "air-water");
  assert.equal(r.hit, null);
  assert.deepEqual(r.names, ["Kitchen", "Garage"]);
  assert.equal(r.pumpKwh, 0);
  assert.deepEqual(evaluateHourEnergy(undefined, "backup"), { hit: null, pumpKwh: 0, warnings: [], names: [] });
  assert.deepEqual(evaluateHourEnergy([{ panelId: "x", spaces: null }], "backup").hit, null);
}
// ── 16. Wh from SPAN: a 300 Wh step is NOT > 0.3 kWh; a 301 Wh step pages HIGH once; the clear is in kWh ────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z", { circuit: "backup" });
  await withWarns(async () => {
    await w.pollSpaces(0, space("Backup Element", 0, "WH"), space("Air-Water 1", 400, "WH")); // baseline
    await w.pollSpaces(1, space("Backup Element", 300, "WH"), space("Air-Water 1", 500, "WH"));
    assert.deepEqual(w.pages, [], "0.3 kWh in the window is not > 0.3 kWh — the env threshold keeps its kWh meaning");
    assert.equal(w.lastHourKwh, 0.3, "exactly 0.3: Wh divided, not multiplied by 0.001");
    assert.equal(w.lastDayKwh, 0.3);
    assert.equal(w.lastError, null);
    assert.equal(w.failStreak, 0);
    assert.ok(w.lastOkAt);
    await w.pollSpaces(1, space("Backup Element", 301, "WH"), space("Air-Water 1", 600, "WH"));
    await w.pollSpaces(1, space("Backup Element", 950, "WH"), space("Air-Water 1", 700, "WH"));
    assert.equal(w.pages.length, 1, "pages once, not every poll");
    assert.equal(w.pages[0].priority, "high");
    assert.match(w.pages[0].title, /16.5 kW backup element DREW POWER/);
    assert.match(w.pages[0].body, /drew 0\.30 kWh in the last 60 min \(0\.30 kWh so far today/, "the page text is in kWh, not Wh");
    near(w.lastDayKwh, 0.95);
    near(w.lastHourKwh, 0.95);
    await w.pollSpaces(61, space("Backup Element", 950, "WH"), space("Air-Water 1", 0, "WH")); // the draw leaves the window
    assert.equal(w.pages.length, 2);
    assert.match(w.pages[1].title, /cleared/);
    assert.match(w.pages[1].body, /drew 0\.00 kWh in the last 60 min \(0\.95 kWh so far today\)/);
    assert.equal(w.pages[1].priority, "default");
    assert.deepEqual(w.upserts.map((u) => u.kwh), [0.4, 0.5, 0.6, 0.7, 0], "span_energy receives the pump sum in kWh");
  });
}
// ── 17. several matches: warned once across ticks, the last match drives the alarm ───────────────────────────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z", { circuit: "backup" });
  const warns = await withWarns(async () => {
    await w.pollSpaces(0, space("Backup Element", 0, "KWH"), space("Backup Pump", 0, "KWH"));
    await w.pollSpaces(1, space("Backup Element", 0, "KWH"), space("Backup Pump", 0.9, "KWH"));
    await w.pollSpaces(1, space("Backup Element", 0, "KWH"), space("Backup Pump", 0.9, "KWH"));
  });
  const multi = warns.filter((m) => /2 circuits match "backup"/.test(m));
  assert.equal(multi.length, 1, "warned once");
  assert.match(multi[0], /tighten SPAN_BACKUP_CIRCUIT/);
  assert.equal(w.pages.length, 1, "the last match (0.9 kWh step) paged");
  assert.match(w.pages[0].body, /"Backup Pump"/);
}
// ── 18. pump sum across two Air-Water circuits in mixed units reaches the store as kWh; an unreadable one is left out ─
{
  const w = new FakeSpan("2026-10-19T23:30:00Z", { circuit: "backup" });
  const warns = await withWarns(async () => {
    await w.pollSpaces(0, space("Backup Element", 0, "KWH"), space("Air-Water 1", 1200, "WH"), space("Air-Water 2", 0.8, "KWH"));
    assert.equal(w.upserts.length, 1);
    near(w.upserts[0].kwh, 2.0, "1.2 + 0.8");
    await w.pollSpaces(1, space("Backup Element", 0, "KWH"), space("Air-Water 1", 1, "KWH"), space("Air-Water 2", 7, "BTU"));
    await w.pollSpaces(1, space("Backup Element", 0, "KWH"), space("Air-Water 1", 1, "KWH"), space("Air-Water 2", 7, "BTU"));
    assert.deepEqual(w.upserts.slice(1).map((u) => u.kwh), [1, 1], "the readable circuit is stored; the BTU one is never added under a guessed unit");
    assert.equal(w.lastError, null, "the backup decision is unaffected by a pump unit problem");
    assert.deepEqual(w.pages, []);
  });
  assert.equal(warns.filter((m) => /pump circuit "Air-Water 2".*left out of span_energy/.test(m)).length, 1, "logged once, not every tick");
  const noStore = new FakeSpan("2026-10-19T23:30:00Z", { circuit: "backup", store: false });
  await withWarns(async () => {
    await noStore.pollSpaces(0, space("Backup Element", 0, "KWH"), space("Air-Water 1", 1, "KWH"));
  });
  assert.deepEqual(noStore.upserts, [], "no store configured → nothing to write");
}
// ── 19. no-match path unchanged: lastError lists the circuits, failStreak up, no page, pumps still stored ────────────
{
  const w = new FakeSpan("2026-10-19T23:30:00Z", { circuit: "backup" });
  const warns = await withWarns(async () => {
    await w.pollSpaces(0, space("Kitchen", 1, "KWH"), space("Air-Water 1", 0.4, "KWH"));
  });
  assert.equal(w.lastError, 'no circuit matching "backup" — available: Kitchen | Air-Water 1');
  assert.equal(w.failStreak, 1);
  assert.equal(w.lastHourKwh, null);
  assert.deepEqual(w.pages, []);
  assert.deepEqual(w.upserts.map((u) => u.kwh), [0.4], "pump accumulation does not depend on the backup match");
  assert.equal(warns.filter((m) => /no circuit matching/.test(m)).length, 1);
}

console.log("spanwatch.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
