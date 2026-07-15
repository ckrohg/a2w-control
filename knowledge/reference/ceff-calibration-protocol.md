# C_eff element-calibration protocol (independent cross-check)

**@purpose** A one-shot, owner-runnable measurement that pins the buffer tank's effective
thermal capacity **C_eff** by putting a *known* amount of energy into the tank and reading
the temperature rise — an independent ground truth for the **110 gal [90, 125]** figure the
observational mining produced ([[ceff-110-gallons]], `ceff-resolution.md`). Optional: the
solver already runs on 110 gal; this only *tightens* it (target ±5 gal) and removes the last
of the COP↔volume ambiguity.

## Why the resistance element (not the heat pump)
The 110 gal estimate is a *range* because charge-based energy accounting couples C_eff to the
heat pump's COP: `heat_to_tank = COP × electrical_in`, and you can trade a bigger tank against
a lower COP and fit the same data. The **backup resistance element is COP = 1 by physics** —
every electrical watt becomes a watt of heat in the water. So an element-only charge measures
`heat_to_tank = electrical_in` with no COP unknown, breaking the degeneracy.

This is why the element (**relay 4 = buffer_backup_resistance**, per the ECO-0600 relay map
[[relay-map-6bb]]) is the instrument, and the compressors (**relays 1 = HP1, 2 = HP2**) must be
**off** for the window.

## The formula
```
C_eff [gal] = (E_element_kWh × 3412.14) / (8.34 × (ΔT_measured + ΔT_standby))

  ΔT_measured = T_tank_end − T_tank_start          [°F, from the buffer sensor]
  ΔT_standby  = standby_rate × duration_hours       [°F lost to ambient during the charge]
  8.34        = lb per gallon of water              (× 1 BTU/lb·°F specific heat)
  3412.14     = BTU per kWh
```
`ΔT_standby` corrects for the heat that leaked to the room while charging. Use the decay-fit
standby rate (τ ≈ 60 h ⇒ ≈ 0.3–0.9 °F/h at a 55–20 °F tank-over-ambient gap; `decay.ts`), or
measure it in the same session (step 6). Over a ~2–3 h charge it's a ~5–12 % correction.

**Worked example:** 6.0 kWh element energy, tank 110 → 130 °F (ΔT = 20), 2.5 h, standby
0.9 °F/h ⇒ ΔT_standby = 2.25 °F.
`C_eff = (6.0 × 3412.14) / (8.34 × 22.25) = 20 473 / 185.6 = 110.3 gal.`

## Preconditions (all required for a clean read)
1. **Draw-free window.** No DHW draw and no zone extraction for the whole charge — a charge
    triggered by a draw is contaminated (same lesson as the mining and #1503). Best: owner away
    or overnight, ≥ 2 h. The water-main / streamlabs signal must show zero flow in-window.
2. **Compressors off.** Relays 1 & 2 (HP1/HP2) must not fire, so *all* the tank rise comes
    from the element. Force via the controller's backup/emergency-heat mode, or isolate the HP.
3. **Element circuit on a known SPAN circuit** so `E_element_kWh` is *measured*, not nameplate.
4. **Buffer sensor logging** (it already flows to TempIQ `readings` and a2w `slx_readings.tank_f`).
5. Tank has headroom to rise ~20 °F without hitting its max/aquastat cutout mid-window.

## Procedure
1. Pick the draw-free window; note the wall-clock **start time**.
2. Record **T_tank_start** (buffer sensor). Confirm the tank is settled (not mid-charge).
3. **Disable the heat pump** (relays 1/2 off) and **force the element** to charge the tank
    (raise the buffer target / enter backup-only). If using the a2w write path, respect the
    HBX write guardrails — a Modbus-off defeats an active call [[hbx-override-modbus-wins]].
4. Let the element run until the tank rises ~**20 °F** (or a fixed ~2.5 h), staying below the
    tank's safe max. Note the **end time** and **T_tank_end**.
5. Confirm **no draw occurred** (water-meter flat across the window). If any draw happened,
    discard and repeat.
6. *(standby, optional but better)* Immediately after, leave the element off and the HP off
    for ~30 min and record the tank's cool-down rate → that's `standby_rate` for the correction.
7. **Restore normal operation** (re-enable the HP, return the buffer target).

## What to hand me (I extract the rest from the logs)
Just the **start and end timestamps** of the charge (and a note that it was draw-free). From
those I pull `T_tank_start/end` (slx_readings / TempIQ readings), the element `E_element_kWh`
(SPAN circuit over the window), and the draw-check, then compute C_eff with the formula above.
If you also did step 6, give me that window too.

## Expected result & where it goes
A clean read should land inside **[90, 125]** and collapse it toward a point value. Then:
- it feeds **TempIQ #1503**'s thermal-mass persistence as a *measured* C_eff (replacing the
  mined 110 gal) — a one-line update to the persisted value; and
- it firms up the A-4 COP restatement (110 gal → COP ≈ 2.63) into a tighter band.

## Safety
The element and its circuit carry real load — don't exceed the tank's rated max temperature or
the aquastat/high-limit; don't defeat any safety interlock to force the charge. If anything about
isolating the HP or forcing backup is unclear on your controller, stop — a slightly wider C_eff
band is not worth a bypassed limit. This is optional; the solver runs fine on 110 gal.
