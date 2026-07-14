# Matched A/B charge protocol — the clean °F-vs-COP slope (designed 2026-07-14)

> **Purpose:** A-4 proved LWT follows the setpoint but couldn't cleanly price it — the
> 71 °C segment was confounded by the power-cycle. This protocol produces the measured
> **Wh per °F of tank rise at two setpoints under matched conditions**, the number that
> converts the savings page's ~1%/°F assumption into your pumps' real slope.
> Mass-independent (same tank both days) — works before C_eff is pinned.

## Design

Two mornings with similar forecasts (within ~5 °F at 06:00, both dry), same weekday class:

| | Day A | Day B |
|---|---|---|
| 06:00 | Dashboard → Control → set **HP1+HP2 = 75 °C** | set **HP1+HP2 = 68 °C** |
| 06:05 | Dashboard → Control → HBX card → **Set target 131 °F** (arms a deep charge; doubles as that day's I8 sanitize boost) | same |
| — | Let the charge run to HBX termination; no draws if avoidable (shower after) | same |
| after | **Restore curve** (HBX card) + set pumps back to 75/71 °C | same |

Everything is ordinary dashboard operation — no code, no SSH; each step is audited.

## Measurement (mine, post-hoc per day)

- Charge window: from stage-call start to HBX termination (slx `stages_called`).
- Electric in: SPAN 10-min buckets for the active pump circuit(s) across the window.
- Tank rise: slx `tank_f` end − start.
- **Result: Wh/°F at 68 vs 75 °C**, plus ambient correction from the two days' outdoor
  means (small if the mornings matched). Report lands in `a4-results.md` as the follow-up
  section, and the savings page's `COP_SENS_PER_F` gets replaced by the measured value.

## Validity guards

- Abort/re-run if: a big draw hits mid-charge (tank slope reverses), the second pump
  stages in on only one of the days (compare `stages_called`), or outdoor differs > 8 °F.
- Two repetitions per arm (4 mornings total) if the first pair disagrees > 15 %.

## Why mornings

The 06:00–09:00 DHW window means a call is guaranteed, conditions are repeatable
(pre-solar), and the boost usefully pre-heats the day's showers — the experiment costs
almost nothing.
