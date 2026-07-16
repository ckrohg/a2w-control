# Diagnosis: HBX tank-target writes are a no-op on the physical device

**Surfaced:** 2026-07-15, during the interim-savings attempts. The owner caught it — an I1
conflict banner showed the tank targeting 153°F while both pump setpoints had been lowered to
138°F, i.e. the "lower the tank to 131°F" writes had never taken effect.

## Symptom
Every `POST /api/planner/target` (and the earlier 120°F, then 131°F "cuts") returned `ok:true`,
recorded a config version, and set `curve_overridden:true` — yet the buffer's operative target
stayed at ~153°F the entire time (tank stayed in HEAT DEMAND toward 153, never cooled). Lowering
the pump setpoints against that unmoved target created a live I1 deadlock (pumps can't reach 153
→ backup-heater fallback).

## Root cause — verification checks the wrong field
Two different fields are in play:

- **Read (what the planner calls the tank target):** `tankTargetF = dev.temps.temp1.target`
  (`planner/src/index.ts:155`). This is the device's **live, operative** target — what it's
  actually driving to. In the as-found capture it's `152.6°F`, matching the reset curve
  `dbt=165 / mbt=145` at that outdoor temp.
- **Write:** `patchDevice(..., {dbt, mbt})` (`planner/src/writes.ts` → `sensorlinx.ts`). This
  PATCHes the **reset-curve config endpoints**. The read-back verify in `writes.ts patch()` only
  checks `dev[dbt] === wanted && dev[mbt] === wanted` — i.e. **it confirms the API echoed the new
  config, but NEVER checks that `dev.temps.temp1.target` (the operative target) actually moved.**

So when we flatten `dbt=mbt=131`, the SensorLinx API accepts it and echoes `dbt:131, mbt:131`
(read-back passes → `ok:true`), but **`temps.temp1.target` stays ~153** — the device keeps
computing/driving to its previous target. The config PATCH updated the cloud-side config record
without changing the device's operative behavior.

## Why the device doesn't apply the curve PATCH (to confirm — not yet proven)
Likely one of (needs a controlled, read-only test — do NOT trial-and-error on live pumps):
1. **Device-local authority:** the physical ECO-0600 runs from its local (wall-controller)
   settings; the cloud PATCH updates the cloud config mirror (echoed back) but doesn't push down
   to the device's operative reset curve. The device reports its own computed `temp1.target` up.
2. **`permHD = 1` (permanent heat demand):** in this mode the operative target may be derived
   or held differently, so a reset-curve config change doesn't recompute `temp1.target`.
3. A device-side "apply" step the API PATCH doesn't trigger.

Note: `knowledge/reference/hbx-write-api.md` says an *app-made* `mbt 145→144` PATCH "appeared in
the polled telemetry within one 5-min cycle" — but that verified the **config field** propagating,
not that `temps.temp1.target` recomputed. The A-4 test moved *pump setpoints* (Modbus, a different
path that DOES reach hardware), never the HBX target — so this no-op was never exercised until now.

## The fix
1. **Make the write honest (highest priority).** After a PATCH, poll `dev.temps.temp1.target`
   (with a short settle + tolerance) and require it to actually move toward the requested value
   before returning success. Checking the config echo is insufficient. Had this been in place,
   every "cut" would have failed loudly and the setpoints would never have been lowered into a
   conflict.
2. **Gate/disable the Optimize apply + planner HBX writes** until the write provably moves
   `temp1.target`. Today they are no-ops on hardware and, combined with setpoint writes,
   dangerous (see the I1 incident).
3. **Determine the real apply mechanism** (read-only / offline where possible): does an app write
   actually move `temp1.target`? is `permHD` gating it? is the operative target settable via a
   different field (a manual hot-tank setpoint) or only at the wall controller?

## #2 investigation — the likely real cause + a safe test

Two things surfaced from the field map (`hbx-write-api.md`) and the as-found device object:

1. **The design spec already called for the check the code dropped.** `hbx-write-api.md`
   §"Adapter guardrails" says: *"Read-back: assert the PATCH response echoes the written field;
   **cross-check `temps.temp1.target` moves onto the new line within one poll.**"* The
   implementation (`writes.ts patch()`) did the echo check but **omitted the `temp1.target`
   cross-check** — which is exactly the silent no-op. So Fix #1 is restoring intended behavior,
   not inventing it.

2. **The flatten is probably the culprit.** `setTarget` writes `dbt = mbt = T` — a *degenerate*
   reset curve (design-temp == min-temp). Every working write (as-found 165/145, the app's
   discovery write 165/144) kept **dbt > mbt**. A device that validates its reset curve would
   **reject/ignore `dbt == mbt`** and keep the last valid curve (165/145 → 153°F) — which is
   exactly what we saw. We never confirmed whether the device *reverted* `dbt` (a later GET would
   show 165) or accepted it but ignored it for the target, because the verify only read the PATCH
   echo.

**Likely working approach:** don't flatten. Write a **valid** curve (dbt > mbt) shifted down so its
output at the *current outdoor* equals the target. E.g. for ~131°F at 72°F outdoor, keeping the
~−0.167°F/°F slope: `dbt ≈ 142, mbt ≈ 122`. (Trade-off: it's outdoor-indexed, so a fixed target
needs a near-flat-but-valid curve, dbt only slightly > mbt.)

**Safe controlled test (do WITH Fix #1's verification in place, ideally owner-watching, NOT
unattended):** a single write of a valid shifted curve (dbt > mbt) targeting ~131°F at current
outdoor, then `getDevice` and check: (a) did `dbt/mbt` stick (device accepted the config), and
(b) did `temps.temp1.target` move to ~131°F (device applied it). Outcomes:
- both yes → mechanism is "valid shifted curve"; the flatten was the bug; savings unlock.
- `dbt` reverted, or `temp1.target` stayed 153 → the device does **not** accept remote curve
  changes (wall-controller / local authority). Remote HBX-target control via SensorLinx is then
  impossible, and savings need a different route (wall-controller change, a manual hot-tank
  setpoint field if one exists, or a Modbus HBX path).

With Fix #1 hardening the write, this test is *self-protecting*: if it's a no-op, the write fails
loudly and auto-restores the config — no silent drift, no setpoint conflict.

## Implication for savings
The tank can't be lowered via this path, and pump setpoints can't be safely lowered without first
lowering the tank (I1). **So there is no working savings lever until the HBX write path is fixed**
— or a different control route is found (wall-controller change, a manual-setpoint field, or a
Modbus HBX path if one exists). The pump-setpoint path works; the SensorLinx HBX-target path does
not. System is currently reverted to the safe as-found baseline.
