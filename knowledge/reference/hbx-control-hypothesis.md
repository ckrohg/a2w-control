# Control hypothesis: buffer control via PUMP SETPOINT (routing around the dead HBX-write path)

**Drafted 2026-07-16, from the overnight SensorLinx investigation.** Synthesizes what we can/can't
actuate into a control strategy that does NOT depend on writing the HBX target.

## What we can and can't actuate (established tonight + prior)

| Lever | Works? | Notes |
|---|---|---|
| HBX reset curve (dbt/mbt) via SensorLinx cloud | ❌ **No** | Config echoes/persists but the device runs its LOCAL curve; ignored across write, app-write, call-cycle, reboot. Target fixed ~154°F. |
| **Pump setpoint (LWT) via Modbus** | ✅ **Yes** | Proven (A-4). Pump produces water at its setpoint; `LWT follows setpoint`. |
| **Pump enable/disable via Modbus** | ✅ **Yes** | Proven ([[hbx-override-modbus-wins]]): a Modbus off defeats an active HBX call. |
| HBX target (temp1.target) | ❌ read-only | Computed device-side from the local curve (~154°F @ 70°F outdoor). |

Readable: buffer temp, target, outdoor, HP + backup relays, pump state, demands.

## The core insight

The HBX decides *when* to enable the pumps (buffer < its ~154°F target), but the pumps produce water
at **their own Modbus setpoint**. So the buffer settles at:

```
buffer_temp  ≈  min( pump_setpoint , HBX_target ≈ 154°F )
```

- Setpoint **above** 154 → HBX caps the buffer at 154 (cycles at its target).
- Setpoint **below** 154 → the pumps can't reach 154, so the buffer settles at the **pump setpoint**,
  and the HBX's 154 call is perpetually "unsatisfied" but harmless (see risks).

**Therefore the pump setpoint IS a downward buffer thermostat.** We can drive the buffer anywhere in
**~[sanitize floor 132 … 154]°F** via Modbus — without ever writing the HBX.

## Why this rescues the mission

The savings direction is **DOWN** (cooler buffer = higher COP *and* less standby loss, which compound —
see [[buffer-standby-loss-temp-dependent]], ~6 kWh/day standby alone at 155 vs 120). We never want to go
*above* 154. So the fact that the HBX target is **stuck high** costs us nothing for savings — the useful
control range is entirely below it, and pump setpoint covers that range.

**The dead HBX-write path is NOT a blocker for either the interim savings OR the future TempIQ auto-pilot.**
Both actuate the same way: choose a target buffer temp → command it as a **pump setpoint over Modbus**.
The auto-pilot vision is intact; it just drives pump setpoints, not HBX curve writes.

## Strategy

1. **Interim (manual):** set both pump setpoints to the desired operating temp (e.g. 138°F) via Modbus.
   Buffer settles ~138; captures COP + standby savings; stays > 131 sanitize.
2. **Auto-pilot (TempIQ):** TempIQ picks the optimal buffer temp per demand/weather/rates within
   [132, 154]; the planner translates that to a pump setpoint and writes it over Modbus.
3. **Sanitize:** inherent while the floor ≥ 132°F. For a hotter periodic soak, temporarily raise the
   pump setpoint (Modbus) — since setpoint drives the buffer up to the 154 ceiling.

## The load-bearing RISK — must validate before trusting this

When setpoint < 154, the HBX call is perpetually unsatisfied. That is exactly the state that tripped our
I1 guardrail and alarmed the owner earlier (setpoints 138 vs target 153). We must confirm it is BENIGN:

1. **Does the BACKUP heater engage?** This is the whole ballgame. Field map reads `bkDif=90`
   ("disabled-high" → backup only if tank < target−90 ≈ 64°F, which a 138 buffer never hits), `bkLag=230`
   min. BUT `bkRun=969:00` shows the backup HAS accumulated 969 h historically (likely winter deep-demand,
   not stalls). **Validate directly:** hold setpoint ~138 for several hours and watch backup relay (relay 4)
   + `bkRun` — must NOT increment. If it does, this strategy is dead (resistance heat = worse than baseline).
2. **Does the HBX fault / lockout** on a perpetually-unsatisfied call? (Watch `alerts`, demands, relays.)
3. **Does the buffer hold stably** at the setpoint, or oscillate/undershoot?
4. **Continuous/low-duty pump operation** acceptable? (Almost certainly — high-COP steady run beats cycling.)
5. **Reframe I1:** our guardrail `setpoint ≥ HBX_target + 5` was built to prevent backup deadlock. If (1)
   shows backup stays off, I1 becomes `setpoint ≥ desired_floor (≥132 sanitize)` instead — a deliberate,
   monitored relaxation, NOT a silent one. [[hbx-override-modbus-wins]] says the guardrails are load-bearing;
   only relax with the backup question definitively answered.

## Validation test (owner-supervised, controlled)

Set both pump setpoints to ~138°F via Modbus, hold 3–4 h, monitor: buffer settles ~138? backup relay/bkRun
flat? no HBX fault? If all yes → the lever works and we have efficient buffer control with no HBX writes.
This is a deliberate re-run of the earlier "I1 conflict," now instrumented to answer the backup question
that was only assumed before.

## How tonight's fresh-call test feeds in
If the HBX ignores the low cloud curve (145/135) on the next fresh call (expected) → confirms we cannot
lower the target via cloud and MUST route via pump setpoint (this hypothesis). If it *adopts* it (unlikely)
→ we'd also have direct target control and could lower the curve directly; the pump-setpoint path still works
either way.
