/**
 * @purpose The pure house-alarm evaluators (housealarms.ts): freeze risk holds through its hysteresis band instead of
 * paging and clearing every poll, the DHW shortfall needs a full streak and resets on a recovered tank, and the
 * backup-element call fires only on its edges. A null reading changes nothing anywhere.
 */
import assert from "node:assert/strict";
import {
  BACKUP_INITIAL, DHW_INITIAL, DHW_SHORTFALL_F, DHW_SHORTFALL_POLLS, FREEZE_INITIAL, FREEZE_TANK_F,
  evalBackupCalled, evalDhwShortfall, evalFreezeRisk, type AlarmAction,
} from "./housealarms";

/** Run a sequence through an evaluator from `init`; the actions in order plus the final state. */
function run<S, R>(ev: (s: S, r: R) => { state: S; action: AlarmAction }, init: S, readings: R[]) {
  let state = init;
  const actions: AlarmAction[] = [];
  for (const r of readings) { const n = ev(state, r); state = n.state; actions.push(n.action); }
  return { state, actions, opens: actions.filter((a) => a === "open").length, clears: actions.filter((a) => a === "clear").length };
}
const freeze = (outdoor: (number | null)[], tankF: number | null = 100) =>
  run(evalFreezeRisk, FREEZE_INITIAL, outdoor.map((outdoorF) => ({ outdoorF, tankF })));

// ── freeze risk ──────────────────────────────────────────────────────────────────────────────────────────────
{
  // the bug: outdoor hovering 5 ↔ 6 °F on a design-cold night paged and cleared every poll
  const r = freeze([5, 6, 5, 6, 5]);
  assert.deepEqual(r.actions, ["open", null, null, null, null]);
  assert.equal(r.opens, 1, "opens exactly once");
  assert.equal(r.clears, 0, "never clears inside the band");
  assert.equal(r.state.open, true);
}
{
  // the raise thresholds are unchanged
  assert.equal(freeze([6]).opens, 0, "6 °F out is not freeze risk");
  assert.equal(freeze([5], FREEZE_TANK_F).opens, 0, "a 105 °F tank is not low");
  assert.equal(freeze([5], FREEZE_TANK_F - 0.1).opens, 1);
}
{
  // outdoor clears only past 8 °F (5 + 3): 8 holds, 8.1 clears
  assert.deepEqual(freeze([2, 7, 8]).actions, ["open", null, null]);
  assert.deepEqual(freeze([2, 8.1]).actions, ["open", "clear"]);
}
{
  // tank clears only at 110 °F (105 + 5), however cold it is out
  const at = (tanks: number[]) => run(evalFreezeRisk, FREEZE_INITIAL, tanks.map((tankF) => ({ outdoorF: 0, tankF }))).actions;
  assert.deepEqual(at([100, 105, 109.9]), ["open", null, null], "the tank back at 105–110 holds it open");
  assert.deepEqual(at([100, 110]), ["open", "clear"]);
}
{
  // after a clear it can open again, once
  const r = freeze([2, 20, 6, 4, 5]);
  assert.deepEqual(r.actions, ["open", "clear", null, "open", null]);
}
{
  // null readings can't judge: no edge, no state change, open or closed
  const open = evalFreezeRisk(FREEZE_INITIAL, { outdoorF: 0, tankF: 100 }).state;
  for (const r of [{ outdoorF: null, tankF: 100 }, { outdoorF: 0, tankF: null }, { outdoorF: 20, tankF: null }, { outdoorF: null, tankF: 120 }]) {
    assert.deepEqual(evalFreezeRisk(open, r), { state: open, action: null });
    assert.deepEqual(evalFreezeRisk(FREEZE_INITIAL, r), { state: FREEZE_INITIAL, action: null });
  }
  assert.deepEqual(freeze([2, null, 20]).actions, ["open", null, "clear"], "a gap doesn't clear and doesn't block the clear after it");
}

// ── DHW shortfall ────────────────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(DHW_SHORTFALL_POLLS, 12);
  assert.equal(DHW_SHORTFALL_F, 113);
  const cold = (n: number) => Array<number>(n).fill(108);
  const r11 = run(evalDhwShortfall, DHW_INITIAL, cold(11));
  assert.equal(r11.opens, 0, "11 cold polls are not yet a shortfall");
  assert.equal(r11.state.streak, 11);
  const r12 = run(evalDhwShortfall, DHW_INITIAL, cold(12));
  assert.deepEqual(r12.actions, [...Array(11).fill(null), "open"], "the 12th consecutive poll opens");
  const r20 = run(evalDhwShortfall, DHW_INITIAL, cold(20));
  assert.equal(r20.opens, 1, "open once, however long it lasts");
  assert.equal(r20.state.streak, 20);
}
{
  // 113 °F or more resets the streak: 11 cold, one at 113, 11 cold is never a shortfall
  const r = run(evalDhwShortfall, DHW_INITIAL, [...Array(11).fill(108), 113, ...Array(11).fill(108)]);
  assert.equal(r.opens, 0);
  assert.equal(r.state.streak, 11);
  assert.equal(evalDhwShortfall({ streak: 5, open: false }, 112.9).state.streak, 6, "112.9 still counts as cold");
}
{
  // a recovered tank clears an open shortfall, once
  const r = run(evalDhwShortfall, DHW_INITIAL, [...Array(12).fill(108), 118, 118]);
  assert.deepEqual(r.actions.slice(-3), ["open", "clear", null]);
  assert.deepEqual(r.state, { streak: 0, open: false });
}
{
  // a null reading neither counts nor resets
  const r = run(evalDhwShortfall, DHW_INITIAL, [...Array(6).fill(108), null, ...Array(6).fill(108)]);
  assert.equal(r.opens, 1);
  assert.equal(r.actions[6], null);
  const open = { streak: 14, open: true };
  assert.deepEqual(evalDhwShortfall(open, null), { state: open, action: null });
}

// ── backup element called ────────────────────────────────────────────────────────────────────────────────────
{
  const r = run(evalBackupCalled, BACKUP_INITIAL, [false, true, true, null, true, false, false, null, true]);
  assert.deepEqual(r.actions, [null, "open", null, null, null, "clear", null, null, "open"], "only false→true and true→false edges fire");
  assert.deepEqual(evalBackupCalled({ called: true }, null), { state: { called: true }, action: null }, "unknown keeps the call");
  assert.deepEqual(evalBackupCalled(BACKUP_INITIAL, false), { state: BACKUP_INITIAL, action: null }, "no call ended that never began");
}

console.log("housealarms.test.ts: ok");
