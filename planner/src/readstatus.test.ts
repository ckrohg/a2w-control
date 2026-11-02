/**
 * @purpose Assertions for #190's planner side: PLANNER_READ_TOKEN opens GET /api/status and nothing else (readstatus.ts),
 * an unset token leaves the route answering exactly as before (the caller's 404), an empty bearer never matches, a token
 * equal to another planner secret disables the route without exiting, and the body has the Heating-card shape with no
 * secrets; armed only with a live lease on every configured pump; a silent or assumed outage feed reads unavailable;
 * tokens trimmed before the clash check. Also the hub's active_faults in BOTH shapes — the old count and the new list
 * (hub.ts faultList) — since the Pi updates only on a release tag; owner wording follows `state` for either
 * (owneralerts.ts). Run: npx tsx planner/src/readstatus.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildReadStatus, constantTimeEqual, readAuthorized, readGate, routeReadStatus, type ReadStatusInput } from "./readstatus";
import { OutageFeed } from "./generator";
import { faultList, type HubPump } from "./hub";
import { coldNow, pumpWords } from "./owneralerts";

const RO = "ro-secret-0123456789";
const OTHERS = { PLANNER_API_TOKEN: "api-secret", HUB_CLIENT_TOKEN: "hub-client", HUB_ARM_TOKEN: undefined, DATABASE_URL: "postgres://x" };
const input = (over: Partial<ReadStatusInput> = {}): ReadStatusInput => ({
  backupCalled: false, backupKwhLastHour: 0.02,
  phaseB: { pumpIds: ["pump1", "pump2"], lastResults: { pump1: "ok 52C (lease 88m armed)" }, leaseUntilS: { pump1: 1_800_005_400, pump2: 1_800_003_600 } },
  thermal: { tank_f: 128, tank_target_f: 130, dhw_floor_f: 120, dhw_ready: true },
  storm: { state: "idle", trigger: null, windowEnd: null, enabled: false, lastTriggerPollAt: null },
  outageSupply: { supply: "grid", assumed: false }, nowMs: 1_800_000_000_000, ...over,
});

async function main(): Promise<void> {
  let n = 0;
  const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok   ${name}`); };

  t("constantTimeEqual: equal / unequal / different length / empty expected never matches", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abd", "abc"), false);
    assert.equal(constantTimeEqual("abcdef", "abc"), false);
    assert.equal(constantTimeEqual("", ""), false);
  });

  t("unset or blank PLANNER_READ_TOKEN: gate off, the route falls through to the usual 404 for everyone", () => {
    for (const tok of [undefined, "", "   "]) {
      const g = readGate(tok, OTHERS);
      assert.deepEqual(g, { enabled: false, token: "", error: null });
      let built = false;
      for (const auth of [undefined, "", "Bearer", "Bearer ", `Bearer ${RO}`, "Bearer api-secret"]) {
        assert.equal(routeReadStatus(g, "GET", "/api/status", auth, () => { built = true; return buildReadStatus(input()); }), null);
      }
      assert.equal(built, false);
    }
  });

  t("read token: GET/HEAD /api/status 200; none, empty, wrong or the API token 401; other methods 405", () => {
    const g = readGate(RO, OTHERS);
    assert.equal(g.enabled, true);
    const r = routeReadStatus(g, "GET", "/api/status", `Bearer ${RO}`, () => buildReadStatus(input()));
    assert.equal(r?.status, 200);
    assert.equal(routeReadStatus(g, "HEAD", "/api/status?x=1", `bearer  ${RO} `, () => buildReadStatus(input()))?.status, 200);
    for (const auth of [undefined, "", "Bearer", "Bearer ", RO, "Bearer nope", "Bearer api-secret", `Basic ${RO}`]) {
      assert.equal(routeReadStatus(g, "GET", "/api/status", auth, () => { throw new Error("built for a bad token"); })?.status, 401, String(auth));
    }
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal(routeReadStatus(g, m, "/api/status", `Bearer ${RO}`, () => { throw new Error("built"); })?.status, 405, m);
    }
    assert.equal(readAuthorized(g, ""), false);
  });

  t("the read token opens no other route: every other path is not this route's business (null)", () => {
    const g = readGate(RO, OTHERS);
    for (const url of ["/health", "/api/readiness", "/api/hbx/target", "/api/hbx/boost", "/api/storm/arm", "/api/drill",
                       "/api/autonomy", "/api/sanitize", "/api/status/x", "/api/statusx"]) {
      assert.equal(routeReadStatus(g, "GET", url, `Bearer ${RO}`, () => buildReadStatus(input())), null, url);
    }
  });

  t("a read token equal to another planner secret disables the route with an error — no throw, no exit", () => {
    for (const [name, value] of Object.entries(OTHERS)) {
      if (!value) continue;
      const g = readGate(value, OTHERS);
      assert.equal(g.enabled, false);
      assert.match(g.error ?? "", new RegExp(`PLANNER_READ_TOKEN equals ${name}`));
      assert.ok(!(g.error ?? "").includes(value), "the error names the clash, never the secret");
      assert.equal(routeReadStatus(g, "GET", "/api/status", `Bearer ${value}`, () => buildReadStatus(input())), null);
    }
    // an unset other secret is no clash
    assert.equal(readGate(RO, { HUB_ARM_TOKEN: "" }).enabled, true);
  });

  t("tokens are trimmed first: a trailing newline hides no clash and locks nobody out", () => {
    const g = readGate("api-secret\n", OTHERS);
    assert.equal(g.enabled, false);
    assert.match(g.error ?? "", /PLANNER_READ_TOKEN equals PLANNER_API_TOKEN/);
    assert.match(readGate(RO, { HUB_ARM_TOKEN: `${RO}\n` }).error ?? "", /equals HUB_ARM_TOKEN/);
    const ok = readGate(`  ${RO}\r\n`, OTHERS);
    assert.deepEqual(ok, { enabled: true, token: RO, error: null });
    assert.equal(readAuthorized(ok, `Bearer ${RO}`), true);
  });

  t("index.ts wiring: the read token reaches only readGate, the clash is logged, the planner never exits on it", () => {
    const src = readFileSync(path.join(__dirname, "index.ts"), "utf8");
    assert.equal(src.match(/process\.env\.PLANNER_READ_TOKEN/g)?.length, 1);
    assert.equal(src.match(/READ_GATE/g)?.length, 4, "declared, error-logged (×2), used by routeReadStatus — nothing else");
    const block = src.slice(src.indexOf("const READ_GATE"), src.indexOf("if (READ_GATE.error)") + 120);
    assert.ok(!/process\.exit/.test(block), "a clash must not exit the planner");
    assert.match(block, /console\.error/);
    const authed = src.slice(src.indexOf("const authed ="), src.indexOf("const authed =") + 400);
    assert.ok(!/READ|readGate|readAuthorized/.test(authed), "authed() (the write API) knows nothing of the read token");
  });

  t("body: exactly the Heating-card keys, no secrets, failsafe and outage signal derived", () => {
    const s = buildReadStatus(input());
    assert.deepEqual(Object.keys(s).sort(), ["backup", "failsafe", "outageSignal", "storm", "thermal"]);
    assert.deepEqual(s.backup, { called: false, spanBufferTankKwhLastHour: 0.02 });
    assert.deepEqual(s.failsafe, { armed: true, leaseUntil: new Date(1_800_003_600 * 1000).toISOString() });
    assert.equal(s.outageSignal, "ok");
    const raw = JSON.stringify(s);
    for (const secret of [RO, ...Object.values(OTHERS).filter(Boolean) as string[]]) assert.ok(!raw.includes(secret));
    assert.deepEqual(buildReadStatus(input({ phaseB: null })).failsafe, { armed: null, leaseUntil: null });
    assert.deepEqual(buildReadStatus(input({ phaseB: { pumpIds: ["pump1"], lastResults: { pump1: "ok 52C — ⚠ NO LEASE ARMED" }, leaseUntilS: { pump1: null } } })).failsafe,
      { armed: false, leaseUntil: null });
    assert.deepEqual(buildReadStatus(input({ phaseB: { pumpIds: ["pump1", "pump2"], lastResults: {}, leaseUntilS: {} } })).failsafe, { armed: null, leaseUntil: null });
  });

  t("outageSignal: unavailable when the feed is silent, whether supply reads unknown or an assumed grid", () => {
    const signal = (outageSupply: ReadStatusInput["outageSupply"]) => buildReadStatus(input({ outageSupply })).outageSignal;
    assert.equal(signal({ supply: "unknown", assumed: false }), "unavailable");
    assert.equal(signal({ supply: "grid", assumed: true }), "unavailable");
    assert.equal(signal({ supply: "generator", assumed: false }), "ok");
    assert.equal(signal({ supply: "grid", assumed: false }), "ok");
    const t0 = 1_800_000_000_000;
    const feed = new OutageFeed(t0);
    feed.note(false, t0);
    assert.equal(signal(feed.supply(t0 + 60_000)), "ok", "the real feed, answering");
    assert.equal(feed.supply(t0 + 20 * 60_000).supply, "grid");
    assert.equal(signal(feed.supply(t0 + 20 * 60_000)), "unavailable", "the real feed, silent with no recent outage");
  });

  const failsafe = (leaseUntilS: Record<string, number | null>, lastResults: Record<string, string> = {}) =>
    buildReadStatus(input({ phaseB: { pumpIds: ["pump1", "pump2"], lastResults, leaseUntilS } })).failsafe;
  const SOON = 1_800_001_000, LATER = 1_800_002_000, PAST = 1_799_999_000, NOW_S = 1_800_000_000;

  t("failsafe: one pump unarmed is not armed, whichever way it shows", () => {
    assert.deepEqual(failsafe({ pump1: SOON, pump2: null }), { armed: false, leaseUntil: null });
    assert.deepEqual(failsafe({ pump1: null, pump2: SOON }), { armed: false, leaseUntil: null });
    assert.deepEqual(failsafe({ pump1: SOON }), { armed: false, leaseUntil: null }, "a configured pump no verify has seen");
    assert.deepEqual(failsafe({ pump1: null, pump2: null }), { armed: false, leaseUntil: null });
  });

  t("failsafe: a mixed fleet reports the earliest lease; NO LEASE ARMED on one pump wins over the leases", () => {
    assert.deepEqual(failsafe({ pump1: LATER, pump2: SOON }), { armed: true, leaseUntil: new Date(SOON * 1000).toISOString() });
    assert.deepEqual(failsafe({ pump1: LATER, pump2: SOON }, { pump2: "ok 52C — ⚠ NO LEASE ARMED" }),
      { armed: false, leaseUntil: new Date(SOON * 1000).toISOString() });
  });

  t("failsafe: an expired lease is not armed, to the second", () => {
    assert.deepEqual(failsafe({ pump1: LATER, pump2: PAST }), { armed: false, leaseUntil: new Date(PAST * 1000).toISOString() });
    assert.equal(failsafe({ pump1: LATER, pump2: NOW_S }).armed, false, "expiring this instant");
    assert.equal(failsafe({ pump1: LATER, pump2: NOW_S + 1 }).armed, true);
  });

  const P17 = { code: "P17", message: "Stage 1 anti-freeze protection — NORMAL in cold weather, do not cut power", severity: "info" };
  const E21 = { code: "E21", message: "Display controller lost communication with the heat pump", severity: "warning" };

  t("active_faults: the old integer has no list, the new list keeps its well-formed entries", () => {
    assert.equal(faultList(2), null);
    assert.equal(faultList(null), null);
    assert.deepEqual(faultList([P17, E21, null, { message: "no code" }]), [P17, E21]);
  });

  t("owner emails: wording follows the bridge's `state` for both active_faults shapes — a count cannot tell P17 from a fault", () => {
    const pump = (state: string, active_faults: HubPump["active_faults"]): HubPump =>
      ({ id: "pump1", name: "Heat Pump 1", online: true, setpoint_c: 50, state, active_faults });
    for (const faults of [0, 1, 3, [], [P17], [E21], [P17, E21]]) {
      assert.equal(pumpWords(pump("heating", faults)), "heating", JSON.stringify(faults));
      assert.equal(pumpWords(pump("fault", faults)), "showing a fault", JSON.stringify(faults));
      assert.match(coldNow(130, 120, [pump("heating", faults)]), /running normally/);
      assert.match(coldNow(130, 120, [pump("fault", faults)]), /showing a fault/);
    }
  });

  console.log(`readstatus.test.ts: ${n} groups passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
