/**
 * @purpose Assertions for generator-aware outage mode (#241, generator.ts + the backup gate's `generator` input). The
 * replays run the REAL Oct 15–16 incident (HP2 E21 lead, 14.2 h with no heat; on the grid the gate would-closes at
 * 13:35 ET) with an outage laid over it. The house loads are measured, not guessed:
 *   - base 1.2 kW: the SPAN panel's own whole-house `power-flows/site` on 2026-10-29 (span-v2 capture, pumps idle);
 *   - both pump circuits drew ~8 W through the incident window (span_readings), so the base is the whole house;
 *   - a pump heating: p50 5.1 kW, p95 6.1 kW (span_readings Jul 31 – Oct 29, n = 17.7k). With today's lagT 60 the HBX
 *     would have added HP1 an hour into that call, so "normal load on the generator" = 1.2 + 5.1 kW.
 * Pins the three cases the owner asked for: generator + normal load → locked out; cold house + headroom → would close;
 * unknown supply → treated as the generator (locked out without a live load).
 * Run with: npx tsx planner/src/generator.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BackupGate, type GateEvent, type GatePump } from "./backupgate";
import { StageWatch, DEFAULT_STAGE_PUMP_MAP } from "./stagewatch";
import { GEN, OutageFeed, assess, comfortRisk, houseLoadW, parseGenConfig, type Comfort, type ZoneTemp } from "./generator";
import { episodeTier } from "./alertpolicy";

const BASE_W = 1_211;  // SPAN power-flows/site, 2026-10-29
const PUMP_W = 5_100;  // measured p50 heating draw

// ── 1. config ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const d = parseGenConfig({});
  assert.deepEqual(d.cfg, { capW: 24_000, marginW: 2_400 });
  assert.deepEqual(d.errors, []);
  assert.deepEqual(parseGenConfig({ GEN_CAP_KW: "22", GEN_MARGIN_KW: "3" }).cfg, { capW: 22_000, marginW: 3_000 });
  const bad = parseGenConfig({ GEN_CAP_KW: "100", GEN_MARGIN_KW: "-1" });
  assert.deepEqual(bad.cfg, { capW: 24_000, marginW: 2_400 }, "out-of-range values fall back to the defaults");
  assert.equal(bad.errors.length, 2);
  assert.equal(episodeTier("generator_shadow"), "attention", "a generator would-have is one email per episode");
}

// ── 2. supply: the outage feed → grid / generator / unknown ───────────────────────────────────────────────────────────
{
  const f = new OutageFeed();
  const t = Date.parse("2026-12-20T12:00:00Z");
  assert.equal(f.supply(t).supply, "unknown", "no answer yet = unknown");
  f.note(false, t);
  assert.equal(f.supply(t + 60_000).supply, "grid");
  f.note(null, t + 5 * 60_000); // unreachable: the last answer ages out
  assert.equal(f.supply(t + 14 * 60_000).supply, "grid");
  assert.equal(f.supply(t + 16 * 60_000).supply, "unknown", "a feed silent for > 15 min is unknown, never grid");
  f.note(true, t + 20 * 60_000);
  assert.equal(f.supply(t + 21 * 60_000).supply, "generator");
  f.note(true, t + 55 * 60_000);
  f.note(false, t + 60 * 60_000);
  assert.equal(f.supply(t + 61 * 60_000).supply, "generator", "just restored: still assumed on the generator (retransfer)");
  assert.match(f.supply(t + 61 * 60_000).why, /ended 6 min ago/);
  f.note(false, t + 80 * 60_000);
  assert.equal(f.supply(t + 84 * 60_000).supply, "generator");
  assert.equal(f.supply(t + 86 * 60_000).supply, "grid", "30 min after the last outage answer: grid");
}

// ── 3. comfort: the coldest calling zone decides; unknown is unknown ──────────────────────────────────────────────────
const Z = (id: string, roomF: number | null, setpointF: number | null, name = id): ZoneTemp => ({ id, name, roomF, setpointF });
{
  const zones = [Z("mom", 66.5, 68, "Mom's room"), Z("kit", 67.8, 68, "Kitchen"), Z("base", 57, null, "Upstairs Baseboard")];
  assert.equal(comfortRisk(null, null).at_risk, null);
  assert.equal(comfortRisk(zones, []).at_risk, false, "nobody calling: not getting cold");
  const ok = comfortRisk(zones, ["mom", "kit"]);
  assert.equal(ok.at_risk, false, ok.why);
  assert.equal(ok.coldest?.name, "Mom's room");
  assert.equal(comfortRisk(zones, ["base"]).at_risk, true, "a calling zone near the floor");
  assert.match(comfortRisk(zones, ["base"]).why, /within 2 °F of the 60 °F floor/);
  assert.equal(comfortRisk(zones, null).at_risk, false, "no call feed: zones with a setpoint count, an OFF Nest does not (baseboard)");
  const behind = comfortRisk([Z("mom", 65.9, 68, "Mom's room"), Z("kit", 67, 68)], ["mom", "kit"]);
  assert.equal(behind.at_risk, true, "2 °F below its setpoint = target at risk");
  assert.match(behind.why, /Mom's room is 65.9 °F, 2.1 °F below its 68 °F setpoint/);
  assert.equal(comfortRisk([Z("mom", null, 68)], ["mom"]).at_risk, null, "a calling zone without a temperature is unknown");
}

// ── 4. budget + house load ───────────────────────────────────────────────────────────────────────────────────────────
const cold: Comfort = { at_risk: true, coldest: { name: "Mom's room", room_f: 61.2, setpoint_f: 68 }, why: "Mom's room is 61.2 °F — within 2 °F of the 60 °F floor" };
const warm: Comfort = { at_risk: false, coldest: { name: "Mom's room", room_f: 67.9, setpoint_f: 68 }, why: "the coldest calling zone, Mom's room, is 67.9 °F" };
const unknownComfort: Comfort = { at_risk: null, coldest: null, why: "TempIQ zone temperatures unavailable" };
const GENR = { supply: "generator" as const, why: "National Grid reports an outage (6bb feed)" };
const GRID = { supply: "grid" as const, why: "no outage reported (6bb feed)" };
const UNK = { supply: "unknown" as const, why: "the outage feed has not answered since the planner started" };
{
  const a = (houseW: number | null, comfort: Comfort, supply = GENR, relay: "OPEN" | "CLOSED" | null = "OPEN", pumpsEngaged = 0) =>
    assess({ nowMs: 0, supply, houseW, relay, pumpsEngaged, comfort });
  assert.equal(a(BASE_W, cold).element_allowed, true, "both pumps down, base load, mom cold: 1.2 + 16.5 + 2.4 = 20.1 kW fits");
  assert.equal(a(BASE_W + PUMP_W, cold).element_allowed, false, "one pump heating: 1.2 + 5.1 + 16.5 + 2.4 = 25.2 kW > 24");
  assert.match(a(BASE_W + PUMP_W, cold).element_why, /25\.2 kW exceeds the 24\.0 kW cap/);
  assert.equal(a(24_000 - GEN.ELEMENT_W - GEN.MARGIN_W, cold).element_allowed, true, "exactly at the cap fits");
  assert.equal(a(24_000 - GEN.ELEMENT_W - GEN.MARGIN_W + 1, cold).element_allowed, false);
  assert.equal(a(BASE_W, warm).element_allowed, false, "headroom, but the house is not getting cold: last resort only");
  assert.equal(a(BASE_W, unknownComfort).element_allowed, true, "comfort unknown counts as at risk; the budget still binds");
  assert.equal(a(null, cold).element_allowed, false, "unknown load on the generator: locked out");
  assert.equal(a(BASE_W + PUMP_W, warm, GRID).element_allowed, true, "on the grid nothing changes");
  assert.equal(a(null, warm, GRID).element_allowed, true);
  assert.equal(a(BASE_W, cold, UNK).element_allowed, true, "unknown supply = the generator rule, which this load passes");
  assert.equal(a(BASE_W + PUMP_W, cold, UNK).element_allowed, false);
  // advisories
  assert.equal(a(BASE_W + PUMP_W, cold, GENR, "CLOSED").shed, true, "breaker ON on the generator without headroom");
  assert.equal(a(BASE_W, cold, GENR, "CLOSED").shed, false);
  assert.equal(a(BASE_W + PUMP_W, cold, GRID, "CLOSED").shed, false, "never on the grid");
  assert.equal(a(BASE_W + 2 * PUMP_W, cold, GENR, "OPEN", 2).one_pump, false, "both pumps + base = 11.4 kW: room to spare");
  assert.equal(a(BASE_W + 2 * PUMP_W + 7_200 + 4_000, cold, GENR, "OPEN", 2).one_pump, true, "both pumps + EV + more: near the cap");
  // the Pi's house_w, fresh only
  assert.equal(houseLoadW(1000, { ts: 950, house_w: 1211 }), 1211);
  assert.equal(houseLoadW(1000, { ts: 800, house_w: 1211 }), null, "a panel read 200 s older than the frame is stale");
  assert.equal(houseLoadW(1000, { ts: 990 }), null, "an older bridge without house_w: unknown");
  assert.equal(houseLoadW(null, { ts: 990, house_w: 5 }), null);
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
  assert.match(a[0].e.body, /house 6\.3 kW \+ element 16\.5 kW \+ margin 2\.4 kW = 25\.2 kW exceeds the 24\.0 kW cap/);
  assert.equal(a[0].e.priority, "default", "never a phone push");

  // (b) cold house + headroom (both pumps idle at 8 W, base load only, mom's room at 61 °F) → would close, same time
  const b = replay({ supply: outage, houseW: () => BASE_W, comfort: () => cold });
  assert.deepEqual(kinds(b), kinds(grid), "with headroom and a cold house the generator changes nothing");

  // (b') headroom but the house holding temperature → locked out (last resort)
  const bw = replay({ supply: outage, houseW: () => BASE_W, comfort: () => warm });
  assert.deepEqual(bw.map((x) => x.e.kind), ["generator_lockout"]);
  assert.match(bw[0].e.body, /not getting cold/);

  // (c) unknown supply (feed silent) and no live load (a bridge without house_w) → locked out
  const c = replay({ supply: () => UNK, houseW: () => null, comfort: () => cold });
  assert.deepEqual(c.map((x) => x.e.kind), ["generator_lockout"]);
  assert.match(c[0].e.body, /possibly on the generator \(supply unknown\) and the live house load is unknown/);
  // ... and unknown supply with a measured load that fits behaves like the generator: closes
  assert.deepEqual(kinds(replay({ supply: () => UNK, houseW: () => BASE_W, comfort: () => cold })), kinds(grid));

  // (d) the load drops mid-episode (the EV charger stops at 15:00): locked out, then the close the moment it fits
  const evStop = etMs("2026-10-15T15:00:00-04:00");
  const d = replay({ supply: outage, houseW: (ts) => (ts < evStop ? BASE_W + 7_200 : BASE_W), comfort: () => cold });
  assert.deepEqual(d.map((x) => x.e.kind), ["generator_lockout", "close", "open"], kinds(d).join(", "));
  assert.equal(d[0].at, gridClose);
  assert.ok(d[1].at >= evStop && d[1].at - evStop <= 300, `closes on the first poll after the load drops (${et(d[1].at)})`);

  // (e) the outage starts mid-episode, at 13:00: the hold clocks keep running, the generator rule judges at close time
  const start = etMs("2026-10-15T13:00:00-04:00");
  const e = replay({ supply: (ts) => (ts < start ? GRID : GENR), houseW: () => BASE_W + PUMP_W, comfort: () => cold });
  assert.deepEqual(e.map((x) => x.e.kind), ["generator_lockout"]);
}

console.log("generator.test.ts: all assertions passed");
