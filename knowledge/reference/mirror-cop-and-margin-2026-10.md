<!--
@purpose First measured heat-pump COP in heating weather this season, and the first measurement of the
pump-outlet → buffer-tank margin, both computed from data already in A2W's own mirror database:
SPAN local per-circuit power (25 s), SensorLinx tank temperature (5 min) and the pumps' Modbus
inlet/outlet (60 s). Two thermal methods: tank-rise calorimetry (C_eff 110 gal) and, after the owner
challenged the sampling on 2026-10-20, a pump-side lift × flow integral that needs no tank probe.
Read-only analysis of the LOCAL restore of backup a2w-db-2026-10-20T014442Z via scripts/analyze-local.sh
(no production query, nothing written to any live service). Companion to tempiq-data-deep-dive-2026-10-19.md
§3 (why no COP exists) and ceff-resolution.md (C_eff = 110 gal). Diagnostic, not claim-grade: §4 lists the
confounds and the uncertainty bands are wide.
-->

# Mirror COP and buffer→emitter margin — October 2026

Data: 2026-10-12 → 2026-10-19 21:44 ET (snapshot 2026-10-20T01:44Z), 78 pump runs, 68 usable charges
plus 5 long "sustaining" runs. September (172 usable charges, no zone calls) is used only as a cross-check
against TempIQ's `tempiq_cop_points`. Thermal mass C_eff = 110 gal = 917 BTU/°F for the tank-rise method;
the 90 / 125 gal bounds scale it by ×0.82 / ×1.14. The pump-side method (§2.6) inherits that through its
flow calibration.

## 0 · Verdict

| question | answer | confidence |
|---|---|---|
| COP in heating weather, 40–50 °F outdoor, sink 120–140 °F | **tank-delivered 1.85 per charge as the HBX actually cycles** (lower bound; C_eff band 1.5–2.1); **pump-side 2.0–2.6**; **marginal 3.0–3.5** per additional °F once the compressor is running | medium: n = 25, 24 of them with a zone calling |
| 30–40 °F outdoor (the Oct 18 night) | tank-rise 1.1 on the 7 short charges; **pump-side 2.0 on those and 1.9–2.5 on the three multi-hour runs** where tank rise says nothing | low-medium |
| the per-start overhead | **~1.1 kWh of heat per shallow charge that the pump makes and the tank never keeps**, ≈ 0.5 kWh electric; compressor start-up itself costs only ~0.1 kWh. It is the outdoor loop re-warming after it cooled during the gap (the probe dips 2–5 °F in the first five minutes). 13–17 starts/day Oct 16–19 → 7–11 kWh/day, 30–50 % of pump energy | medium-high |
| TempIQ's September COP (2.4–2.5) vs ours (1.0–1.2) | **same electrical input to 1 %** (105 of 105 points match a SPAN charge); their thermal is 1.93× ours = 150 gal "tank + piping" ÷ 110 (×1.36) × a trajectory-fit rise instead of end − start (×1.42). Neither is wrong; they measure different things | high |
| pump outlet − tank probe while heating | **+3.6 °F median (pump 1), +2.9 (pump 2), IQR 0 → +7.** Depends on tank level: +2 °F below 125 °F, +8 to +9 °F above 125 °F | high (1 530 samples) |
| `BUFFER_MARGIN_F = 4.5` | **neither confirmed nor contradicted.** The emitter supply is unmeasured. The tank is stratified by 3–7 °F between the mid-tank probe and the water leaving to the pumps, so any single-probe margin carries ≥ ±4 °F | — |
| probe lag | outlet responds in ~1 min; the tank probe needs **8 min (IQR 4–12) to move +1 °F**, 11 min for +3 °F; 28 % of charges first dip 2–3 °F | high |

The useful sentence: **at 40–55 °F a kWh into the pumps puts about 2 kWh of heat into the tank per charge
and about 3–3.5 kWh per marginal kWh once the compressor is running; the gap is the outdoor loop
re-warming at every start, and the HBX's 4 °F differential buys 13–17 starts a day.**

## 1 · Method

- **Charge** = contiguous run with SPAN draw on Air-Water 1 + 2 above 300 W, gaps ≤ 10 min bridged
  (defrosts stay inside). Heating-state samples draw 3.6–5.8 kW; idle ~46 W; defrost 50–900 W.
- **Electrical** = ∫ −power_w dt over both circuits, dt capped at 120 s. Daily totals reproduce the deep
  dive's (Oct 18 = 52.4 kWh). No usable charge straddles a SPAN gap (largest internal gap 101 s). The
  Buffer Tank (element) circuit drew 0.00 kWh in every charge.
- **Thermal, tank side** = 917 × (tank_f at the first 5-min sample after the run − last sample before it).
  "Draw-corrected" adds back the tank's loss rate during the run from the 30-min slopes before and after
  (mean, clipped 0–20 °F/h). §2.6 shows that rate is not stationary, so **the corrected figures are an
  upper bracket, not a measurement.** Standby alone is −1.06 °F/h (IQR −1.22 → −0.81, 236
  `tank_decay_fits` since Oct 1) ≈ 0.28 kW.
- **Thermal, pump side** = Q × ρc × ∫ (outlet_c − inlet_c) dt over the pumps' Modbus readings while
  heating or defrosting (defrost lift is negative and counts), Q calibrated on the deep charges (§2.6).
- **Usable** = ≥ 4 min, ≥ 0.25 kWh, tank sample ≤ 5.5 min before start, ≥ 10 min since the previous run.
- **Zone-calling** = a hydronic zone `calling` in the nearest `zone_floor_snapshots` row (hourly) before
  the start or after the end. **Sustaining** = run ≥ 60 min. **DHW-hours** = start 06–09 or 19–23 ET
  before Oct 16 (no DHW signal exists in October; TempIQ's feed is dead).

## 2 · Part A — per-charge COP

### 2.1 By outdoor band (usable, non-sustaining; Oct 12–19)

| outdoor °F | n | kWh | tank-rise p50 | tank-rise pooled @ 90 / **110** / 125 gal | pump-side pooled (Q 32–43) | draw-corrected (bracket) | sink avg °F | zone-calling |
|---|---:|---:|---:|---|---|---:|---:|---|
| 30–39 | 7 | 12.8 | 0.83 | 0.90 / **1.10** / 1.25 | **2.00** (1.7–2.3) | ≤ 1.75 | 131 | 7 of 7 |
| 40–49 | 25 | 24.9 | 1.95 | 1.51 / **1.85** / 2.10 | **1.95** (1.6–2.2) | ≤ 2.61 | 132 | 24 of 25 |
| 50–59 | 27 | 34.9 | 1.53 | 1.13 / **1.38** / 1.57 | **2.21** (1.9–2.5) | ≤ 1.55 | 128 | 12 of 27 |
| 60–69 | 9 | 7.1 | 1.66 | 1.42 / **1.74** / 1.98 | **2.33** (2.0–2.6) | ≤ 2.02 | 125 | 7 of 9 |

Pooled = Σ thermal / Σ electrical (energy-weighted). The 50s band's zone-free subset (Oct 12–15, 15
charges, 18.7 kWh) pools to 1.30–1.53 on the tank side; its charges are the 120 °F DHW-floor top-ups and
the band reads *below* the colder 40s band because of depth, not weather (§2.2). The pump side has
little weather dependence in this window because sink and depth move the other way (cold nights = deep
135–140 °F banks, mild days = shallow 120 °F top-ups).

### 2.2 By sink temperature and by depth — depth drives the tank-side number, not the pump-side one

| sink (tank at end) | n | kWh | ΔT avg | min avg | tank-rise p50 | tank-rise pooled | corrected (bracket) |
|---|---:|---:|---:|---:|---:|---:|---:|
| < 125 °F | 30 | 23.6 | 3.0 | 10 | 1.23 | 1.02 | ≤ 1.42 |
| 125–135 | 20 | 27.6 | 7.1 | 17 | 1.69 | 1.39 | ≤ 1.70 |
| ≥ 135 | 18 | 28.5 | 12.1 | 21 | 2.12 | 2.05 | ≤ 2.65 |

| rise per charge | n | kWh | tank-rise pooled | **pump-side pooled** | heat made but not kept, per charge | Wh per °F (tank) |
|---|---:|---:|---:|---:|---:|---:|
| < 6 °F | 39 | 33.4 | 0.92 | **2.19** | 1.09 kWh | 291 |
| 6–12 °F | 19 | 25.0 | 1.82 | **1.98** | 0.20 kWh | 148 |
| ≥ 12 °F | 10 | 21.3 | 2.08 | **2.12** | 0.08 kWh | 129 |

Seen from the tank, a hotter sink has the *better* COP, which is backwards for a heat pump — because the
≥ 135 °F charges are the deep soaks and the < 125 °F ones are 10-minute top-ups at the DHW floor. Seen
from the pump, the depth dependence disappears: the pump made about the same heat per kWh in every
depth class, and the tank simply never showed 1.1 kWh of it per shallow charge.

### 2.3 The per-start overhead: loop reheat, not compressor start-up

Regressing electrical kWh on *tank* rise (kWh = a + b·ΔT) gives a fixed cost per start and a cost per °F:

| subset | n | intercept kWh/start | Wh per °F | marginal COP @110 | r² | outdoor avg |
|---|---:|---:|---:|---:|---:|---:|
| Oct 12–17, no zone calling | 18 | 0.70 | 79 | 3.40 | 0.80 | 55 |
| Oct 16–19, zone calling, raw ΔT | 50 | 0.56 | 89 | 3.01 | 0.41 | 49 |
| same, draw-corrected ΔT (bracket) | 50 | 0.45 | 77 | 3.51 | 0.47 | 49 |
| September (cross-check) | 172 | 0.85 | 62 | 4.37 | 0.35 | 63 |

The same regression against *pump-side* heat gives an intercept of **0.12 kWh** (marginal 2.35, r² 0.91).
So the compressor's own start-up penalty is ~0.1 kWh and the rest of the tank-side intercept is heat the
pump produced that the tank did not keep. What the first minutes of a zone-free charge look like:

| minutes into the charge | pump inlet vs tank at start | pump outlet vs tank at start | tank probe vs start |
|---|---:|---:|---:|
| 0–2 | −9.5 °F | −7.5 °F | 0.0 |
| 2–4 | −7.3 | −0.3 | −2.2 at min 5 (p25 −5.0, p75 +0.4) |
| 4–9 | −6.1 / −5.7 | +4.1 / +4.6 | +1.3 at min 10 |
| 9–12 | −3.5 | +6.8 | +4.3 at min 15, +6.0 at min 20 |

The loop to the outdoor units cools during the gap; at start the pump pushes that cold water into the
tank (the probe dip, 2–5 °F × 917 BTU/°F = 0.6–1.3 kWh) and re-warms it, and the heat is lost outdoors
again by the next gap. At ~10 gpm the whole loop passes the inlet in under a minute, so the 60 s Modbus
sampling only catches the tail of the slug. After a short gap (most zone-calling charges) the loop is
still warm and the dip mostly vanishes: +0.8 °F at minute 5 instead of −2.2. ceff-resolution.md found the
same intercept (~0.98 kWh) in summer. It is paid per start: Oct 16 / 17 / 18 / 19 had 16 / 13 / 16 / 15
starts (13 / 5 / 9 / 7 under 15 min) for 16.7 / 27.0 / 52.4 / 18.5 kWh. The physical levers are the loop's
insulation and the HBX differential, not the compressor.

### 2.4 Sustaining runs (≥ 60 min) — tank rise fails, the pump side does not

| start ET | min | kWh | outdoor | tank start → end (min) | tank-rise | corrected (bracket) | **pump-side** | kW avg |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| 10-16 00:57 | 75 | 4.5 | 47 | 77 → 123 (77) | 2.71 | ≤ 3.25 | **3.08** | 3.6 |
| 10-17 16:37 | 83 | 6.7 | 43 | 129 → 139 (106) | 0.41 | ≤ 1.26 | **2.18** | 4.8 |
| 10-18 00:42 | 202 | 12.9 | 31 | 120 → 124 (101) | 0.08 | ≤ 0.67 | **1.94** | 3.8 |
| 10-18 06:01 | 240 | 15.5 | 36 | 130 → 130 (103) | 0.01 | ≤ 1.13 | **2.51** | 3.9 |
| 10-18 21:26 | 130 | 8.9 | 38 | 119 → 128 (106) | 0.26 | ≤ 1.19 | **2.03** | 4.1 |

The Oct 16 run is pump 2's recovery from 77 °F after its Oct 14–15 fault and 14 hours with no charge:
deep, from a cold sink (average ~100 °F), and the two methods agree (2.7 / 3.1). The other four are the
Oct 17–18 cold night: the tank fell 16–27 °F *while a pump ran for hours*, so ΔT measures house load,
not pump output (the `called_tank_flat` journal entry). The pump side gives them 1.9–2.5 at 31–43 °F —
**the first COP numbers in real cold this season**, at the flow-calibration caveat in §2.6.

### 2.5 September cross-check against TempIQ

Same outdoor bands, TempIQ points with quality_score ≥ 0.7, our charges with no zone calling (none in
September) but no DHW filter:

| outdoor | TempIQ n | TempIQ p50 / pooled | TempIQ sink | a2w n | a2w tank-rise p50 / pooled | a2w sink |
|---|---:|---|---:|---:|---|---:|
| 50–59 | 27 | 2.43 / 2.25 | 114 | 69 | 1.06 / 0.97 | 133 |
| 60–69 | 53 | 2.48 / 2.52 | 98 | 68 | 1.08 / 1.16 | 127 |
| 70–79 | 21 | 2.44 / 2.94 | 104 | 28 | 1.73 / 1.70 | 127 |

Point by point, 105 of 105 TempIQ points fall inside one of our charges (±30 min): **electrical kWh ratio
1.00** (both integrate SPAN), **thermal ratio 1.93, COP ratio 1.85.** Decomposition: TempIQ's
`EFFECTIVE_THERMAL_MASS_GALLONS = 150` ("tank + distribution piping water", hydronic-system-learner.ts:294)
vs our 110 = ×1.36; its `robustTempDelta` (a fitted trajectory over the session's readings) reads a median
7.3 °F where end − start reads 4.6 and max − min reads 8.9 = ×1.42 (the fit sees the start dip as rise).
TempIQ's number is closer to "heat the pump produced, loop included" — i.e. closer to our pump-side view;
ours is "heat that arrived in the tank". For the planner's question — what does a °F of tank cost — the
tank side is right. TempIQ's reported sink (60–86 °F on some points) is not the tank at those times; it is
a separate defect (gtm#1635).

### 2.6 The pump-side method, and why the draw correction is only a bracket

**Lift × flow.** The Modbus feed carries outlet and inlet every 60 s. ∫(outlet − inlet) dt over a charge,
times the loop flow, is the pump's heat output with no tank probe, zone draw, DHW or stratification in it.
The flow is not measured, so it was calibrated on the deep (≥ 12 °F) charges, where tank rise is sound:
**Q = 37–43 L/min (IQR 32–43, ≈ 10 gpm)**, the same for zone-free and zone-calling charges; shallow
charges imply 18–24 L/min, which is the loop-reheat gap of §2.3, not a different flow. The lift is not
constant across weather — pump 1 averages 3.6 °C at 20–39 °F outdoor and 4.3–4.5 °C at 50–69 °F — which
is what a fixed-flow circulator with cold-weather capacity derating looks like, so a constant Q is the
right model. Tables use Q = 38 with the 32–43 range as the band. Caveats: Modbus temperatures are
integer °C (±12 % per sample on a 4 °C lift, averaged out over a charge but with any truncation bias
absorbed into Q); the 60 s sampling misses the coldest part of the start slug; and because the deep
charges used for calibration also lose some loop heat, **the pump-side COPs are biased low** — the
tank-side marginal 3.0–3.5 is the better estimate of the compressor's steady-state COP.

**The draw rate is not stationary.** Tank fall rate in no-charge intervals ≥ 60 min, by minutes since the
charge ended (hourly zone state):

| minutes after charge end | zone calling, °F/h p50 (IQR) | no zone calling |
|---|---|---|
| 0–10 | −9.0 (−12.0 → −3.9) | 0.0 |
| 10–20 | −4.2 (−10.5 → −1.2) | 0.0 |
| 20–40 | −1.2 (−2.4 → +9.3) | 0.0 |
| 40–60 | −2.4 (−4.8 → +30) | 0.0 |

(0.0 is the probe's 0.1 °F resolution per 5 min hiding the −1 °F/h standby; the positive p75 values are
pump runs hidden in SPAN outages on Oct 14–17.) Whether the fast early fall is the zone call ending or
the probe watching a stratified hot layer drain past it cannot be told from hourly zone state. A 30-min
slope straddling that curve is therefore not a draw rate, which is why every "corrected" figure above is
marked a bracket. Room warming time is irrelevant here — a slab zone pulls heat from the tank the moment
its circulator runs, at roughly flow × (supply − return), for the whole call; what is missing is *when* the
call starts and stops. PR #217 stores that at 5 minutes (`zone_call_samples`); with it, draw rates can be
fitted from steady windows that skip the first 15 min after a charge and the first 10 min after a call
starts, and applied inside charges — the extraction-model approach TempIQ's hourly path already uses.

## 3 · Part B — pump outlet → tank margin

Readings while `state = 'heating'` joined to the nearest tank sample ≤ 3 min away (Oct 12–19; Modbus
temperatures are integer °C, so 1.8 °F quantisation):

| | n | p10 | p25 | **p50** | p75 | p90 | inlet − tank p50 | outlet − inlet p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pump 1, outlet − tank °F | 1 143 | −1.7 | 0.6 | **3.6** | 7.0 | 10.0 | −3.9 | 7.2 |
| pump 2, outlet − tank °F | 387 | −2.3 | −0.2 | **2.9** | 5.5 | 7.4 | −5.2 | 9.0 |

| slice | outlet − tank p50 | inlet − tank p50 | lift p50 |
|---|---:|---:|---:|
| tank < 125 °F (n 1 068) | 2.2 | −5.0 | 7.2 |
| tank 125–135 (384) | 8.0 | +0.7 | 8.1 |
| tank ≥ 135 (78) | 8.8 | +0.7 | 9.0 |
| outdoor 20s / 30s / 40s / 50s | 0.2 / 1.1 / 4.3 / 5.4 | −7.0 / −5.9 / −3.6 / −3.4 | 7.2 / 7.2 / 7.2 / 9.0 |
| September, no zones (2 238) | 6.0 | −3.2 (p1) / −4.9 (p2) | 9.0 / 10.8 |

Reading it: the pumps lift 7–9 °F (4–5 °C) regardless of conditions. On cold nights with zones drawing,
the water the pump receives from the tank is 6–7 °F *below* the mid-tank probe and its outlet is barely
above it — the pump runs flat out against a tank that is being drained from the bottom. Above 125 °F
(soaks, banks, mild days) the inlet matches the probe and the outlet sits 8–9 °F above it.

**Convergence at charge end (68 usable charges):** tank ends **+2.7 °F above the HBX target** (IQR 2.2 →
3.1; htDif = 4 with the stop at the top of the band plus one 5-min sample of lag). The pump's own setpoint
is set ~6 °F above the HBX target (126/120, 135/129, 145/137–140) and is **never the thing that stops a
charge** — the HBX drops the call first, with the pump setpoint still 5–6 °F above the tank. The hottest
outlet in a charge is 5.5 °F above the final tank temperature; at the 140 °F soak the outlet reached
149–151 °F, above the 145 °F setpoint, so the setpoint is not a hard outlet cap either. No post-stop rise
is visible at 5-min resolution (t_max − t_end ≈ 0; the probe sits flat for an hour after a zone-free charge).

**Lag (59 charges with ≥ 3 °F rise):** outlet ≥ inlet + 2 °C at **1.2 min** after SPAN power; tank probe
+1 °F at **8.3 min** (IQR 4.3 → 11.6), +3 °F at 10.7 min; `state = 'heating'` reported at 0.6 min. At the
~10 gpm of §2.6, 8 min is most of a tank volume circulated before the probe moves.

**What this says about `BUFFER_MARGIN_F = 4.5`:** nothing directly. The constant is tank → emitter
supply; the emitter loop's temperature is not measured anywhere, and these numbers are the pump → tank
side. Two things carry over: (1) the tank is stratified by 3–7 °F between the mid-tank probe and its
bottom draw while charging — if the emitter loop draws from the top it may see *more* than the probe, if
from a mixed port, less; (2) the probe lags the pump by ~8 min, so a "tank at target" reading means the
tank *was* there, not that supply water is. A margin assumed from a single mid-tank probe should be read
as ±4 °F until the loop is measured (handoff: "measure via reg 2051 later").

## 4 · Confounds (in order of size)

1. **Zone draws.** Since Oct 16 Upstairs Bathroom calls in nearly every hourly snapshot; 50 of 68
   charges are "zone-calling". Tank-rise COP is a lower bound; the draw correction is a bracket (§2.6).
   The pump-side method is immune to draws but inherits C_eff through its flow calibration.
2. **DHW draws** are invisible in October (TempIQ's feed and water-meter contamination filter stopped
   Sep 28). "DHW-hours" is time-of-day only. September is not filtered either, so §2.5 includes draws
   TempIQ excluded — another reason its points read higher.
3. **One mid-tank probe, 5 min, 0.1 °F.** Start dips of 2–5 °F in the first five minutes, 8-min lag,
   ±4 °F sample-to-sample bounce on cold nights. Per-charge tank-rise COPs for 3–5 °F rises carry ±50 %
   from this alone; the pooled, regression and pump-side numbers are the ones to use.
4. **C_eff 110 [90, 125]** = ×0.82 … ×1.14 on every COP, both methods; and whether loop water counts
   as delivered heat (TempIQ and the pump side say yes, tank rise says no) is a definition.
5. **Depth, sink and weather are confounded** by how the HBX runs: cold nights = deep banks at 135–140;
   mild days = shallow floor top-ups at 120.
6. **Pump 2 was in fault Oct 14–15** (2 390 samples) and the tank fell to 77 °F before Oct 16; the
   Oct 6–11 SPAN coverage is 12–79 %, so the window starts Oct 12 on purpose. Oct 14–17 SPAN outages
   hide some pump runs from the no-charge statistics but no usable charge straddles one.
7. Modbus inlet/outlet are integer °C; `readings.power_w` (20–35 W) was not used for anything.

## 5 · What would make this claim-grade

- **The electric-element calibration charge** (ceff-resolution.md): COP = 1.000 exactly, fixes C_eff,
  the loop-reheat share of the overhead and the circulator flow in one owner-gated evening.
- **One flow measurement on the pump loop** (or the circulator's rated curve): makes the pump-side
  method independent of C_eff and turns the Modbus feed into a heat meter.
- **A DHW draw signal in the mirror** (StreamLabs main meter, or TempIQ's water-meter buckets once
  gtm#1635 un-quarantines the COP path) so October charges can be draw-filtered like TempIQ's September.
- **5-min zone-call state** — PR #217 (`zone_call_samples`), then a fitted draw model per calling set.
- **A second tank sensor (top or bottom) or the emitter supply temperature** (reg 2051 / mixing-valve
  output, #138) — the only way to turn "outlet − probe" into "tank − emitter" and settle BUFFER_MARGIN_F.
- **TempIQ's `learnedThermalMassGallons` set to 110** and its per-session points flowing again.
- **A deliberate depth experiment**: the same night, alternate htDif 4 and ~10 °F at the floor and compare
  Wh/°F on both methods — the cleanest test of the per-start loss, and a look at the loop's insulation.

## 6 · Reproduce

`scripts/analyze-local.sh a2w_local`, then: pump power per poll = Σ(−power_w) over the two Air-Water
circuits; charge = runs of power > 300 W with gaps ≤ 600 s bridged (gaps-and-islands in SQL); per charge
join `slx_readings` for the last sample before start / first after end, `readings` for pump state, inlet
and outlet, `zone_floor_snapshots` for calling zones; tank-side COP = 917.4 × ΔT / 3412.14 / kWh;
pump-side thermal kWh = Q[L/min] × 0.06977 × Σ(outlet_c − inlet_c)·dt[°C·h] with dt ≤ 120 s. Margin:
`readings` where state = 'heating' joined to the nearest `slx_readings` within 180 s. The scratch SQL
lived in the session scratchpad; nothing was added to the repo and nothing was written to production.
