# A-4 charge-dynamics test — results (2026-07-14, live tub test)

> **Status: COMPLETE.** Protocol: owner ran a tub (sustained DHW draw); pump2 (lead this
> cycle, as-found setpoint 71 °C) was stepped to 68 °C mid-call via the guarded hub path;
> the full recovery charge was observed at 15-s cadence to termination; setpoint restored
> to 71 °C with read-back. Raw trace: session log `a4-log.csv`; energy: SPAN 10-min
> buckets. HP1 never ran (SPAN AW1 flat) — findings are for one pump, one summer charge
> (87 °F ambient); revisit as data accumulates.

## Timeline (EDT)

| Time | Event |
|---|---|
| ~15:12 | Tub draw pulls tank below 148.8 °F → HBX stage 1 calls pump2 (71 °C) |
| 15:22:47 | Step: pump2 → 68 °C (154.4 °F) via hub, accepted + verified |
| ~15:23 | Owner powers pump2 OFF via Pi UI **during the active call — unit stops** |
| ~15:27 | Owner powers back on; unit resumes **automatically after the anti-short-cycle delay** |
| 15:26–15:29 | Tank bottoms at **126.3 °F** (25 °F below target, pump running earlier — tub outruns one compressor) |
| 15:29→15:44 | Recovery climb at 68 °C: outlet tracks up, ΔT ≈ 10–11 °F |
| 15:44–15:48 | **Outlet PINS at exactly 154.4 °F (= setpoint)** — inverter modulation confirmed |
| 15:48–15:55 | Minimum-modulation tail: outlet drifts to **161.6 °F (+7.2 °F over setpoint)** |
| 15:55:11 | **HBX terminates**: tank probe 153.4 °F (= target 151.3 + 2.1); stage contact opens; pump return only 152.6 °F — its own 154.4 °F cutoff **never fired** |
| 15:57 | Restored to 71 °C, verified. System exactly as-found. |

## Findings

1. **LWT follows setpoint (Phase B premise = measured fact).** The inverter modulates to
   hold leaving water at the commanded value while charging continues — every °F of
   setpoint reduction is real condensing-temperature reduction for the bulk of a charge.
2. **…except the tail.** At minimum modulation the last ~8 min overshoot the ceiling
   (here +7.2 °F). Per-°F savings math must exclude/correct the tail; the commanded
   ceiling is not the delivered max in the final minutes.
3. **Termination margin measured: the 8 °F I1 rule was ~2× conservative.** At setpoint =
   target **+3.1 °F**, the tank sensor still terminated (never-fight invariant held).
   Mechanism: the pump's cutoff is return-based, and the mid-charge stratification offset
   (pump inlet reads **10–15 °F below** the HBX probe) collapses to ≈0 only at charge
   end — so the margin needs to cover ½·diff (+2) + end-of-charge convergence (~1) + a
   cushion. **Margin set to 5 °F** across banner/planner/write-control (commit 450a548).
4. **Modbus power-off overrides an active HBX call** (the Phase-E hard-gate answer) —
   and recovery after power-on is automatic but delayed by the compressor's
   anti-short-cycle timer (~minutes), not edge-triggered (rival hypothesis ruled out).
   Power stays human-only; W610 isolation remains the #1 perimeter control.
5. **One compressor cannot match a tub**: tank fell 25 °F+ while charging → capacity
   staging matters (plan §6.6: `lagT` 60→15 min experiment; pre-boost merged with I8).
6. **Reg 2088 is inverter-stage-only, confirmed live**: raw register read ~7 while SPAN
   metered 5.2–5.4 kW (the fixed-frequency compressor carried the load). SPAN is the only
   honest unit-power source until/unless a full register model is calibrated.

## Energy (SPAN 10-min buckets, Air-Water 2 = pump2)

| Bucket (UTC) | Wh | avg W |
|---|---|---|
| 19:10 | 19 | 116 |
| 19:20 | 521 | 3,124 |
| 19:30 | 873 | 5,236 |
| 19:40 | 901 | 5,407 |
| 19:50 | 455 | 2,729 |
| **Total** | **≈2,769 Wh** | |

**≈2.77 kWh electric for a 27.1 °F tank rise (126.3 → 153.4 °F) ≈ 102 Wh/°F.**

**C_eff / COP degeneracy:** one experiment can't pin both. If the buffer is ~119 gal
effective → COP ≈ 2.9; ~150 gal → COP ≈ 3.6 (at avg water ~140 °F, 87 °F ambient).
→ The tank nameplate (owner's basement photo) or one decay-fit night resolves the pair.
A clean 68-vs-71 °C Wh/°F A/B needs two comparable charges (the 71 °C segment today was
confounded by the off/on window) — schedulable as morning-boost comparisons.

## Actions taken / queued

- ✅ I1 margin 8→5 °F shipped everywhere (450a548) — clears the standing pump2 banner.
- Queued: `lagT` staging experiment (§6.6, owner applies in app); tank nameplate photo
  (pins C_eff→COP); repeat-charge A/B for the °F-COP slope; TempIQv2#1480 will carry
  pump-side water temps into TempIQ's COP fits.
