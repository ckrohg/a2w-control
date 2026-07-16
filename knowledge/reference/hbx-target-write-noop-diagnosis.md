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

## Test result (2026-07-15) — DEFINITIVE: remote target control is not possible via this path

Ran the controlled test (valid shifted curve `dbt=132 / mbt=130`, self-restoring):
- **Config stuck:** yes — after 15s the device reported `dbt=132, mbt=130`. So the SensorLinx
  PATCH *does* reach the device's config.
- **Operative target moved:** **NO** — `temps.temp1.target` stayed at **145°F** the entire time
  (baseline 145 → shifted 145 → restored 145). It didn't follow the curve, `dbt`, or `mbt`.

So the hypothesis (valid curve works, flatten was the bug) is **disproven.** The device **accepts
curve-config writes but never recomputes the target it actually drives to.** `temp1.target` is set
device-side (wall controller / local logic, likely with `permHD=1` holding it), decoupled from API
config writes. Also noted: `temp1.target=145` = `mbt`, not the curve output (~153 at 72°F) — the
operative target isn't even the reset-curve output. Config restored to as-found; system safe.

**Conclusion: the HBX tank target cannot be changed remotely via the SensorLinx API.** The
reset-curve config is writable but inert w.r.t. the operative target.

## Patient re-test + field hunt (2026-07-15, decisive) — and what's still unexhausted

The 15s window above was a fair objection (temp1.target is device-reported telemetry; the field map
says app changes appear "within one 5-min cycle"). So we re-ran it patiently:

- **11-minute observation** (`scratchpad/hbx-observe.mjs`): wrote a valid `dbt=140 / mbt=130`, left
  it in place, sampled `temp1.target` every 60s for 11 minutes (two full poll cycles). Result:
  **flat at 145°F every single sample (Δ0.0)**, config retained at 140/130 the whole time. So the
  no-op is NOT a too-short-read artifact — a valid curve held for 11 min genuinely does not move the
  operative target. Restored 165/145 (confirmed by immediate PATCH echo).
- **Full device dump** (`scratchpad/hbx-dump.mjs`, 108 fields): the ONLY tank-temperature-range
  writable fields are `dbt`/`mbt`. `temps.temp1.target` is a computed display object
  (`title:"TANK"` + color/status), not a config input. There is **no manual-setpoint / demand-target
  field** to write instead. On this device the hot-tank target = the outdoor-reset curve, period.

**So via the cloud REST config API, the operative target cannot be moved — confirmed properly.** But
the SensorLinx *app* controls this device over the same host, so *an* API/WiFi path exists. Two
avenues remain untested, both of which keep the WiFi approach alive:

1. **Longer device-pull latency.** The "5-min cycle" in the field map was config→old-host telemetry
   (cloud-to-cloud), NOT the physical device ingesting cloud config. The controller may pull cloud
   config only hourly / on reconnect. Test: leave a SAFE valid curve (e.g. `mbt=135`, target stays
   ≥135 > sanitize; setpoints 167/159.8 clear it) in place ~1–2h and watch for a late move.
2. **The app uses an extra channel.** The A-3 capture only grabbed a REST section-save PATCH and
   never verified it moved `temp1.target`. The app may push via socket.io
   (`wss://api.sensorlinx.co/socket.io`) or an "apply" call. Decisive test: change the target in the
   app while watching our API poll + capturing WebSocket frames (Proxyman with WS enabled). Either it
   reveals the mechanism to replicate, or it proves even the app can't move it remotely.

## App-capture + 44-min watch (2026-07-16) — the mechanism, settled

Owner changed **Min Tank Temp 145→135 in the SensorLinx iOS app** with a fresh Proxyman HAR, while
we watched the live API for 44 min (`scratchpad/hbx-watch.mjs`, `hbx-device.json`, HAR analysis):

- **The app has no secret mechanism.** Its save is the *same* REST PATCH we implement:
  `PATCH /buildings/{id}/devices/AECO-2036` body `{"htDif":4,"dbt":165,"mbt":135}`. The socket.io
  WebSocket (`wss://api.sensorlinx.co/socket.io`) is **receive-only** — every meaningful frame is a
  server→app `device:update` telemetry push (`tB1:["TANK",actual,target,status]`); the app's only
  sent frames are protocol housekeeping (`2probe`/`5`/`3`/close). No command/apply frame.
  `POST /account/me/devices` just registers the iOS push token. Nothing to replicate.
- **The app's own write did not move the operative target.** mbt→135 reached the cloud
  (`changeSource:"api"`), but `temp1.target` **held 154.5°F for the full 44 min** — through the rest
  of the active call, the tank rising past 154.5 to 157.7°F, and a ~28-min satisfied plateau (no new
  call started — no draw at that hour).
- **`temp1.target` is device-computed from the LOCAL curve, not the cloud mirror.** This also explains
  the 145-vs-154.5 puzzle: idle → target shows `mbt`; active call → shows the interpolated curve
  output; both derived from the device's *own* 165/145 curve. Cloud PATCHes (app or API) update only
  a cloud mirror the controller does not adopt for operation.

**Settled conclusion:** remote target control over the SensorLinx cloud is not possible on this
ECO-0600 (fw 2.08) — not because we write it wrong (we write exactly what the app writes), but
because the device runs from its local curve. Curve/config restored to 165/145 after the test.

**Unfalsified long-shot + clean resolver:** we never saw a device reboot / WiFi reconnect in-window,
so config-ingestion-on-reconnect isn't strictly ruled out. Definitive answer = a **vendor question
to SensorLinx/HBX**: does the ECO-0600 apply remote cloud config to operation, or is cloud
read/telemetry-only, and is there a firmware/setting to enable remote-write? That is the only
remaining fully-API/WiFi avenue.

## Implication for savings
The tank can't be lowered via this path, and pump setpoints can't be safely lowered without first
lowering the tank (I1). **So there is no working savings lever until the HBX write path is fixed**
— or a different control route is found (wall-controller change, a manual-setpoint field, or a
Modbus HBX path if one exists). The pump-setpoint path works; the SensorLinx HBX-target path does
not. System is currently reverted to the safe as-found baseline.
