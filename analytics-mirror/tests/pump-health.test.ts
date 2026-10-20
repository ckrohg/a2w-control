// @purpose node:assert suite for lib/pump-health.ts: the card's view of the planner's /health.pump_health. The sample
// is the shape planner/src/pumphealth.ts serves (PumpHealthWatch.status() + the daily rollup), with values from the real
// 2026-10-18 replay (pump1's 83-min stuck defrost). Pins: a tripped shadow check shows as a flag; a gated planner says
// "not evaluated", never "normal"; a planner without the block → unavailable; drift + twin pass through; junk is
// tolerated. Run: npx tsx tests/pump-health.test.ts
import assert from "node:assert/strict";
import { pumpHealthView, pumpChip } from "../lib/pump-health";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const ok = (reason = "fine") => ({ state: "ok", open: false, reason, metrics: {} });
const sample = {
  enabled: true, live_checks: [], live_error: null, span_circuits: { pump1: "Air-Water 1", pump2: "Air-Water 2" },
  evaluated_at: "2026-10-18T02:40:01.000Z", gate: null, error: null,
  checks: {
    pump1: {
      running_no_lift: ok("not heating steadily for 20 min"), heating_no_draw: ok(), idle_draw: ok(),
      defrost_overlong: { state: "tripped", open: true, reason: "reports defrost continuously for 33 min (normal 4–9 min; the unit's max defrost setting caps at 20)", metrics: { defrost_min: 33 } },
      called_tank_flat: { state: "unknown", open: false, reason: "HBX readings do not cover 45 min", metrics: {} },
    },
    pump2: { running_no_lift: ok(), heating_no_draw: ok(), idle_draw: ok(), defrost_overlong: ok(), called_tank_flat: ok() },
  },
  daily: {
    through_day: "2026-10-17",
    days: [
      { pump: "pump1", kwh: 26.04, kwh_heating: 24.9, run_h: 6.33, starts: 15, max_starts_60min: 2, defrosts: 3, defrost_min: 90.7, longest_defrost_min: 83, mean_dt_c: 4.12, mean_ambient_c: 7.9, lift_index: 0.76, bins: {} },
      { pump: "pump2", kwh: 0.92, kwh_heating: 0, run_h: 0, starts: 0, max_starts_60min: 0, defrosts: 0, defrost_min: 0, longest_defrost_min: 0, mean_dt_c: null, mean_ambient_c: 7.3, lift_index: null, bins: {} },
    ],
    trend: { pumps: { pump1: { lift_drift: { bin: "5", pct: -4.1, cur_run_h: 9.2, base_run_h: 12 }, flags: [] }, pump2: { lift_drift: null, flags: [] } }, twin: null, twin_flag: false },
  },
};

t("the stuck defrost shows as a shadow flag on pump1; pump2 normal", () => {
  const v = pumpHealthView(sample);
  assert.equal(v.available, true);
  assert.deepEqual(v.pumps.map((p) => p.id), ["pump1", "pump2"]);
  const p1 = v.pumps[0];
  assert.deepEqual(p1.tripped.map((c) => c.check), ["defrost_overlong"]);
  assert.deepEqual(pumpChip(p1, v.gate), { cls: "warn", text: "1 flag" });
  assert.deepEqual(pumpChip(v.pumps[1], v.gate), { cls: "ok", text: "normal" });
  assert.equal(p1.day!.kwh, 26.04); assert.equal(p1.day!.drift_pct, -4.1); assert.equal(p1.day!.drift_bin, "5");
  assert.equal(v.throughDay, "2026-10-17");
  assert.deepEqual(v.liveChecks, []);
});

t("a gated planner (Pi disconnected) is 'not evaluated', never 'normal'", () => {
  const v = pumpHealthView({ ...sample, gate: "Pi disconnected from the hub — cannot verify I1", checks: { pump2: sample.checks.pump2 } });
  assert.deepEqual(pumpChip(v.pumps.find((p) => p.id === "pump2")!, v.gate), { cls: "offline", text: "not evaluated" });
  const allUnknown = pumpHealthView({ ...sample, checks: { pump2: { idle_draw: { state: "unknown", open: false, reason: "stale" } } } });
  assert.equal(pumpChip(allUnknown.pumps.find((p) => p.id === "pump2")!, null).text, "not evaluated");
});

t("an open episode still flags while its latest verdict is unknown (a blind spell does not clear it)", () => {
  const v = pumpHealthView({ ...sample, checks: { pump1: { idle_draw: { state: "unknown", open: true, reason: "SPAN samples do not cover the window" } } } });
  assert.equal(pumpChip(v.pumps[0], null).text, "1 flag");
});

t("daily flags and the twin pass through", () => {
  const s = JSON.parse(JSON.stringify(sample));
  s.daily.trend.pumps.pump2.flags = ["short_cycling"];
  s.daily.trend.twin = { bin: "0", pct: -22.5, cur_run_h: 3, base_run_h: 6, pumps: ["pump1", "pump2"] };
  s.daily.trend.twin_flag = true;
  const v = pumpHealthView(s);
  assert.deepEqual(pumpChip(v.pumps[1], null), { cls: "warn", text: "short cycling" });
  assert.deepEqual(v.twin, { pct: -22.5, bin: "0", flag: true });
});

t("older planner / junk → unavailable or tolerated", () => {
  assert.equal(pumpHealthView(null).available, false);
  assert.equal(pumpHealthView("nope").available, false);
  const v = pumpHealthView({ checks: { pump1: { idle_draw: "garbage", heating_no_draw: { state: 7 } } }, daily: { days: [1, null] } });
  assert.equal(v.available, true);
  assert.deepEqual(v.pumps[0].checks.map((c) => [c.check, c.state]), [["heating_no_draw", "unknown"]]);
  assert.equal(v.pumps[0].day, null);
});

console.log(`pump-health: ${n} passed`);
