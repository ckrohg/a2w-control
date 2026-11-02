/**
 * @purpose Assertions for the generator-budget half of HubClient.sendBreaker (hub.ts), against a recording fetch stub: the
 * flag is sent only when the caller asks (no flag on the grid, or the Pi would refuse the gate's normal winter close), and
 * a `budget_held` answer comes back as budgetHeld, so index.ts can tell the generator rule from a failed command. The
 * last blocks walk the path index.ts walks (it starts a server on import, so it can't be imported here): since the
 * owner's 2026-11-02 rule that path never sends the flag, so the hold is a backstop.
 * Run with: npx tsx planner/src/hub-breaker.test.ts
 */
import assert from "node:assert/strict";
import { BackupGate } from "./backupgate";
import { assess, piBudgetCheck, type GenAssessment, type Supply } from "./generator";
import { HubClient } from "./hub";

const realFetch = globalThis.fetch;
function stub(status: number, body: unknown): { sent: unknown[] } {
  const rec = { sent: [] as unknown[] };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    rec.sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return rec;
}

(async () => {
  const hub = new HubClient("https://hub.test", "tok");
  const send = (budget?: boolean) => hub.sendBreaker("Buffer Tank", "close", "arm", "backup-gate", budget);
  const ok = { ok: true, detail: "ON (verified)", result: { ok: true } };

  // the flag goes out only when the caller asks
  let rec = stub(200, ok);
  await send();
  await send(false);
  assert.deepEqual(rec.sent, [{ circuit: "Buffer Tank", action: "close", source: "backup-gate" },
                              { circuit: "Buffer Tank", action: "close", source: "backup-gate" }], "no budget, no flag");
  rec = stub(200, ok);
  assert.deepEqual(await send(true), { ok: true, refused: false, detail: "ON (verified)" });
  assert.deepEqual(rec.sent, [{ circuit: "Buffer Tank", action: "close", source: "backup-gate", generator_budget: true }]);

  // a budget hold: the bridge's refusal, marked. It stays `refused` for anything that doesn't read the mark.
  const why = "house 6.3 kW + element 16.5 kW + margin 2.4 kW = 25.2 kW exceeds the 20.0 kW generator cap";
  stub(502, { ok: false, detail: why, result: { ok: false, refused: true, budget_held: true, status: 409 } });
  assert.deepEqual(await send(true), { ok: false, refused: true, detail: why, budgetHeld: true });

  // any other guard's refusal is not a hold
  stub(502, { ok: false, detail: "refused: minimum off time", result: { ok: false, refused: true, status: 409 } });
  assert.deepEqual(await send(true), { ok: false, refused: true, detail: "refused: minimum off time" });
  // a verified close never reads as held, whatever the result says
  stub(200, { ok: true, detail: "ON (verified)", result: { ok: true, budget_held: true } });
  assert.equal((await send(true)).budgetHeld, undefined);
  // nor does a dead link
  globalThis.fetch = (async () => { throw new Error("socket hang up"); }) as typeof fetch;
  assert.deepEqual(await send(true), { ok: false, refused: false, detail: "socket hang up" });

  // the path as index.ts walks it: one assessment tells the gate whether it may close and sets the flag, so the gate
  // sends nothing on the generator (owner, 2026-11-02) and no flag on the grid
  const NOW = Date.UTC(2026, 11, 1, 12);
  const pumps = [{ id: "pump1", online: true, state: "heating" }, { id: "pump2", online: true, state: "heating" }];
  const comfort = { at_risk: true, coldest: null, why: "cold" };
  const on = (supply: Supply, houseW: number) => assess({ nowMs: NOW, supply, houseW, relay: "OPEN", pumpsEngaged: 2, comfort });
  const firstEvent = (gate: BackupGate, g: GenAssessment) => {
    for (let m = 0; m <= 45; m += 5) {
      const events = gate.step({ nowMs: NOW + m * 60_000, tankF: 97, tankTargetF: 120, stagesCalled: [true, true], pumps, relay: "OPEN",
                                 generator: { allowed: g.element_allowed, why: g.element_why } });
      if (events.length) return events[0];
    }
    throw new Error("the floor rule never fired");
  };
  const generator = on({ supply: "generator", why: "National Grid reports an outage (6bb feed)" }, 1_000);
  const held = new BackupGate("live", true);
  assert.equal(firstEvent(held, generator).kind, "generator_lockout", "a load that fits changes nothing");
  assert.equal(held.pendingAction, null, "no command, so no flag");
  const grid = on({ supply: "grid", why: "no outage" }, 6_300);
  assert.equal(firstEvent(new BackupGate("live", true), grid).kind, "close");
  rec = stub(200, ok);
  await hub.sendBreaker("Buffer Tank", "close", "arm", "backup-gate", piBudgetCheck("close", grid));
  assert.equal("generator_budget" in (rec.sent[0] as object), false, "on the grid the Pi is not asked");

  // the backstop: should a flagged close ever go out, the Pi's hold lands in the gate as the generator rule
  const gate = new BackupGate("live", true);
  assert.equal(firstEvent(gate, grid).kind, "close");
  stub(502, { ok: false, detail: why, result: { ok: false, refused: true, budget_held: true, status: 409 } });
  const r = await send(true);
  const { page, lockout } = gate.applied(r.ok, NOW, r.refused, r.budgetHeld ? r.detail : null);
  assert.equal(page, false, "no 'could not close' page");
  assert.equal(lockout?.kind, "generator_lockout");
  const s = gate.status(NOW) as Record<string, unknown>;
  assert.equal(s.stand_down, null);
  assert.match(String(s.generator_lockout), /25\.2 kW exceeds the 20\.0 kW generator cap/);

  globalThis.fetch = realFetch;
  console.log("hub-breaker.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
