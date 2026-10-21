/**
 * @purpose Phase B's plan lead is the auto-pilot's COMMAND for the block in force (#220 commandForBlock), not
 * block.tank_target_f — identification-plan-vs-command-2026-10-20.md §5 item 1. The live case: the 2026-10-19 19:04 ET
 * "winter guard: mimic HBX curve" block said 135 °F, the auto-pilot wrote its 120/118 shaped curve (119.6 °F at 49 °F),
 * and Phase B led both pumps to 135 + 5 → 60 °C while the plant sat at 120 °F. Pure planLeadF cases first, then runOnce
 * end to end: the winter-guard hour sends 52 °C in shaped mode and 60 °C in flat mode (byte-identical to before); an
 * excursion in force (the soak) is led exactly as before; a curve hour AHEAD of a bank is led at the next block's
 * outdoor (decision b); an excursion ahead is NOT led early (decision c); the exact curve output leads, not the
 * resolver's rounding; the stale-high report and the probe target still win the max.
 */
import assert from "node:assert/strict";
import { PhaseB, planLeadF, computeTracking } from "./phaseb";
import { curveOutputF } from "./curve";

const fToC = (f: number) => ((f - 32) * 5) / 9;
const sendsFor = (targetF: number) => computeTracking(targetF, ["p"])[0].value_c;

const CURVE = { dot: 29, wwsd: 125, dbt: 120, mbt: 118 };               // the 2026-10-19 stamped curve
const STEEP = { dot: 5, wwsd: 125, dbt: 135, mbt: 118 };                // a winter curve
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const nextHour = new Date(Date.now() + 3_600_000).toISOString();
const guard = { ts: hourAgo, tank_target_f: 135, outdoor_f: 48.8, reason: "winter guard: mimic HBX curve", shaped_curve: CURVE };
const floor = { ts: hourAgo, tank_target_f: 120, outdoor_f: 48.8, reason: "DHW window floor", shaped_curve: CURVE };
const soak = { ts: hourAgo, tank_target_f: 140, outdoor_f: 52, reason: "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)", sani: true, shaped_curve: CURVE };
const bank = { ts: hourAgo, tank_target_f: 128, outdoor_f: 52, reason: "afternoon bank to 128°F (warmest hour, 52°F outdoor)", bank: true, shaped_curve: CURVE };

function harness(opts: { plan: any[]; targetF?: number; outdoorF?: number | null; deviceCurve?: Record<string, number> | null; shaped?: boolean; probeF?: number | null }) {
  const sends: Array<{ pump: string; c: number }> = [];
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), targetF: opts.targetF ?? 119.7, outdoorF: opts.outdoorF === undefined ? 49 : opts.outdoorF, tankF: 121 }),
    recentPlans: async () => [{ computedAt: new Date(), plan: opts.plan }],
    insertPhaseBLog: async () => {},
    latestConfig: async () => opts.deviceCurve === undefined ? CURVE : opts.deviceCurve,
  } as any;
  const hub = { sendSetpoint: async (pump: string, c: number) => { sends.push({ pump, c }); return { ok: true, detail: "" }; }, getState: async () => ({ pumps: [] }) } as any;
  const pb = new PhaseB(store, hub, ["pump1", "pump2"], false, async () => {}, opts.shaped ?? true, async () => true);
  if (opts.probeF !== undefined) pb.setProbeTarget(opts.probeF);
  return { pb, sends };
}

(async () => {
  const now = Date.now();
  // ── planLeadF, pure ───────────────────────────────────────────────────────────────────────────────────────────────
  // 1. the live block: shaped mode leads the curve's output at the live outdoor (basis curve), flat mode the declared 135
  {
    const out = curveOutputF(CURVE, 49);
    assert.ok(out > 119.5 && out < 119.7, `119.58 at 49 °F, got ${out}`);
    const lead = planLeadF([guard], now, 49, true);
    assert.equal(lead.basis, "curve");
    assert.equal(lead.nowF, 120, "the resolver's rounded 120 is ≥ the exact 119.58, so 120 leads");
    assert.equal(lead.declaredF, 135, "the declared target rides along for /health");
    assert.equal(lead.nextF, null); assert.equal(lead.nextOutdoorF, null);
    assert.deepEqual(planLeadF([guard], now, 49, false), { nowF: 135, basis: "flat", declaredF: 135, nextF: null, nextOutdoorF: null }, "flat mode is the old lead");
  }
  // 2. an excursion in force is its flat target in both modes — by flag and by the legacy reason regex
  {
    for (const b of [soak, bank, { ...guard, boost: true, tank_target_f: 129 }, { ...guard, storm: true, tank_target_f: 135 }, { ...guard, reason: "pre-boost to 129°F for 08:00 window", tank_target_f: 129 }]) {
      assert.deepEqual(planLeadF([b], now, 49, true).nowF, b.tank_target_f, b.reason);
      assert.equal(planLeadF([b], now, 49, true).basis, "flat");
    }
  }
  // 3. the next block: a curve hour ahead leads its curve at ITS forecast outdoor (b); an excursion ahead is not led (c)
  {
    const cold = { ...guard, ts: nextHour, outdoor_f: 20, shaped_curve: STEEP };
    const lead = planLeadF([bank, cold], now, 49, true);
    assert.equal(lead.nowF, 128, "the bank in force leads flat");
    assert.equal(lead.nextOutdoorF, 20);
    assert.equal(lead.nextF, Math.max(133, curveOutputF(STEEP, 20)), "the steep curve's 132.9 at 20 °F → 133 leads an hour ahead");
    assert.equal(planLeadF([floor, { ...soak, ts: nextHour }], now, 49, true).nextF, null, "a soak ahead is not led early");
    assert.equal(planLeadF([floor, { ...bank, ts: nextHour }], now, 49, true).nextF, null, "a bank ahead is not led early");
    assert.equal(planLeadF([bank, cold], now, 49, false).nextF, null, "flat mode: no next-block lead (the device curve lead is unchanged)");
    assert.equal(planLeadF([floor, { ...cold, outdoor_f: undefined }], now, 49, true).nextF, Math.max(129, curveOutputF(STEEP, 49)), "a next block without a forecast outdoor is evaluated at the live one");
  }
  // 4. outdoor fallbacks: no live reading → the block's forecast outdoor; none at all on a curve hour → the declared target
  {
    const l = planLeadF([guard], now, null, true);
    assert.equal(l.basis, "curve"); assert.equal(l.nowF, Math.max(120, curveOutputF(CURVE, 48.8)));
    const d = planLeadF([{ ...guard, outdoor_f: undefined }], now, null, true);
    assert.deepEqual([d.nowF, d.basis], [135, "declared"], "nothing to evaluate at → the declared target leads (over, never under)");
    assert.deepEqual(planLeadF([{ ...guard, tank_target_f: undefined }], now, 49, true), { nowF: null, basis: null, declaredF: null, nextF: null, nextOutdoorF: null }, "no finite tank_target_f → nothing (the auto-pilot refuses the block)");
    assert.deepEqual(planLeadF([], now, 49, true), { nowF: null, basis: null, declaredF: null, nextF: null, nextOutdoorF: null });
    assert.deepEqual(planLeadF(null, now, 49, true), { nowF: null, basis: null, declaredF: null, nextF: null, nextOutdoorF: null });
    assert.equal(planLeadF([{ ...guard, tank_target_f: "135" }], now, 49, false).nowF, 135, "a stringly target still counts");
  }
  // 5. the exact curve output leads, not the resolver's whole-°F rounding: 126.3 °F → 131.3 required → 56 °C; the rounded
  //    126 would send 55 °C = 131.0 °F, an I1 refusal at the zero-slack point (ceil-to-°C has no slack at 126 °F)
  {
    const zero = { ...guard, shaped_curve: { dot: 20, wwsd: 70, dbt: 130, mbt: 120 } };
    assert.equal(curveOutputF(zero.shaped_curve, 38.5), 126.3);
    const lead = planLeadF([zero], now, 38.5, true);
    assert.equal(lead.nowF, 126.3);
    assert.equal(sendsFor(126.3), 56); assert.equal(sendsFor(126), 55);
    assert.ok(55 * 9 / 5 + 32 < 126.3 + 5, "55 °C = 131.0 °F would sit under the 131.3 °F the I1 cross-check requires");
  }

  // ── runOnce, end to end ───────────────────────────────────────────────────────────────────────────────────────────
  // 6. the winter-guard hour: shaped mode sends 52 °C (the plant is at 120); flat mode sends the old 60 °C
  {
    const h = harness({ plan: [guard, { ...guard, ts: nextHour, outdoor_f: 44 }] });
    await h.pb.runOnce();
    assert.deepEqual(h.sends, [{ pump: "pump1", c: 52 }, { pump: "pump2", c: 52 }]);
    assert.equal(sendsFor(135), 60, "what the declared target sent");
    assert.equal(h.pb.lastLead?.plan_basis, "curve");
    assert.equal(h.pb.lastLead?.plan_f, 120); assert.equal(h.pb.lastLead?.plan_declared_f, 135);
    assert.equal(h.pb.lastLead?.effective_f, 120); assert.equal(h.pb.lastLead?.operative_f, 119.7);
    assert.equal(h.pb.lastLead?.next_f, 120); assert.equal(h.pb.lastLead?.device_curve_f, 119.7, "the device curve's output at 49 / 44 °F, 0.1 °F");
    const flat = harness({ plan: [guard], shaped: false });
    await flat.pb.runOnce();
    assert.deepEqual(flat.sends.map((s) => s.c), [60, 60], "SHAPED_CURVE off or shadow: byte-identical to before");
    assert.equal(flat.pb.lastLead?.plan_basis, "flat");
  }
  // 7. an excursion in force is led exactly as before: the soak → 63 °C in both modes, the bank → 57 °C
  {
    for (const shaped of [true, false]) {
      const s = harness({ plan: [soak], shaped, deviceCurve: { dot: 29, wwsd: 125, dbt: 141, mbt: 137 } });
      await s.pb.runOnce();
      assert.deepEqual(s.sends.map((x) => x.c), [63, 63], `soak led to 140 + 5 → 63 °C (shaped=${shaped})`);
      assert.equal(s.pb.lastLead?.plan_basis, "flat");
      const b = harness({ plan: [bank], shaped, deviceCurve: { dot: 29, wwsd: 125, dbt: 129, mbt: 125 } });
      await b.pb.runOnce();
      assert.deepEqual(b.sends.map((x) => x.c), [57, 57], `bank led to 128 + 5 → 57 °C (shaped=${shaped})`);
    }
  }
  // 8. decision (b): a bank in force (the device on its flat 129/125 line) with a steep curve hour next at 20 °F — the
  //    next block's curve leads (133 + 5 → 59 °C); without it the device's flat line would have sent 57 °C and the
  //    set_curve at the top of the hour would wait on I1 for a cycle
  {
    const cold = { ...guard, ts: nextHour, outdoor_f: 20, shaped_curve: STEEP };
    const h = harness({ plan: [bank, cold], targetF: 128, deviceCurve: { dot: 29, wwsd: 125, dbt: 129, mbt: 125 } });
    await h.pb.runOnce();
    assert.deepEqual(h.sends.map((x) => x.c), [59, 59]);
    assert.equal(h.pb.lastLead?.next_f, 133); assert.equal(h.pb.lastLead?.plan_f, 128);
    assert.equal(sendsFor(129), 57, "the device's flat line alone");
  }
  // 9. decision (c): a curve hour with the soak next is NOT led early — 52 °C now; the soak is led once in force
  {
    const h = harness({ plan: [floor, { ...soak, ts: nextHour }] });
    await h.pb.runOnce();
    assert.deepEqual(h.sends.map((x) => x.c), [52, 52]);
    assert.equal(h.pb.lastLead?.next_f, null);
    const later = harness({ plan: [{ ...floor, ts: new Date(Date.now() - 7_200_000).toISOString() }, soak] });
    await later.pb.runOnce();
    assert.deepEqual(later.sends.map((x) => x.c), [63, 63], "…and in force it is led to 140 + 5 at once");
  }
  // 10. the other terms of the max are untouched: a stale-high report (139.9 after a soak) still leads 63 °C — the
  //     #215 class in Phase B, a follow-up, not this change; an identification probe at 130 leads 58 °C; the device's
  //     as-found curve (a refused set_curve) still leads its own output
  {
    const stale = harness({ plan: [guard], targetF: 139.9 });
    await stale.pb.runOnce();
    assert.deepEqual(stale.sends.map((x) => x.c), [63, 63]);
    assert.equal(stale.pb.lastLead?.operative_f, 139.9); assert.equal(stale.pb.lastLead?.effective_f, 139.9);
    const probe = harness({ plan: [guard], probeF: 130 });
    await probe.pb.runOnce();
    assert.deepEqual(probe.sends.map((x) => x.c), [58, 58]);
    assert.equal(probe.pb.lastLead?.probe_f, 130);
    const AS_FOUND = { dot: 30, wwsd: 125, dbt: 141, mbt: 137 };
    const asFound = harness({ plan: [guard, { ...guard, ts: nextHour, outdoor_f: 44 }], deviceCurve: AS_FOUND });
    await asFound.pb.runOnce();
    const atNext = curveOutputF(AS_FOUND, 44);
    assert.ok(atNext > curveOutputF(AS_FOUND, 49) && atNext > 140, `the as-found curve really is at ${atNext.toFixed(1)} °F at 44 °F`);
    assert.deepEqual(asFound.sends.map((x) => x.c), [sendsFor(atNext), sendsFor(atNext)], "the device is on the as-found curve (a refused set_curve): its output leads, at the colder next-hour outdoor");
    assert.equal(asFound.pb.lastLead?.device_curve_f, Math.round(atNext * 10) / 10);
    assert.equal(asFound.pb.lastLead?.plan_f, 120, "…while the plan's command is still 120");
  }
  // 11. no fresh report → no tracking, lastLead untouched; a plan read failure → the operative target and device curve still lead
  {
    const h = harness({ plan: [guard] });
    (h.pb as any).store.getLatestSlx = async () => null;
    await h.pb.runOnce();
    assert.deepEqual(h.sends, []); assert.equal(h.pb.lastLead, null);
    const broken = harness({ plan: [guard] });
    (broken.pb as any).store.recentPlans = async () => { throw new Error("db blip"); };
    await broken.pb.runOnce();
    assert.deepEqual(broken.sends.map((x) => x.c), [52, 52], "119.7 report / 119.6 device curve → 52 °C");
    assert.equal(broken.pb.lastLead?.plan_basis, null);
  }
  assert.equal(Math.ceil(fToC(125)), 52);
  console.log("phaseb-lead.test.ts (plan lead = the auto-pilot's command): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
