// @purpose node:assert suite for lib/boost-state.ts (#186): no success text before read-back;
// "commanded X °F · adopts on the next reheat cycle" → "in force"; planner rejections verbatim and
// classified; preflight warns on limits the planner enforces; estimates start from the CURRENT tank;
// #231 arming read-back, including the rate-limit wait (reason "rate_limit") that never claims warming.
// Run: npx tsx tests/boost-state.test.ts
import assert from "node:assert/strict";
import {
  boostView, boostChartSpan, chartShowsBoost, etHour, overlayBoost, classifyRejection, preflight, confirmText, estimateLines, pumpsLine, boostBody,
  type WriterStatus, type BoostPhase, type HubState,
} from "../lib/boost-state";

const NOW = Date.parse("2026-10-16T04:43:00Z"); // 12:43 AM ET, the incident's "Long shower" tap
const restore = new Date(NOW + 120 * 60_000).toISOString();
const req = { target_f: 132, minutes: 120 };
const accepted: BoostPhase = { phase: "accepted", req, atMs: NOW, restoreAt: restore };
const before: WriterStatus = { tank_f: 78, target_f: 120, commanded_target_f: 120, adoption_pending: false, band: { lo: 104, hi: 135 }, i1_margin_f: 5, active_boost: null };
const commanded: WriterStatus = { ...before, commanded_target_f: 133, adoption_pending: true, active_boost: { target_f: 132, restore_at: restore }, boost_superseded_by: null };
const inForce: WriterStatus = { ...commanded, target_f: 132, adoption_pending: false };
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const SUCCESS = /in force|commanded \d/;

t("idle with no boost on record says so — no success words", () => {
  const v = boostView({ phase: "idle" }, before, NOW);
  assert.equal(v.key, "idle");
  assert.ok(!SUCCESS.test(v.text));
});

t("sending is pending, no success text", () => {
  const v = boostView({ phase: "sending", req }, before, NOW);
  assert.equal(v.key, "sending");
  assert.ok(!SUCCESS.test(v.text));
});

t("accepted POST but read-back not showing it yet → verifying, NOT a confirmation", () => {
  const v = boostView(accepted, before, NOW + 5_000);
  assert.equal(v.key, "verifying");
  assert.equal(v.tone, "pending");
  assert.ok(!SUCCESS.test(v.text));
});

t("accepted POST, status unavailable → still verifying", () => {
  assert.equal(boostView(accepted, null, NOW + 5_000).key, "verifying");
});

t("read-back never shows it within 90 s → unconfirmed (bad), quoting what it does show", () => {
  const v = boostView(accepted, before, NOW + 91_000);
  assert.equal(v.key, "unconfirmed");
  assert.equal(v.tone, "bad");
  assert.match(v.text, /NOT confirmed/);
  assert.match(v.text, /no active boost, commanded 120 °F/);
});

t("read-back shows the boost row + curve, HBX not yet adopted → commanded · adopts on next reheat", () => {
  const v = boostView(accepted, commanded, NOW + 10_000);
  assert.equal(v.key, "commanded");
  assert.match(v.text, /^commanded 132 °F · adopts on the next reheat cycle \(HBX still on 120 °F\) · restores at 2:43 AM$/);
});

t("adoption_pending clears and operative lands → in force", () => {
  const v = boostView(accepted, inForce, NOW + 600_000);
  assert.equal(v.key, "in_force");
  assert.equal(v.tone, "ok");
  assert.equal(v.text, "in force: tank target 132 °F until 2:43 AM, then the curve restores");
});

t("adoption_pending false but operative still far → NOT in force", () => {
  const v = boostView(accepted, { ...commanded, adoption_pending: false, target_f: 120 }, NOW + 60_000);
  assert.equal(v.key, "commanded");
});

t("a different boost on record (other target) is not ours → verifying", () => {
  const other: WriterStatus = { ...commanded, active_boost: { target_f: 131, restore_at: restore } };
  assert.equal(boostView(accepted, other, NOW + 5_000).key, "verifying");
});

t("a boost with our target but another restore time is not ours", () => {
  const other: WriterStatus = { ...commanded, active_boost: { target_f: 132, restore_at: new Date(NOW + 30 * 60_000).toISOString() } };
  assert.equal(boostView(accepted, other, NOW + 5_000).key, "verifying");
});

t("commanded curve moved off the boost (auto-pilot wrote over it) → superseded, bad", () => {
  const v = boostView(accepted, { ...commanded, commanded_target_f: 121 }, NOW + 20 * 60_000);
  assert.equal(v.key, "superseded");
  assert.equal(v.tone, "bad");
  assert.match(v.text, /HBX curve now targets 121 °F/);
});

t("a NEARBY replacement write (132 → 135) is caught by the curve output (Codex pass 6)", () => {
  // operative already at 135 and adoption done: the old midpoint rule (±3) would have said "in force"
  const st: WriterStatus = { ...inForce, target_f: 135, commanded_target_f: 135, curve_in_force: { output_at_live_outdoor_f: 135 } };
  const v = boostView(accepted, st, NOW + 20 * 60_000);
  assert.equal(v.key, "superseded");
  assert.match(v.text, /now targets 135 °F/);
  // and the boost's own curve (output 132.4 after endpoint rounding) still confirms
  const own: WriterStatus = { ...inForce, curve_in_force: { output_at_live_outdoor_f: 132.4 } };
  assert.equal(boostView(accepted, own, NOW + 20 * 60_000).key, "in_force");
});

t("a later write stamp than ours is superseded even at the same target", () => {
  const ours = "2026-10-16T04:43:01.000Z";
  const p: BoostPhase = { ...accepted, seen: true, writeAt: ours } as BoostPhase;
  assert.equal(boostView(p, { ...inForce, last_write_at: ours }, NOW + 60_000).key, "in_force");
  const v = boostView(p, { ...inForce, last_write_at: "2026-10-16T05:01:00.000Z" }, NOW + 20 * 60_000);
  assert.equal(v.key, "superseded");
  assert.match(v.text, /written again at 1:01 AM/);
  // a planner restart nulls last_write_at — not evidence either way
  assert.equal(boostView(p, { ...inForce, last_write_at: null }, NOW + 60_000).key, "in_force");
});

t("seen, then the row disappears and the curve moved off → ended, quoting the new commanded target", () => {
  const v = boostView({ ...accepted, seen: true } as BoostPhase, before, NOW + 121 * 60_000);
  assert.equal(v.key, "ended");
  assert.equal(v.text, "boost to 132 °F ended — commanded target is now 120 °F");
  assert.ok(!/restored the curve/.test(v.text));
});

t("seen, row gone at expiry but commanded still on the boost → restore NOT confirmed (Codex pass 1)", () => {
  const v = boostView({ ...accepted, seen: true } as BoostPhase, { ...inForce, active_boost: null }, NOW + 121 * 60_000);
  assert.equal(v.key, "expired_unrestored");
  assert.equal(v.tone, "pending");
  assert.match(v.text, /restore is not confirmed yet/);
});

t("a stale read-back never reads as in force (Codex pass 1: hung polls)", () => {
  const v = boostView(accepted, inForce, NOW + 600_000, NOW + 600_000 - 91_000);
  assert.equal(v.key, "stale");
  assert.equal(v.tone, "pending");
  assert.match(v.text, /^writer status not refreshed for 2 min — last read-back said: in force/);
  assert.equal(boostView(accepted, inForce, NOW + 600_000, NOW + 600_000 - 89_000).key, "in_force");
  assert.equal(boostView({ phase: "rejected", req, status: 429, error: "rate limited" }, inForce, NOW, NOW - 600_000).key, "rejected");
});

t("never seen and the row is absent past the timer → unconfirmed, not ended", () => {
  assert.equal(boostView(accepted, before, NOW + 121 * 60_000).key, "unconfirmed");
});

t("page reload while a boost is on record → idle phase reads it back", () => {
  assert.equal(boostView({ phase: "idle" }, commanded, NOW).key, "commanded");
  assert.equal(boostView({ phase: "idle" }, inForce, NOW).key, "in_force");
});

t("planner rejections are shown verbatim, labelled as rejections", () => {
  const i1 = "I1 conflict: pump1 at 125.6°F < 137°F; pump2 at 125.6°F < 137°F — raise pump setpoint(s) first or pick a lower target";
  const v = boostView({ phase: "rejected", req, status: 409, error: i1 }, before, NOW);
  assert.equal(v.key, "rejected");
  assert.equal(v.tone, "bad");
  assert.equal(v.text, `Refused by the I1 check: ${i1}`);
  assert.equal(classifyRejection(429, "rate limited: one HBX write per 15 min (restore is always allowed)").kind, "rate_limit");
  assert.equal(classifyRejection(422, "target 140°F outside the I4 envelope [104–135]°F at 50°F outdoor").kind, "envelope");
  assert.equal(classifyRejection(422, "minutes must be 15–120").kind, "invalid");
  assert.equal(classifyRejection(503, "Pi disconnected — cannot verify I1").kind, "pi_state");
  assert.equal(classifyRejection(423, "refused: this instance does not hold the single-writer lease").kind, "lease");
  assert.equal(classifyRejection(502, "planner unreachable").kind, "unreachable");
  assert.equal(classifyRejection(0, "network error").kind, "network");
  assert.equal(classifyRejection(500, "").text, "HTTP 500");
});

t("preflight: minutes over 120, target over cap, outside I4, I1 offenders", () => {
  const hub: HubState = { pi_connected: true, ts: NOW / 1000 - 30, pumps: [
    { id: "pump1", name: "HP1", online: true, setpoint_c: 52 }, { id: "pump2", name: "HP2", online: true, setpoint_c: 61 }] };
  const w = preflight({ target_f: 136, minutes: 240 }, { ...before, band: { lo: 104, hi: 124 } }, hub, NOW / 1000);
  assert.ok(w.some((x) => /240 min is outside the planner's 15–120 min/.test(x)));
  assert.ok(w.some((x) => /above the 135 °F everyday cap/.test(x)));
  assert.ok(w.some((x) => /outside the planner's I4 envelope right now \(104–124 °F\)/.test(x)));
  assert.ok(w.some((x) => /^I1: HP1 setpoint 125\.6 °F is below 141 °F/.test(x)));
  assert.ok(!w.some((x) => /HP2/.test(x))); // 61 °C = 141.8 °F clears 136 + 5
  // #231: low setpoints are no longer a refusal — the planner warms the heat pumps first
  const i1 = w.find((x) => x.startsWith("I1:"))!;
  assert.match(i1, /warm the heat pumps up first and start the boost when they reach 141 °F \(it gives up after 20 min\)/);
  assert.doesNotMatch(i1, /refuse/);
});

// ── #231: the 202 "arming" read-back ───────────────────────────────────────────────────────────────────────────
const arming: BoostPhase = { phase: "arming", req: { target_f: 135, minutes: 60 }, atMs: NOW, setpointsNeededF: 140, expiresAt: new Date(NOW + 20 * 60_000).toISOString() };
const pendingSt: WriterStatus = { ...before, pending_boost: { target_f: 135, minutes: 60, setpoints_needed_f: 140, requested_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 20 * 60_000).toISOString() } };

t("arming: worded for the household, pending, not a success and not drawn", () => {
  const v = boostView(arming, pendingSt, NOW + 5_000);
  assert.equal(v.key, "arming");
  assert.equal(v.tone, "pending");
  assert.equal(v.text, "Warming up the heat pumps first, the boost starts when they reach 140 °F");
  assert.ok(!SUCCESS.test(v.text));
  assert.equal(chartShowsBoost(v), false);
  assert.equal(boostView(arming, null, NOW + 5_000).key, "arming", "no read-back yet: the 202 answer stands");
  assert.equal(boostView({ phase: "idle" }, pendingSt, NOW).key, "arming", "a page reload while arming reads it back");
});

t("arming → the boost lands: the read-back shows it commanded (between sending and commanded)", () => {
  const landed: WriterStatus = { ...commanded, commanded_target_f: 135, active_boost: { target_f: 135, restore_at: new Date(NOW + 70 * 60_000).toISOString() }, pending_boost: null,
    pending_boost_ended: { target_f: 135, outcome: "landed", detail: "written", at: new Date(NOW + 600_000).toISOString() } };
  const v = boostView(arming, landed, NOW + 600_000);
  assert.equal(v.key, "commanded");
  assert.match(v.text, /^commanded 135 °F · adopts on the next reheat cycle/);
  // landed but the active_boost row not in this read yet → still verifying, never "not started"
  assert.equal(boostView(arming, { ...landed, active_boost: null }, NOW + 600_000).key, "verifying");
});

t("arming → it never started: expired / cancelled / refused / planner restarted — said plainly, tank unchanged", () => {
  const ended = (outcome: "expired" | "replaced" | "refused", detail = "x"): WriterStatus => ({ ...before, pending_boost: null,
    pending_boost_ended: { target_f: 135, outcome, detail, at: new Date(NOW + 20 * 60_000).toISOString() } });
  const exp = boostView(arming, ended("expired"), NOW + 21 * 60_000);
  assert.equal(exp.key, "not_started"); assert.equal(exp.tone, "bad");
  assert.equal(exp.text, "The heat pumps did not warm up within 20 minutes, so the boost did not start. The tank was not changed.");
  assert.equal(boostView(arming, ended("replaced"), NOW + 60_000).tone, "neutral");
  assert.match(boostView(arming, ended("refused", "target 135°F outside the I4 envelope"), NOW + 60_000).text, /refused the boost: target 135°F outside/);
  const gone = boostView(arming, before, NOW + 60_000);
  assert.equal(gone.key, "not_started"); assert.match(gone.text, /may have restarted/);
});

t("arming inside the rate-limit window (owner 2026-11-02): waits, and never claims the heat pumps are warming", () => {
  const WAIT = "Waiting a few minutes for the last heating change to settle, the boost starts after that";
  const waiting: BoostPhase = { ...arming, reason: "rate_limit" } as BoostPhase;
  const waitSt: WriterStatus = { ...pendingSt, pending_boost: { ...pendingSt.pending_boost!, reason: "rate_limit" } };
  for (const v of [boostView(waiting, waitSt, NOW + 5_000), boostView(waiting, null, NOW + 5_000), boostView({ phase: "idle" }, waitSt, NOW)]) {
    assert.equal(v.key, "arming"); assert.equal(v.tone, "pending");
    assert.equal(v.text, WAIT);
    assert.doesNotMatch(v.text, /warm/i);
    assert.equal(chartShowsBoost(v), false);
  }
  // a setpoints boost whose pumps are now covered but the window holds: the planner's reason wins over the 202's
  assert.equal(boostView(arming, waitSt, NOW + 600_000).text, WAIT);
  assert.match(boostView(arming, { ...pendingSt, pending_boost: { ...pendingSt.pending_boost!, reason: "setpoints" } }, NOW + 5_000).text, /^Warming up the heat pumps first/);
  // how a rate-limit wait ends: no warming claim either
  const ended = (outcome: "expired" | "refused" | "landed"): WriterStatus => ({ ...before, pending_boost: null,
    pending_boost_ended: { target_f: 135, outcome, detail: "x", at: new Date(NOW + 20 * 60_000).toISOString() } });
  for (const o of ["expired", "refused", "landed"] as const) assert.doesNotMatch(boostView(waiting, ended(o), NOW + 21 * 60_000).text, /warm/i, o);
  assert.match(boostView(waiting, ended("expired"), NOW + 21 * 60_000).text, /could not start within 20 minutes.*The tank was not changed/);
});

t("preflight: stale Pi state is called out (the planner refuses I1 on it)", () => {
  const w = preflight(req, before, { pi_connected: false, ts: NOW / 1000 - 3600, pumps: [] }, NOW / 1000);
  assert.ok(w.some((x) => /not live/.test(x)));
});

t("preflight: a clean request gives no warnings", () => {
  const hub: HubState = { pi_connected: true, ts: NOW / 1000 - 30, pumps: [{ id: "pump1", online: true, setpoint_c: 60 }] };
  assert.deepEqual(preflight(req, before, hub, NOW / 1000), []);
});

t("confirm text states exactly what is written", () => {
  const c = confirmText(boostBody(132.4, 120), NOW);
  assert.match(c, /^Writes POST \/api\/hbx\/boost \{"target_f": 132, "minutes": 120\}/);
  assert.match(c, /at about 2:43 AM \(2 h from now\)/);
  assert.match(c, /adopts the new target only at its next reheat cycle/);
});

t("estimates start from the CURRENT tank; the boosted one is labelled 'if the boost completes'", () => {
  const e = estimateLines(78, 132);
  assert.equal(e.now, "now (tank 78 °F): ≈ 0 gal of hot water · about 0 min of showers");
  assert.equal(e.ifCompletes, "if the boost completes (tank at 132 °F): ≈ 75 gal · about 38 min of showers");
  assert.match(estimateLines(null, 132).now, /unavailable/);
});

t("pumps line: live, none heating, stale", () => {
  const live: HubState = { pi_connected: true, ts: NOW / 1000 - 20, pumps: [{ id: "pump1", name: "HP1", online: true, state: "heating" }, { id: "pump2", name: "HP2", online: true, state: "idle" }] };
  assert.equal(pumpsLine(live, NOW / 1000), "HP1 heating · HP2 idle");
  const none: HubState = { ...live, pumps: [{ id: "pump1", name: "HP1", online: true, state: "idle" }, { id: "pump2", name: "HP2", online: false, state: "heating" }] };
  assert.equal(pumpsLine(none, NOW / 1000), "HP1 idle · HP2 offline — no pump is heating");
  assert.equal(pumpsLine({ ...live, pi_connected: false, ts: NOW / 1000 - 1500 }, NOW / 1000), "last known (25 min old, Pi disconnected): HP1 heating · HP2 idle");
  assert.equal(pumpsLine(null, NOW / 1000, "hub not configured"), "pump state unavailable (hub not configured)");
});

t("chart span is in Eastern hours and ends with the timer (Codex pass 1)", () => {
  assert.equal(etHour(Date.parse("2026-10-16T04:43:00Z")), 0); // 12:43 AM EDT
  assert.equal(etHour(Date.parse("2026-01-16T04:43:00Z")), 23); // 11:43 PM EST
  // boost tapped at 12:43 AM for 2 h → restores 2:43 AM → blocks 0, 1, 2
  assert.deepEqual(boostChartSpan(NOW, restore), { start: 0, hours: 3 });
  // an hour later the start moves with the clock and the end stays put
  assert.deepEqual(boostChartSpan(NOW + 3_600_000, restore), { start: 1, hours: 2 });
});

t("an unchanged cached 'in force' read-back expires at restore_at (Codex pass 3)", () => {
  const end = Date.parse(restore);
  assert.equal(boostView(accepted, inForce, end - 1_000, end - 30_000).key, "in_force");
  const v = boostView(accepted, inForce, end + 1_000, end - 30_000);
  assert.equal(v.key, "expired_unrestored");
  assert.match(v.text, /ended at 2:43 AM — waiting for the writer status to show the restore/);
  assert.equal(boostView({ phase: "idle" }, inForce, end + 1_000, end - 30_000).key, "expired_unrestored");
  assert.equal(boostChartSpan(end + 1_000, restore), null);
});

t("chart overlay replaces the target for the span, even below the plan (Codex pass 5)", () => {
  const plan = Array.from({ length: 24 }, () => 135);
  const out = overlayBoost(plan, { start: 23, hours: 2, target: 132 });
  assert.equal(out[23], 132);
  assert.equal(out[0], 132); // wraps past midnight
  assert.equal(out[1], 135);
  assert.equal(plan[23], 135); // input untouched
  assert.deepEqual(overlayBoost(plan, null), plan);
});

t("DB says the curve was written after the boost → superseded, even a 1 °F neighbour after reload (Codex pass 7)", () => {
  // 132 → 133 replacement: curve output 133 is within rounding of 132, operative at 133, no writeAt (reload)
  const st: WriterStatus = { ...inForce, target_f: 133, commanded_target_f: 133, curve_in_force: { output_at_live_outdoor_f: 133 },
    boost_superseded_by: { at: "2026-10-16T05:05:00Z", by: "autopilot set_target" } };
  const v = boostView({ phase: "idle" }, st, NOW + 30 * 60_000);
  assert.equal(v.key, "superseded");
  assert.equal(v.text, "boost to 132 °F is on record until 2:43 AM, but the HBX curve was written again at 1:05 AM by autopilot set_target — another write replaced it");
});

t("DB answer unavailable → never green, says it could not check", () => {
  const { boost_superseded_by: _drop, ...noDb } = inForce;
  const v = boostView(accepted, noDb, NOW + 60_000);
  assert.equal(v.key, "unverified");
  assert.equal(v.tone, "pending");
  assert.match(v.text, /could not check for later writes, so not confirmed/);
  assert.equal(chartShowsBoost(v), false); // Codex pass 8: not drawn either
});

t("chart eligibility: only commanded / in force", () => {
  assert.equal(chartShowsBoost(boostView(accepted, commanded, NOW + 10_000)), true);
  assert.equal(chartShowsBoost(boostView(accepted, inForce, NOW + 600_000)), true);
  assert.equal(chartShowsBoost(boostView(accepted, { ...commanded, commanded_target_f: 121 }, NOW + 10_000)), false); // superseded
  assert.equal(chartShowsBoost(boostView(accepted, inForce, NOW + 600_000, NOW)), false); // stale
  assert.equal(chartShowsBoost(boostView(accepted, before, NOW + 5_000)), false); // verifying
});

console.log(`boost-state: ${n} passed`);
