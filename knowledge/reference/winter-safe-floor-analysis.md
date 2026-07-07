# Winter-safe setpoint floor — first-pass analysis (2026-07-07)

> Multi-agent analysis (7 agents: 6bb-solar + TempIQ + A2W-envelope + climate gather →
> synthesize → adversarial safety-check). Grounded in TempIQ's *learned* thermal data for
> this exact house. **Confidence: LOW** (see caveats) — this is the number to START from and
> validate at commissioning, not a final Manual-J. Sets the Phase-2 write-enable gate values.

## Recommendation (Phase 2 — do NOT activate until write_enabled + the commissioning checks)

| Guardrail | Value | Role |
|---|---|---|
| `unattended_min_setpoint_c` | **45 °C** (113 °F) | Hard freeze floor: the lowest LWT setpoint a cloud optimizer / TempIQ token or the scheduler may command. |
| `baseline_setpoint_c` | **48 °C** (118 °F) | Warm default the Pi reverts to when a remote lease lapses. |
| `setback_setpoint_c` | **46 °C** (was 40) | Scheduler "off" target. Corrected up: an unattended writer is clamped by the 45 floor, so 40 is meaningless (silently clamped to 45). |

Authority ladder (all below the reg 2027 = 55 °C firmware cap, so no wall-controller change
needed): `setpoint_min 30 (human-only) < unattended_min 45 < setback 46 < baseline 48 < comfort 50 < reg2027 cap 55`.

These happen to match the placeholders already in `config.production.yaml` — the analysis
**validates** them (and corrects setback).

## The house (confirmed: 6 Black Brook Rd, South Hamilton, MA — DOE climate zone 5A)

- **Design temp** (climate agent, medium confidence): ASHRAE **99% = 9 °F, 99.6% = 5 °F**;
  freeze-protection stress point **-15 °F** (recurring modern extreme ~-10 °F; regional record -18 °F).
- **Emitter mix (the binding driver — confirmed from TempIQ zone data, not assumed):** hydronic
  **fin-tube baseboard** (Living Room, Upstairs) + **radiant floor** (Kitchen) + others, off a
  shared **buffer tank**. Baseboard is the high-temperature emitter → it sets the LWT floor;
  radiant tolerates 30-45 °C and is never the constraint.
- **Learned house heat loss (TempIQ, LOW confidence, r²≈0):** ~340 W/°F house-only →
  derived design load ≈ 22 kW / 75,000 BTU/hr. Worst hydronic-only zones: Dining 27.9, Master
  Bath 23.1 W/°F.
- **Measured hydronic system COP ≈ 2.69, FLAT vs outdoor** → the system currently runs a
  **fixed buffer setpoint (~45-50 °C)**, consistent with these values.
- **Independent freeze backstops (not counted in the floor):** the buffer tank's **16.5 kW
  resistive element** + **3 ductless mini-splits**. Whole-house winter peak ~48 kW (= the 200 A
  service ceiling).

## Why 45 °C

Fin-tube baseboard output collapses below ~42-43 °C LWT; exterior baseboard rooms then risk
freezing when unattended. 45 °C is held above that bare-physics threshold to absorb (a) the
setpoint→actual-emitter-supply drop across buffer mixing, glycol, and distribution; (b) the
low-confidence UA fits; (c) HP capacity de-rate at low ambient. The risk is **asymmetric** — a
freeze with nobody home = burst pipes (catastrophic) vs. "too high" = mild energy waste — so
under genuine input uncertainty the floor is deliberately biased safe/high.

## Adversarial verdict: SAFE against the design-day (5 °F) freeze; if anything conservative

The glycol loop won't burst regardless of setpoint, and most freeze protection is actually on
the air-to-air mini-splits (independent of the water floor). 45 °C clears the freeze bar with
margin. Keep it there — do not lower it — given the low-confidence inputs.

### ⚠️ The real residual risk: COMMANDED ≠ DELIVERED (a coordination gap, not a wrong number)

`unattended_min_setpoint_c` clamps the **setpoint** (reg 2003), not the **achieved** water
temp. Between the 5 °F design day (-15 °C) and ~-20 °C ambient, the HP's *own* backup heater
does **not** auto-engage (reg 2030 enables it only at ambient ≤ -20 °C), so a de-rated
compressor may fail to actually **reach** 45 °C. The 16.5 kW buffer element that would force
delivery fires on **HBX logic — out of A2W's scope**. So at extreme cold, freeze safety rests
on out-of-scope backups (HBX element + mini-splits), not on the A2W number alone. **This
reinforces the Phase-4 HP+HBX coordination requirement.** The floor is *necessary but not
sufficient* at extreme cold.

Secondary: `baseline` 48 °C (capped by reg 2027 = 55) will not fully *comfort*-heat the
highest-UA baseboard-only zones (e.g. Dining needs ~57 °C water) on the very coldest days —
a comfort gap the mini-splits/occupant cover, **not** a freeze failure. And a static floor
blocks deep setback on mild nights (forgone optimizer savings) until weather-compensation
replaces it.

## Validate at commissioning to tighten (raise confidence from LOW)

1. **First cold snap:** log per-zone indoor temps with the hydronic loop at the 45 °C floor;
   confirm no exterior baseboard room (Living Room, Upstairs, Dining, Mud Room) drifts toward freezing.
2. **Read reg 2051 (outlet) vs commanded setpoint at low ambient** — does the HP actually
   reach 45 °C when it's cold, and how big is the buffer→emitter drop?
3. **Verify the ×0.1 scaling** on regs 2050/2051/2052 (Phase 1) before trusting any LWT reading.
4. **Confirm the HBX 16.5 kW element** fires to hold the buffer if the compressor falls short at
   design temp (SPAN buffer-tank circuit + backup-heater status) — this is what makes the floor real.
5. Site-confirm emitter type + fin-tube length per zone; re-fit the two under-fit UAs
   (Upstairs Baseboard 1.97, Mud Room 1.73).
6. Clamp-meter HP draw + tank-temp-rise for a real design-day COP (replace the flat-2.69 assumption).
7. Check for weather-compensation/reset → if available, replace the static floor with an
   outdoor-indexed floor to recover mild-night savings safely.
8. Verify glycol freeze-protection margin + HP low-ambient cutout at the -15 °F stress point.
