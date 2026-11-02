/**
 * @purpose Assertions for the SPAN backup-element alarm (spanwatch.ts). The cloud field it reads is SPAN's
 * DAY-cumulative kWh (#207), so the alarm must page on energy drawn in the trailing 60 minutes, never on the
 * day's running total: a total that climbs by less than the threshold within any hour never pages (the old
 * `dayKwh > threshold` compare would have); one that jumps by more pages once; the page clears in the next hour
 * without the element; the local-midnight counter reset neither pages nor clears on its own; a restart's first
 * sample is only a baseline; and the pump path still stores the RAW day-cumulative value. The GraphQL layer and
 * the clock are scripted by overriding SpanWatch.gql / SpanWatch.now — no Cognito, no network.
 * #124: the value is normalized by SPAN's unit (Wh / kWh, any case) and a 16.5 kW run pages in both; an unknown or
 * missing unit is never guessed — the alarm path is blind (no page, no clear), logged once.
 * Run with: npx tsx planner/src/spanwatch.test.ts
 */
import assert from "node:assert/strict";
import { BACKUP_BLIND, BACKUP_WINDOW_MS, SpanWatch, energyKwh } from "./spanwatch";
import type { Store } from "./store";

const ALARM_KWH = 0.3;
const ELEMENT_KWH_PER_MIN = 16.5 / 60; // 0.275 — one minute of the resistive element

/** A SpanWatch whose GraphQL answers come from `reading` and whose clock is `nowMs`. */
class FakeSpan extends SpanWatch {
  nowMs: number;
  reading = { backup: 0, pumps: 0 };
  /** #124: the unit SPAN reports — `value` is published in it (kWh × 1000 for Wh); anything else is sent as-is */
  unit: string | undefined = "KILO_WATT_HOUR"; // what SPAN really sends
  readonly pages: { title: string; body: string; priority?: string; tier?: string; resolved?: boolean }[] = [];
  readonly upserts: { hour: string; kwh: number }[] = [];
  constructor(startIso: string) {
    const pages: FakeSpan["pages"] = [];
    const upserts: FakeSpan["upserts"] = [];
    const store = { upsertSpanEnergyHour: async (hour: Date, kwh: number) => { upserts.push({ hour: hour.toISOString(), kwh }); } } as unknown as Store;
    super("user", "pass", "buffer tank", ALARM_KWH, async (title, body, priority, opts) => { pages.push({ title, body, priority, tier: opts.tier, resolved: !!opts.resolved }); }, "bld-1", store, "air-water");
    this.nowMs = Date.parse(startIso);
    // the field initializers above ran after super(); point them at the arrays the callbacks captured
    (this as { pages: FakeSpan["pages"] }).pages = pages;
    (this as { upserts: FakeSpan["upserts"] }).upserts = upserts;
  }
  protected override now(): Date { return new Date(this.nowMs); }
  protected override async gql(_query: string, _variables: Record<string, unknown>): Promise<any> {
    const m = (kwh: number) => ({ value: /^(wh|watt_hour)$/i.test(this.unit ?? "") ? kwh * 1000 : kwh, unit: this.unit });
    return { data: { building: { buildingId: "bld-1", multiPanels: [{ panelId: "p1", spaces: [
      { spaceId: "s1", name: "Buffer Tank", state: "CLOSED", currentHour: m(this.reading.backup) },
      { spaceId: "s2", name: "Air-Water 1", state: "CLOSED", currentHour: m(this.reading.pumps / 2) },
      { spaceId: "s3", name: "Air-Water 2", state: "CLOSED", currentHour: m(this.reading.pumps / 2) },
    ] }] } } };
  }
  /** advance the clock `minutes`, publish the day-cumulative readings, poll once */
  async poll(minutes: number, backupToday: number, pumpsToday = 0): Promise<void> {
    this.nowMs += minutes * 60_000;
    this.reading = { backup: backupToday, pumps: pumpsToday };
    await this.tick();
  }
  get iso(): string { return new Date(this.nowMs).toISOString(); }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

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

    // readable again: differenced against the last readable poll — the energy drawn while blind is not lost
    w.unit = "kWh";
    await w.poll(1, 2.0);
    assert.equal(w.lastError, null);
    assert.equal(w.failStreak, 0);
    assert.equal(w.pages.length, 1, "the run that happened while blind pages once the reading is readable");
    assert.equal(r2(w.lastHourKwh!), 1.95);

    // blind while alarmed: no clear either
    w.unit = "";
    for (let m = 0; m < 90; m++) await w.poll(1, 2.0);
    assert.equal(w.alarmed, true, "a blind spell never clears the page");
    assert.equal(w.pages.length, 1);
  } finally {
    console.warn = warn;
  }
}

console.log("spanwatch.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
