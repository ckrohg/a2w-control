# C_eff resolution — the tank's effective thermal mass, measured (2026-07-15)

**Verdict: C_eff = 110 equivalent gallons, range [90, 125]. The 150-gal hypothesis is
physically excluded; the 119-gal nameplate guess survives as marginal. A-4's tub-test COP
restates from "2.9–3.6" to 2.63 [2.15–2.99].**

Method: three-agent analysis over the full 2025-11-22 → 2026-07-15 record (SensorLinx
tank probe + SPAN circuit energy + StreamLabs main meter), two independent estimators,
adversarial synthesis. Full transcript: session task w7drcot0z; per-charge table +
scripts in the session scratchpad (charges2.json, analyze*.py).

## The two estimators

**Discharge (draws with HP verified idle):** only 3 pure events exist in 8 months — the
HBX fires the pumps within minutes of every big draw. They give ~45 gal, but that is the
**probe-referred** mass: draws run with circulation pumps OFF, so the mid-tank sensor
watches the DHW coil's stratified cold front, not bulk temperature (event C rebounded
+13 °F in 2 min when a pump started — the tell). Keep 45 gal as the control-response
number ("how fast does the sensor fall during a draw"); it is wrong for energy accounting.

**Charges (181 clean, 53 deep ≥15 °F rise):** pumps run during every charge, so probe ≈
bulk — structurally sound. Each charge is a line C = 409.11 × (kWh/°F) × COP; the
manufacturer's two rated points collapse to one second-law efficiency (η ≈ 0.48), giving
a COP ceiling per condition. At C = 150 gal, 68 % of deep clean charges would beat the
spec ceiling (impossible) and three of four outdoor-bin medians sit at/above it → 150
excluded. At C ≈ 100–110, violations fall to noise (~8 %) and field COP sits at a
realistic 75–85 % of ceiling in every bin.

## What 110 gal makes true

- **A-4 tub recovery: COP 2.63 [2.15–2.99] at 87 °F ambient** (2.77 kWh / 27.1 °F rise).
- **Measured summer deep-charge COP: median ~2.6–2.7, IQR 2.4–3.2** — 75–80 % of the
  spec-derived ceiling (3.46) at those conditions, where a real installed cascade should sit.
- **Winter (as-found temps): ~1.5–1.7 at 20–35 °F, ~2.1 at 35–50 °F** — consistent with
  the spec ceiling analysis from the COP-artifact forensics; the optimizer's headroom is
  real and slightly larger than the model assumed.
- **A ~1 kWh per-cycle overhead exists** (kWh-vs-ΔT regression intercept ≈ 0.98 kWh:
  loop/HX heat-up): shallow standby charges cost 170–230 Wh/°F vs ~100 deep. Planner
  consequence (feeds §6.6): **fewer, deeper charges beat frequent shallow top-ups**, and
  per-°F economics must be computed net of the overhead.
- Deep-summer clean-charge median 104 Wh/°F independently reproduces A-4's 102 Wh/°F.

## The decisive next measurement (better than a nameplate photo)

**Electric-element calibration charge** — resistance heat is COP = 1.000 exactly, which
removes every assumption at once: lock out both HPs via Modbus (handoff §6.4 guardrails),
confirm zero draws on StreamLabs, mix (brief circulation), record settled start temp, run
the 16.5 kW element for a metered 4–6 kWh on its dedicated SPAN circuit, re-mix, record
settled end. 5 kWh yields 22.7 °F @ 90 gal / 18.6 @ 110 / 16.4 @ 125 / 13.6 @ 150 —
2–4 °F discrimination against a 2-min probe. Owner-gated (element breaker is owner-only,
§5.5). Take the nameplate photo anyway — free, but not decisive on *effective* mass.

## Doc corrections this supersedes

- a4-results.md COP range "2.9 (119 gal) – 3.6 (150 gal)" → **2.63 [2.15–2.99]**.
- Plan §6.7: planner C_eff constant = 110 gal (energy), 45 gal (probe-response); both
  now measured, not assumed.
- TempIQ's `EFFECTIVE_THERMAL_MASS_GALLONS = 150` default inflates every stored
  tank-calorimetry COP by ~1.36×  (commented on TempIQv2#1503).
