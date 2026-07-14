# HBX ECO-0600 as-found behavior — mined from TempIQ's SensorLinx history (Phase A-0)

> **Status: DONE 2026-07-13.** Source: TempIQ's readings table (read-only SELECTs), virtual
> sensors `AECO-2036-{tank-target, tank-temp, outdoor-temp}`, 143,310 five-minute samples per
> series, **2025-11-22 → 2026-07-13** (~8 months incl. a full winter), hourly-averaged to
> 5,156 joined points. Analysis script preserved in this doc's history; raw data re-derivable
> from TempIQ's DB at any time. Parent plan: `cross-system-optimization-plan.md` §7 A-0.

## 1. The curve (empirical)

**Outdoor reset is ON, linear, and was never edited during the record:**

```
tank_target(°F) = 165.5 − 0.161 × outdoor(°F)      residual σ = 0.38 °F  (n = 5,151 h)
tank_target(°C) = 74.2 − 0.161 × outdoor... (°F in) — planner uses the °F form + converts
```

| Outdoor (°F) | Target (°F) | Target (°C) |
|---|---|---|
| 3 | 165 | 73.9 |
| 34 | 160 | 71.1 |
| 66 | 155 | 68.3 |
| 97 | 150 | 65.6 |

- Correlation target↔outdoor: **−0.993** in winter months; within-bin p10–p90 spread ≤ 0.7 °F.
- **No Min/Max plateaus were ever reached** across 5–107 °F observed outdoor — the configured
  `Max Tank` / `Min Tank` endpoints lie outside the whole observed range (Max ≥ ~165 °F,
  Min ≤ ~148 °F). A-1 reads the actual four parameters.
- **WWSD: effectively OFF** — the tank was held at target through July (77 °F mean outdoor).
  Confirms year-round DHW service from the buffer; the summer demand mechanism (Permanent HD
  vs other) still needs A-1.
- **Zero manual curve edits in 8 months.** Every daily target shift tracks an outdoor swing.
  Only exceptions: two brief fixed-110 °F settings (2026-06-26 ~17:00Z, 2026-07-13 ~21:00Z —
  app experiments, each reverted within ~2 h). Useful side-finding: **app-made target changes
  appear in the polled telemetry within one 5-min cycle** — that's the Phase-C read-back
  verify loop demonstrated on real data.
- Tank tracks target closely when warm: median gap +0.4 °F, IQR −1.5…+1.6 °F → consistent
  with the default 6 °F centered differential (hourly averaging smears it; confirm from raw
  5-min data at commissioning).

## 2. The unreachable-target deadlock — confirmed and quantified

The curve's cold end (**164–165 °F = 73.9 °C**) sits essentially AT the pumps' 75 °C
(167 °F) ceiling. Since a call only ends at target + ½·diff (≈ +3 °F = 168+ °F), the tank
sensor **cannot** terminate cold-weather calls — the pumps' own aquastat does, and HBX
keeps calling. Empirically:

| Outdoor | tank − target (median) | hours > 4 °F short |
|---|---|---|
| 0–10 °F | **−9.4 °F** | **91 %** |
| 10–20 °F | −2.0 °F | 35 % |
| 20–40 °F | −0.5 °F | ~14 % |
| 50–70 °F | +1.2 °F | ~5 % |

This is the owner's original complaint, visible in a year of data: the as-found
configuration violates invariant I1 *by design* at the cold end. Phase B's margin
enforcement (or Phase C lowering the target) fixes it structurally.

**Anomalies RESOLVED (2026-07-13, owner + SPAN cross-check):** the mild-day shortfalls
(2026-04-25 −16.7 °F, 2026-04-03 −10.2 °F) were **HP2 failing to start when called** —
SPAN shows HP2 at 52/104/61/6 kWh Apr–Jul vs HP1's 810/472/316/151 (now fixed per owner).
**Caveat on the cold-weather shortfall table above:** Jan–Feb also had HP2 degraded
(~60 % of HP1's energy), so the measured gaps conflate the unreachable-target deadlock
with missing capacity — both real, but the deadlock's solo contribution is smaller than
the raw table implies; re-measure post-Phase-B with both pumps healthy. Also: much of the
record ran with the 16.5 kW element **disabled at SPAN** (owner cost mitigation), so
shortfalls weren't backstopped either. Remaining minor anomaly: 106.8 °F max "outdoor"
reading suggests the sensor sees some sun.

## 3. What this does to the savings case

The tank is held at **150–165 °F (65–74 °C) year-round**, against loads that need:
- **Winter binding zone** (Dining baseboard, worst case): ~135 °F (57 °C) design-day water
  (TempIQ zone model) — the curve runs ~25–30 °F above the binding need even at design,
  and more on mild days.
- **Summer (DHW only):** coil-in-buffer + mixing valve needs roughly ~120–125 °F tank for
  comfortable delivery — the curve holds ~153–155 °F. **~30 °F of pure excess for months**,
  at water temps that force the R134a second stage (worst COP) plus maximized standby loss.
- The curve also *peaks at night* (coldest hours = highest target = worst COP), the exact
  inversion the day plan corrects.

Net: the §8 savings band (10–20 %) now looks conservative rather than optimistic —
especially the summer months, which are pure waste reduction with a trivial comfort bar.

## 4. Feasibility notes for Phases B/C (all °F → °C at the adapter boundary)

- A summer target of ~120–125 °F needs HP setpoint ≈ 128–133 °F (53–56 °C) under I1 —
  at/below the reg-2027 55 °C default, no wall-controller change required in summer.
- Winter targets of ~135–145 °F need HP setpoints of ~143–153 °F (62–67 °C) — above the
  55 °C default cap, so **reg 2027 must already be raised on these units** (owner reports
  75 °C operation; A-6 register snapshot confirms as-found values).
- The I7 check (band top + ½diff + margin ≤ baseline) must be evaluated in °F against
  whatever band Phase C adopts — with a 125 °F summer band top, baseline 53–54 °C clears
  easily; a winter band top near 145 °F requires baseline ≥ ~64 °C or a season-split band.

## 5. ✅ RESOLVED by A-1/A-3 (2026-07-13, Proxyman capture)

Full config: `hbx-config-asfound-20260713.json`; write API: `hbx-write-api.md`. The
predictions all confirmed: curve = **Design 5 °F ↦ 165 °F, WWSD 125 °F ↦ 145 °F,
differential 4 °F** (configured slope −0.167 vs empirical fit −0.161 — exact within
hourly-averaging error); WWSD 125 °F = never (off, as observed); DHW mode off
(owner-confirmed unused); demand = **`permHD` = 1** (permanent heat demand — the
year-round call mechanism). Staging: `numStg`=3 with slot 3 a phantom (damaged HBX;
backup on slot 4), rotation ON (`rotTi`=1) including the phantom, `lagT`=60 min.
Backup triggers: only `bkLag`=230 min is live — and the element's **969 run-hours
(~16 MWh, ~$4.8k)** connect the §2 deadlock directly to resistive-heat cost (plan §5.5).
