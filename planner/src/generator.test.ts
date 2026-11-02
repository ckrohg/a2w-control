/**
 * @purpose Assertions for generator-aware outage mode (#241, generator.ts + the backup gate's `generator` input). The
 * replays run the REAL Oct 15–16 incident (HP2 E21 lead, 14.2 h with no heat; on the grid the gate would-closes at
 * 13:35 ET) with an outage laid over it. The house loads are measured, not guessed:
 *   - base 1.2 kW: the SPAN panel's own whole-house `power-flows/site` on 2026-10-29 (span-v2 capture, pumps idle);
 *   - both pump circuits drew ~8 W through the incident window (span_readings), so the base is the whole house;
 *   - a pump heating: p50 5.1 kW, p95 6.1 kW (span_readings Jul 31 – Oct 29, n = 17.7k). With today's lagT 60 the HBX
 *     would have added HP1 an hour into that call, so "normal load on the generator" = 1.2 + 5.1 kW.
 * Pins the owner's rule of 2026-11-02 on the 20 kW generator: the element NEVER closes automatically on the generator
 * or an unknown supply, whatever the budget and comfort say (they are still reported, and `shed` still works); the grid
 * and an assumed grid are unchanged.
 * Run with: npx tsx planner/src/generator.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BackupGate, type GateEvent, type GatePump } from "./backupgate";
import { StageWatch, DEFAULT_STAGE_PUMP_MAP } from "./stagewatch";
import { DEFAULT_COMFORT_EXCLUDE, GEN, OutageFeed, ZoneAges, assess, comfortRisk, genEpisodeKind, houseLoadW, parseComfortExclude, parseGenConfig, piBudgetCheck, shedNotice, type Comfort, type Supply, type ZoneTemp } from "./generator";
import { episodeTier } from "./alertpolicy";

const BASE_W = 1_211;  // SPAN power-flows/site, 2026-10-29
const PUMP_W = 5_100;  // measured p50 heating draw

// ── 1. config ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const d = parseGenConfig({});
  assert.deepEqual(d.cfg, { capW: 20_000, marginW: 2_400 }, "Kohler 20RESA: 20 kW (owner, 2026-11-02)");
  assert.deepEqual(d.errors, []);
  assert.deepEqual(parseGenConfig({ GEN_CAP_KW: "22", GEN_MARGIN_KW: "3" }).cfg, { capW: 22_000, marginW: 3_000 });
  const bad = parseGenConfig({ GEN_CAP_KW: "100", GEN_MARGIN_KW: "-1" });
  assert.deepEqual(bad.cfg, { capW: 20_000, marginW: 2_400 }, "out-of-range values fall back to the defaults");
  assert.equal(bad.errors.length, 2);
  assert.equal(episodeTier("generator_shadow"), "attention", "a generator would-have is one email per episode");
}

// ── 2. supply: the outage feed → grid / generator / unknown ───────────────────────────────────────────────────────────
{
  const t = Date.parse("2026-12-20T12:00:00Z");
  const f = new OutageFeed(t);
  assert.equal(f.supply(t).supply, "unknown", "no answer yet = unknown");
  f.note(false, t);
  assert.deepEqual(f.supply(t + 60_000), { supply: "grid", why: "no outage reported (6bb feed)", assumed: false });
  f.note(null, t + 5 * 60_000); // unreachable: the last answer ages out
  assert.equal(f.supply(t + 14 * 60_000).supply, "grid");
  assert.equal(f.supply(t + 14 * 60_000).assumed, false, "a fresh answer is not assumed");
  // owner 2026-11-01: silent after a "no outage" answer, no outage seen recently → the grid, flagged assumed
  const quiet = f.supply(t + 16 * 60_000);
  assert.equal(quiet.supply, "grid");
  assert.equal(quiet.assumed, true);
  assert.equal(quiet.why, "the outage feed has not answered for 16 min; assuming the grid (no outage seen in the last 6 h)");
  assert.equal(f.status(t + 16 * 60_000).assumed, true, "/health shows the assumption");
  f.note(true, t + 20 * 60_000);
  assert.equal(f.supply(t + 21 * 60_000).supply, "generator");
  f.note(true, t + 55 * 60_000);
  f.note(false, t + 60 * 60_000);
  assert.equal(f.supply(t + 61 * 60_000).supply, "generator", "just restored: still assumed on the generator (retransfer)");
  assert.match(f.supply(t + 61 * 60_000).why, /ended 6 min ago/);
  f.note(false, t + 80 * 60_000);
  assert.equal(f.supply(t + 84 * 60_000).supply, "generator");
  assert.equal(f.supply(t + 86 * 60_000).supply, "grid", "30 min after the last outage answer: grid");
  assert.equal(f.supply(t + 86 * 60_000).assumed, false);
}

// ── 2b. supply when the feed goes SILENT (owner 2026-11-01): the grid unless an outage is plausible ──────────────────
{
  const t = Date.parse("2026-12-20T12:00:00Z");
  const H = 3600_000, M = 60_000;
  // an outage seen within 6 h: a silent feed stays unknown (= the generator)
  const r = new OutageFeed(t);
  r.note(true, t);
  r.note(true, t + 55 * M);
  r.note(false, t + 60 * M);
  assert.equal(r.supply(t + 70 * M).supply, "generator", "restore tail unchanged while the feed is fresh");
  assert.match(r.supply(t + 70 * M).why, /ended 15 min ago/);
  assert.equal(r.supply(t + 86 * M).supply, "unknown", "tail over, but silent with an outage 31 min ago: unknown");
  const recent = r.supply(t + 2 * H);
  assert.equal(recent.supply, "unknown", "silent 1 h after a restore, outage seen 65 min ago: unknown");
  assert.equal(recent.assumed, false);
  assert.match(recent.why, /has not answered for 60 min; an outage was seen 65 min ago/);
  assert.equal(r.supply(t + 55 * M + 6 * H - 1).supply, "unknown", "just under 6 h since the outage: still unknown");
  const old = r.supply(t + 55 * M + 6 * H);
  assert.equal(old.supply, "grid", "6 h since the last outage was seen: assume the grid");
  assert.equal(old.assumed, true);
  // the last answer was an active outage: never the grid, however long the silence
  const a = new OutageFeed(t);
  a.note(true, t);
  assert.equal(a.supply(t + 10 * M).supply, "generator");
  assert.equal(a.supply(t + 16 * M).supply, "unknown");
  assert.equal(a.supply(t + 48 * H).supply, "unknown", "last answer active: never assumed grid");
  assert.match(a.supply(t + 48 * H).why, /its last answer was an active outage/);
  assert.equal(a.status(t + 48 * H).assumed, false);
  // never answered since the planner started: unknown for 30 min, then the grid is assumed
  const n = new OutageFeed(t);
  assert.equal(n.supply(t + 29 * M).supply, "unknown", "startup grace");
  assert.equal(n.supply(t + 29 * M).assumed, false);
  const late = n.supply(t + 30 * M);
  assert.equal(late.supply, "grid", "never answered after the 30-min grace: assume the grid");
  assert.equal(late.assumed, true);
  assert.equal(late.why, "the outage feed has not answered in the 30 min since the planner started; assuming the grid (no outage seen in the last 6 h)");
  assert.equal(n.status(t + 30 * M).assumed, true);
  // an outage reported during the grace keeps a silent feed unknown after it
  const n2 = new OutageFeed(t);
  n2.note(true, t + 5 * M);
  assert.equal(n2.supply(t + 25 * M).supply, "unknown");
  assert.equal(n2.supply(t + 40 * M).supply, "unknown", "the outage it reported keeps a silent feed unknown past the grace");
}

// ── 2c. the feed's memory outlives a restart (#252 review): every deploy restarts the planner ──────────
{
  const t = Date.parse("2026-12-20T12:00:00Z");
  const H = 3600_000, M = 60_000;
  // the scenario: outage reported, the feed dies, a deploy lands, and the new instance has never heard from it
  const old = new OutageFeed(t);
  old.note(true, t);
  const restarted = new OutageFeed(t + 25 * M);
  assert.equal(restarted.supply(t + 55 * M + 30 * M).supply, "grid", "without the memory, the deploy forgets the outage");
  const kept = new OutageFeed(t + 25 * M);
  kept.restore(old.memory());
  assert.equal(kept.supply(t + 30 * M).supply, "unknown", "inside the grace");
  const later = kept.supply(t + 25 * M + 30 * M);
  assert.equal(later.supply, "unknown", "past the grace, the remembered outage keeps it unknown");
  assert.equal(later.assumed, false);
  assert.match(later.why, /its last answer was an active outage/);
  assert.equal(kept.supply(t + 72 * H).supply, "unknown", "same answer as a planner that never restarted");
  // an outage that ended before the restart: recent keeps it unknown, then the 6 h rule applies
  const ended = new OutageFeed(t);
  ended.note(true, t);
  ended.note(false, t + 5 * M);
  const kept2 = new OutageFeed(t + 10 * M);
  kept2.restore(ended.memory());
  assert.equal(kept2.supply(t + 45 * M).supply, "unknown", "outage 45 min ago, feed silent");
  assert.equal(kept2.supply(t + 6 * H).supply, "grid", "6 h since the outage: the grid is assumed");
  assert.equal(kept2.supply(t + 6 * H).assumed, true);
  // a first answer after the restart wins, and the retransfer tail still counts from the remembered outage
  const tail = new OutageFeed(t + 10 * M);
  tail.restore(ended.memory());
  tail.note(false, t + 15 * M);
  assert.equal(tail.supply(t + 16 * M).supply, "generator", "just restored before the deploy: still the retransfer tail");
  tail.note(false, t + 30 * M);
  assert.equal(tail.supply(t + 31 * M).supply, "grid", "the tail ends 30 min after the remembered outage");
  // the memory is not an answer: a calm one still gets the startup grace, so a deploy never reads as "grid, assumed"
  const calm = new OutageFeed(t);
  calm.restore({ active: false, lastActiveMs: t - 30 * H });
  assert.equal(calm.supply(t + 10 * M).supply, "unknown", "inside the grace after a restore");
  assert.equal(calm.supply(t + 30 * M).assumed, true, "the grace ends as it always did");
  // an answer that beat the restore is not overwritten by older memory
  const raced = new OutageFeed(t);
  raced.note(false, t + M);
  raced.restore({ active: true, lastActiveMs: null });
  assert.equal(raced.supply(t + 2 * M).supply, "grid");
  assert.deepEqual(new OutageFeed(t).memory(), { active: null, lastActiveMs: null });
}

// ── 2d. a silent feed tells the owner (#252 review) ──────────
{
  const t = Date.parse("2026-12-20T12:00:00Z");
  const H = 3600_000, M = 60_000;
  const f = new OutageFeed(t);
  assert.equal(f.silence(t + 119 * M), null, "under 2 h since the planner started");
  assert.equal(f.silence(t + 2 * H)?.hours, 2, "never answered counts from the start");
  f.note(false, t + 3 * H);
  assert.equal(f.silence(t + 3 * H + M), null, "it answered");
  f.note(null, t + 3 * H + 5 * M, "it refused the planner's key (HTTP 401)");
  assert.equal(f.status(t + 3 * H + 5 * M).last_failure, "it refused the planner's key (HTTP 401)", "/health names the failure");
  assert.equal(f.silence(t + 5 * H - M), null);
  const s = f.silence(t + 5 * H)!;
  assert.equal(s.failure, "it refused the planner's key (HTTP 401)");
  assert.match(s.why, /assuming the grid/);
  f.note(false, t + 6 * H);
  assert.equal(f.status(t + 6 * H).last_failure, null, "an answer clears the failure");
  assert.equal(f.silence(t + 6 * H), null);
  // silent after an outage: the element is locked out on a guess, which the owner needs to hear about too
  const a = new OutageFeed(t);
  a.note(true, t);
  assert.match(a.silence(t + 3 * H)!.why, /its last answer was an active outage/);
  // the owner can see the grid was a guess
  const base = { nowMs: t, houseW: 3_000, relay: "CLOSED", pumpsEngaged: 1 } as const;
  const guessed = assess({ ...base, supply: { supply: "grid", why: "x", assumed: true }, comfort: { at_risk: null, why: "" } });
  assert.match(guessed.element_why, /assumed on the grid \(the outage feed is silent\)/);
  const known = assess({ ...base, supply: { supply: "grid", why: "x", assumed: false }, comfort: { at_risk: null, why: "" } });
  assert.equal(known.element_why, "on the grid: no generator limit");
}

// ── 3. comfort: every OCCUPIED zone counts, the coldest decides; a zone with no / a stale temperature is unknown ──────
const Z = (id: string, roomF: number | null, setpointF: number | null, name = id, extra: Partial<ZoneTemp> = {}): ZoneTemp =>
  ({ id, name, roomF, setpointF, ...extra });
{
  const T = Date.parse("2026-12-20T12:00:00Z");
  const mom = Z("mom", 66.5, 68, "Mom's room"), kit = Z("kit", 67.8, 68, "Kitchen");
  const base = Z("base", 57, null, "Upstairs Baseboard"); // an OFF Nest: no setpoint, deliberately unheated (comfort-only)
  assert.equal(comfortRisk(null, null).at_risk, null);
  const ok = comfortRisk([mom, kit, base], ["kit"], { nowMs: T });
  assert.equal(ok.at_risk, false, ok.why);
  assert.equal(ok.coldest?.name, "Mom's room", "a satisfied zone that is not calling still counts");
  // her thermostat set back to 59, satisfied, not calling: the FLOOR still sees her room
  const setBack = comfortRisk([Z("mom", 59.4, 59, "Mom's room"), kit], [], { nowMs: T });
  assert.equal(setBack.at_risk, true, "nobody calling, but an occupied room is within 2 °F of the floor");
  assert.match(setBack.why, /Mom's room is 59.4 °F — within 2 °F of the 60 °F floor/);
  assert.equal(comfortRisk([mom, Z("mom2", 66, 68, "Den", { mode: "off" })], null, { nowMs: T }).at_risk, false, "a thermostat in OFF is not occupied");
  assert.equal(comfortRisk([mom, Z("dhw", null, 120, "Hot Water", { deliveryType: "dhw" })], null, { nowMs: T }).at_risk, false, "DHW is not a room");
  assert.equal(comfortRisk([mom, base], null, { nowMs: T }).at_risk, false, "an OFF Nest (no setpoint) is not occupied");
  assert.equal(comfortRisk([mom, Z("tack", 59, 62.6, "Barn - Tack")], null, { nowMs: T }).at_risk, false, "the barn is excluded by default");
  assert.equal(comfortRisk([mom, Z("tack", 59, 62.6, "Barn - Tack")], null, { nowMs: T, exclude: [] }).at_risk, true, "… unless the owner says otherwise");
  assert.deepEqual(parseComfortExclude({}), DEFAULT_COMFORT_EXCLUDE);
  assert.deepEqual(parseComfortExclude({ COMFORT_EXCLUDE_ZONES: " Barn - Tack , Garage " }), ["Barn - Tack", "Garage"]);
  // target at risk
  const behind = comfortRisk([Z("mom", 65.9, 68, "Mom's room"), Z("kit", 67, 68)], ["mom", "kit"], { nowMs: T });
  assert.equal(behind.at_risk, true, "2 °F below its setpoint = target at risk");
  assert.match(behind.why, /Mom's room is 65.9 °F, 2.1 °F below its 68 °F setpoint/);
  // a calling zone with no temperature is never dropped: unknown
  const noTemp = comfortRisk([kit, Z("mom", null, 68, "Mom's room")], ["mom"], { nowMs: T });
  assert.equal(noTemp.at_risk, null);
  assert.deepEqual(noTemp.unknown, ["Mom's room no temperature"]);
  // ... but a KNOWN zone at risk still decides
  assert.equal(comfortRisk([Z("x", 61, 68), Z("mom", null, 68)], ["mom"], { nowMs: T }).at_risk, true);
  // staleness: a reading unchanged for 6 h is stale → unknown
  const ages = new ZoneAges();
  ages.observe([mom, kit], T);
  ages.observe([{ ...mom }, { ...kit, roomF: 67.9 }], T + 5 * 3600_000);
  assert.equal(comfortRisk([mom, { ...kit, roomF: 67.9 }], null, { nowMs: T + 5.9 * 3600_000, ages }).at_risk, false, "5.9 h unchanged: fresh");
  const st = comfortRisk([mom, { ...kit, roomF: 67.9 }], null, { nowMs: T + 6 * 3600_000, ages });
  assert.equal(st.at_risk, null, "6 h unchanged: stale → unknown, never ignored");
  assert.deepEqual(st.unknown, ["Mom's room stale at 66.5 °F"]);
  ages.observe([{ ...mom, roomF: 66.4 }], T + 7 * 3600_000);
  assert.equal(ages.stale("mom", T + 7 * 3600_000), false, "a new value resets the age");
}

// ── 3b. the REAL zone snapshot (zone_floor_snapshots, 2026-10-29 17:37 ET; modes not mirrored, so unknown) ──────────
{
  const snap = readFileSync(new URL("../fixtures/zones-20261029.json", import.meta.url), "utf8");
  const zones = (JSON.parse(snap).zones as Array<{ zoneId: string; name: string; roomF: number | null; setpointF: number | null; deliveryType: string }>)
    .map((z) => Z(z.zoneId, z.roomF, z.setpointF, z.name, { deliveryType: z.deliveryType }));
  const c = comfortRisk(zones, [], { nowMs: 0 });
  // Den / Office reads 59 °F against 70.7: if it is occupied, the house IS cold there — the verdict says so by name
  assert.equal(c.at_risk, true);
  assert.equal(c.coldest?.name, "Den / Office");
  assert.match(c.why, /Den \/ Office is 59 °F — within 2 °F of the 60 °F floor/);
  // MEASURED (367 hourly snapshots, Oct 15–29): with every occupied zone counting, comfort was "at risk" 100 % of the
  // time — mini-split rooms sit well under their setpoints. Excluding Den / Office and Xmas Room still leaves Ally's
  // Bedroom 6.3 °F under 72.5 °F here (84 % at risk over the window). So under the owner's rule the generator check
  // binds on the BUDGET; comfort rarely says "not cold". Which zones count is the owner's call (COMFORT_EXCLUDE_ZONES).
  const rest = comfortRisk(zones, [], { nowMs: 0, exclude: [...DEFAULT_COMFORT_EXCLUDE, "Den / Office", "Xmas Room"] });
  assert.equal(rest.at_risk, true);
  assert.match(rest.why, /Ally’s Bedroom is 66.2 °F, 6.3 °F below its 72.5 °F setpoint/);
  // the hydronic zones alone (what the element can heat) are fine at this moment
  const minis = zones.filter((z) => z.deliveryType === "mini_split").map((z) => z.name);
  assert.equal(comfortRisk(zones, [], { nowMs: 0, exclude: [...DEFAULT_COMFORT_EXCLUDE, ...minis] }).at_risk, false);
}

// ── 4. budget + house load ───────────────────────────────────────────────────────────────────────────────────────────
const cold: Comfort = { at_risk: true, coldest: { name: "Mom's room", room_f: 61.2, setpoint_f: 68 }, why: "Mom's room is 61.2 °F — within 2 °F of the 60 °F floor" };
const warm: Comfort = { at_risk: false, coldest: { name: "Mom's room", room_f: 67.9, setpoint_f: 68 }, why: "the coldest calling zone, Mom's room, is 67.9 °F" };
const unknownComfort: Comfort = { at_risk: null, coldest: null, why: "TempIQ zone temperatures unavailable" };
const GENR = { supply: "generator" as const, why: "National Grid reports an outage (6bb feed)" };
const GRID = { supply: "grid" as const, why: "no outage reported (6bb feed)" };
const UNK = { supply: "unknown" as const, why: "the outage feed has not answered since the planner started" };
{
  const a = (houseW: number | null, comfort: Comfort, supply: { supply: Supply; why: string } = GENR, relay: "OPEN" | "CLOSED" | null = "OPEN", pumpsEngaged = 0) =>
    assess({ nowMs: 0, supply, houseW, relay, pumpsEngaged, comfort });
  // owner 2026-11-02: on the generator or an unknown supply, NO combination of budget and comfort lets the element close
  const atCap = 20_000 - GEN.ELEMENT_W - GEN.MARGIN_W; // 1.1 kW: the most house load the 20 kW budget leaves
  for (const supply of [GENR, UNK]) {
    for (const houseW of [0, 1_000, atCap, atCap + 1, BASE_W, BASE_W + PUMP_W, BASE_W + 2 * PUMP_W, null]) {
      for (const comfort of [cold, warm, unknownComfort]) {
        const r = a(houseW, comfort, supply);
        assert.equal(r.element_allowed, false, `${supply.supply}, house ${houseW} W, comfort ${comfort.at_risk}`);
        assert.equal(r.budget_applies, true);
      }
    }
  }
  assert.equal(a(1_000, cold).element_why, "on the generator: the element is never used there (owner, 2026-11-02)");
  assert.equal(a(1_000, cold, UNK).element_why,
    "the supply is unknown, so it is treated as the generator: the element is never used there (owner, 2026-11-02)");
  // ... and the budget and comfort are still reported (/health)
  const fit = a(atCap, cold);
  assert.equal(fit.cap_w, 20_000);
  assert.equal(fit.budget_fits, true, "exactly at the cap fits the budget");
  assert.equal(fit.projected_w, 20_000);
  assert.equal(fit.comfort, cold);
  assert.equal(a(atCap + 1, cold).budget_fits, false);
  assert.equal(a(BASE_W, cold).budget_fits, false, "both pumps down, base load: 1.2 + 16.5 + 2.4 = 20.1 kW > 20");
  assert.equal(a(BASE_W + PUMP_W, cold).projected_w, 25_211, "one pump heating: 25.2 kW");
  assert.equal(a(null, cold).budget_fits, null, "unknown load: unknown budget");
  // the grid and an assumed grid (a silent feed, no outage plausible) are unchanged
  const assumedGrid = new OutageFeed(0).supply(GEN.FEED_STARTUP_GRACE_MS);
  assert.equal(assumedGrid.assumed, true);
  for (const supply of [GRID, assumedGrid]) {
    for (const houseW of [BASE_W, BASE_W + PUMP_W + 7_200, null]) {
      for (const comfort of [cold, warm, unknownComfort]) {
        const r = a(houseW, comfort, supply);
        assert.equal(r.element_allowed, true, `on the grid nothing changes (${supply.why}, house ${houseW} W)`);
        assert.equal(r.element_why, supply === GRID ? "on the grid: no generator limit" : "assumed on the grid (the outage feed is silent): no generator limit");
        assert.equal(r.budget_applies, false);
      }
    }
  }
  // advisories
  assert.equal(a(BASE_W + PUMP_W, cold, GENR, "CLOSED").shed, true, "breaker ON on the generator without headroom");
  assert.equal(a(BASE_W, cold, GENR, "CLOSED").shed, true, "the base load alone leaves no room for the element on 20 kW");
  assert.equal(a(BASE_W, cold, UNK, "CLOSED").shed, true, "unknown supply = the generator");
  assert.equal(a(1_000, cold, GENR, "CLOSED").shed, false);
  assert.equal(a(BASE_W + PUMP_W, cold, GENR, "OPEN").shed, false, "the breaker is OFF: nothing to shed");
  assert.equal(a(BASE_W + PUMP_W, cold, GRID, "CLOSED").shed, false, "never on the grid");
  assert.equal(a(null, cold, GENR, "CLOSED").shed, true, "the load nobody can see is what the lockout refuses on: the shed warns on it too");
  assert.equal(a(null, cold, UNK, "CLOSED").shed, true);
  assert.equal(a(null, cold, GRID, "CLOSED").shed, false, "unknown load on the grid: nothing to shed for");
  assert.equal(a(null, cold, GENR, "OPEN").shed, false, "the breaker is OFF: the HBX cannot fire it");
  assert.equal(a(null, cold, GENR, null).shed, false, "no relay reading: not a claim that it is ON");
  assert.equal(a(BASE_W + 2 * PUMP_W, cold, GENR, "OPEN", 2).one_pump, false, "both pumps + base = 11.4 kW: room to spare");
  assert.equal(a(BASE_W + 2 * PUMP_W + 7_200 + 4_000, cold, GENR, "OPEN", 2).one_pump, true, "both pumps + EV + more: near the cap");
  // the shed notice follows the gate's mode, and says the load is unknown rather than "no headroom"
  const over = a(BASE_W + PUMP_W, cold, GENR, "CLOSED");
  const sh = shedNotice("shadow", over), lv = shedNotice("live", over), unk = shedNotice("shadow", a(null, cold, GENR, "CLOSED"));
  assert.equal(sh.title, "Backup element (shadow): breaker is ON on the generator without headroom");
  assert.match(sh.body, /^SHADOW — nothing was switched\. /);
  assert.match(sh.body, /an owner decision before going live/);
  assert.equal(lv.title, "Backup element: breaker is ON on the generator without headroom");
  assert.doesNotMatch(lv.title + lv.body, /shadow|going live/i, "promoted to live, the notice must not assert shadow");
  assert.match(lv.body, /House 6311 W \+ element 16500 W \+ margin 2400 W = 25211 W against the 20000 W cap/);
  assert.equal(unk.title, "Backup element (shadow): breaker is ON on the generator with the house load unknown");
  assert.match(unk.body, /The live house load is unknown, so nothing shows the 16500 W element fits under the 20000 W cap/);
  assert.doesNotMatch(unk.title + unk.body, /headroom|\?/);
  assert.equal(genEpisodeKind("shadow"), "generator_shadow");
  assert.equal(genEpisodeKind("off"), "generator_shadow");
  assert.equal(genEpisodeKind("live"), "generator");
  assert.equal(episodeTier("generator"), "attention", "live keeps the one email per episode (the default tier is record)");
  // a room a thermostat holds sits in one 0.5 °C bucket for hours: not stale, so a warm steady house is not "unknown"
  // comfort, and on the generator with headroom it does not get the element (the last-resort test in the calm case)
  const T = Date.parse("2026-12-20T12:00:00Z");
  const steady = [Z("lr", 68, 68, "Living Room"), Z("bed", 69.8, 68, "Bedroom")];
  const ages = new ZoneAges();
  ages.observe(steady, T);
  const after7h = comfortRisk(steady, null, { nowMs: T + 7 * 3600_000, ages });
  assert.equal(after7h.at_risk, false, after7h.why);
  assert.deepEqual(after7h.unknown, []);
  assert.equal(a(BASE_W, after7h).element_allowed, false);
  // ... but a reading BELOW its setpoint that stops moving is still stale, and so is one with no setpoint to compare
  const slipping = [Z("lr", 67.5, 68, "Living Room"), Z("loft", 67, null, "Loft")];
  ages.observe(slipping, T);
  assert.deepEqual(comfortRisk(slipping, ["loft"], { nowMs: T + 7 * 3600_000, ages }).unknown,
    ["Living Room stale at 67.5 °F", "Loft stale at 67 °F"]);
  // the Pi's house_w, fresh only
  assert.equal(houseLoadW(1000, { ts: 950, house_w: 1211 }), 1211);
  assert.equal(houseLoadW(1000, { ts: 800, house_w: 1211 }), null, "a panel read 200 s older than the frame is stale");
  assert.equal(houseLoadW(1000, { ts: 990 }), null, "an older bridge without house_w: unknown");
  assert.equal(houseLoadW(null, { ts: 990, house_w: 5 }), null);
  // the Pi re-checks the budget at the close only when it applies here: on the grid the gate's normal winter close is
  // 25.2 kW against the 20 kW cap, and it must go through (#252); an open adds no load
  const winter = BASE_W + PUMP_W;
  assert.equal(piBudgetCheck("close", a(winter, warm, GRID)), false, "grid: unchecked, the load does not matter");
  assert.equal(piBudgetCheck("close", a(null, warm, GRID)), false);
  assert.equal(piBudgetCheck("close", a(winter, cold, { ...GRID, assumed: true } as typeof GRID)), false,
    "a grid assumed from a silent feed is the grid to the gate: the known gap of the owner's 2026-11-01 rule");
  assert.equal(piBudgetCheck("close", a(BASE_W, cold, GENR)), true, "generator: checked on the Pi's fresh read");
  assert.equal(piBudgetCheck("close", a(BASE_W, cold, UNK)), true, "unknown supply is the generator rule");
  assert.equal(piBudgetCheck("open", a(BASE_W, cold, GENR)), false);
  // ... which never happens today: the gate sends no close when the budget applies (owner, 2026-11-02), so a close the
  // element is allowed on and a close the Pi would check are never the same close
  for (const supply of [GRID, GENR, UNK]) for (const houseW of [0, BASE_W, winter, null]) for (const comfort of [cold, warm]) {
    const g = a(houseW, comfort, supply);
    assert.equal(g.element_allowed && piBudgetCheck("close", g), false, `${supply.supply}, house ${houseW} W`);
  }
}

// ── 5. REPLAY the Oct 15–16 incident with an outage laid over it ─────────────────────────────────────────────────────
type FxRow = [number, number | null, number | null, string | null, string[] | null];
const rows: FxRow[] = JSON.parse(readFileSync(new URL("../fixtures/backupgate-incident-20261015.json", import.meta.url), "utf8")).rows;
const et = (s: number) => new Date(s * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const etMs = (iso: string) => Date.parse(iso) / 1000;

interface Overlay { supply: (ts: number) => typeof GENR | typeof GRID | typeof UNK; houseW: (ts: number) => number | null; comfort: (ts: number) => Comfort }
function replay(o: Overlay | null): { at: number; e: GateEvent }[] {
  const gate = new BackupGate("shadow", true);
  const sw = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const out: { at: number; e: GateEvent }[] = [];
  for (const [ts, tank, tgt, st, ps] of rows) {
    const nowMs = ts * 1000;
    const stages = st == null ? null : [...st].map((c) => c === "1");
    const pumps: GatePump[] | null = ps ? ps.map((s, k) => ({ id: `pump${k + 1}`, online: s !== "offline", state: s })) : null;
    sw.step({ nowMs, stagesCalled: stages, pumps: stages?.some(Boolean) ? pumps : [], lagTMin: null });
    const status = sw.status();
    const withEp = pumps?.map((p) => ({ ...p, stageEpisode: Object.values(status).some((s) => s.pump === p.id && (s.unserved_open || s.fault_open)) })) ?? null;
    const g = o ? assess({ nowMs, supply: o.supply(ts), houseW: o.houseW(ts), relay: "OPEN", pumpsEngaged: 0, comfort: o.comfort(ts) }) : null;
    for (const e of gate.step({ nowMs, tankF: tank, tankTargetF: tgt, stagesCalled: stages, pumps: withEp,
      generator: g ? { allowed: g.element_allowed, why: g.element_why } : undefined })) out.push({ at: ts, e });
  }
  return out;
}
const kinds = (ev: { at: number; e: GateEvent }[]) => ev.map((x) => `${et(x.at)} ${x.e.kind}`);
const outage = () => GENR;
{
  // the baseline: on the grid the gate would-closes 13:35 and would-opens after HP2 recovers (backupgate.test.ts §2)
  const grid = replay(null);
  assert.deepEqual(grid.map((x) => x.e.kind), ["close", "open"]);
  const gridClose = grid[0].at;
  assert.equal(et(gridClose), "10/15, 13:35");
  assert.deepEqual(kinds(replay({ supply: () => GRID, houseW: () => BASE_W + PUMP_W + 7_200, comfort: () => warm })), kinds(grid),
    "a fresh 'no outage' answer changes nothing, whatever the load");

  // (a) generator + normal house load (base + HP1 as lag stage) → the element stays locked out, one notice per episode
  const a = replay({ supply: outage, houseW: () => BASE_W + PUMP_W, comfort: () => cold });
  assert.deepEqual(a.map((x) => x.e.kind), ["generator_lockout"], kinds(a).join(", "));
  assert.equal(a[0].at, gridClose, "refused at the moment the grid replay would close");
  assert.match(a[0].e.title, /shadow.*generator rule says no/i);
  assert.match(a[0].e.body, /SHADOW — nothing was switched/);
  assert.match(a[0].e.body, /on the generator: the element is never used there \(owner, 2026-11-02\)/);
  assert.equal(a[0].e.priority, "default", "never a phone push");

  // (b) cold house AND a load inside the budget (1.0 kW: 1.0 + 16.5 + 2.4 = 19.9 kW) → still locked out (owner 2026-11-02)
  const b = replay({ supply: outage, houseW: () => 1_000, comfort: () => cold });
  assert.deepEqual(b.map((x) => x.e.kind), ["generator_lockout"], "headroom and a cold house no longer let it close");
  assert.equal(b[0].at, gridClose);

  // (b') headroom, the house holding temperature or comfort unknown → locked out
  for (const comfort of [warm, unknownComfort]) {
    assert.deepEqual(replay({ supply: outage, houseW: () => 1_000, comfort: () => comfort }).map((x) => x.e.kind), ["generator_lockout"]);
  }

  // (c) unknown supply (feed silent, outage plausible), with no live load or a load that fits → locked out
  const c = replay({ supply: () => UNK, houseW: () => null, comfort: () => cold });
  assert.deepEqual(c.map((x) => x.e.kind), ["generator_lockout"]);
  assert.match(c[0].e.body, /the supply is unknown, so it is treated as the generator: the element is never used there/);
  assert.deepEqual(replay({ supply: () => UNK, houseW: () => 1_000, comfort: () => cold }).map((x) => x.e.kind), ["generator_lockout"]);

  // (d) the load drops mid-episode (the EV charger stops at 15:00): still locked out, no close for the rest of the episode
  const evStop = etMs("2026-10-15T15:00:00-04:00");
  const d = replay({ supply: outage, houseW: (ts) => (ts < evStop ? BASE_W + 7_200 : 1_000), comfort: () => cold });
  assert.deepEqual(d.map((x) => x.e.kind), ["generator_lockout"], kinds(d).join(", "));
  assert.equal(d[0].at, gridClose);

  // (d') an assumed grid (silent feed, no outage plausible) behaves as the grid
  const assumed = { supply: "grid" as const, why: "the outage feed has not answered for 16 min; assuming the grid (no outage seen in the last 6 h)" };
  assert.deepEqual(kinds(replay({ supply: () => assumed, houseW: () => null, comfort: () => warm })), kinds(grid));

  // (e) the outage starts mid-episode, at 13:00: the hold clocks keep running, the generator rule judges at close time
  const start = etMs("2026-10-15T13:00:00-04:00");
  const e = replay({ supply: (ts) => (ts < start ? GRID : GENR), houseW: () => BASE_W + PUMP_W, comfort: () => cold });
  assert.deepEqual(e.map((x) => x.e.kind), ["generator_lockout"]);
}

console.log("generator.test.ts: all assertions passed");
