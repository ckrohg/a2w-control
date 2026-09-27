<!--
@purpose DESIGN for #127 "Set & forget" — the middle autonomy mode the owner asked for on 2026-07-15
("should definitely be a curve to keep us in safe and good standing"). Design-first because it is a
control-path mode on live heating. Decisions the owner must make are marked ⬜; my recommendation
follows each. Nothing here is built. Written 2026-09-27.
-->

# Set & forget — design (DRAFT, owner decisions marked ⬜)

## What it is, in one sentence
**The planner writes ONE owner-chosen reset curve through the guarded path and then holds it** — no
hourly replans, no winter DP, no storm shaping — while everything load-bearing keeps running: Phase B
still tracks pump setpoints to the operative target (I1), the I8 sanitize soak still happens, every
guardrail still applies, and the dashboard shows the held curve as runtime truth.

It is the mode for "I don't want an optimizer second-guessing the plan right now, but I do want the
house to keep behaving." Today that gap is filled by **Off** (both controllers shadow — the house runs on
whatever curve was last written, unmanaged) which is not the same thing.

## Where it sits
| mode | autopilot (target) | Phase B (setpoints) | DP / storm / demand floor | I8 soak | heartbeat |
|---|---|---|---|---|---|
| Off | shadow | shadow | shadow | monitor-only | "planner quiet" |
| **Set & forget** | **holds ONE curve** | live (tracks it) | **off** | **live** | "Held curve dbt/mbt · live" |
| Armed | live, hourly plan | live | live | live | "Tank target · live" |
| Request | — closed, not built (#128) | | | | |

## The elegant implementation: a plan generator, not a new controller
Everything downstream — autopilot's write path, Phase B's `max(operative, planned-current-hour)`
lead, the I8 soak via plan→autopilot→Phase B, the I1/I4/rate-limit/audit stack — consumes a
**plan** (`computeShadowPlan` output: per-hour `tank_target_f` + `hp1_setpoint_f` + reason). So Set &
forget should be **a second plan generator**: for every hour, target = the held curve evaluated at that
hour's forecast outdoor (`curveTargetF(heldCurve, outdoor_f)`), plus the sanitize block when
`sanitizeDueNow()` says so. Then:
- autopilot writes exactly what it writes today — the held curve simply never changes shape;
- Phase B, I1, I8, the single-writer lease and the audit log are untouched;
- storm shaping and the DP are skipped by one mode check (`controller_flags.mode === "set"`);
- the 501 for `set` in the autonomy handler goes away; `req` stays 501 (closed as #128).

**State:** `controller_flags` gains `held_curve jsonb` `{dot, wwsd, dbt, mbt}` (the HBX reset-curve
endpoints — the same four the as-found seed row uses). `controller_status` (the heartbeat) reports
`mode` and `held_curve` so the dashboard's "Running now" is runtime truth
(`dashboard-reflect-runtime-not-hardcode`).

## ⬜ Decision 1 — what the held curve is seeded from when you flip to Set
(a) the **as-found** curve (dot 5 / wwsd 125 / dbt 165 / mbt 145 — the pre-A2W regime, hot, proven safe)
(b) the **curve the house is running right now** (the last autopilot-written near-flat curve)
(c) an owner-entered dbt/mbt in the UI, required before the mode activates

**Recommend (b), editable.** Least surprise: flipping to Set changes *nothing* until you edit it. (a)
would jump the tank 20–45 °F hotter on a mode switch (`a2w-storm-precharge-economics`), which is the
opposite of "forget". (c) blocks the switch on a form.

## ⬜ Decision 2 — storm mode while Set
(a) **off** — the held curve is the whole plan; the trigger still pages ("High Wind Warning — you're in
Set & forget, no pre-charge will happen")
(b) an only-raises overlay, as in Armed

**Recommend (a).** The point of the mode is that nothing moves the curve but you. The page keeps you
informed so the choice is yours, per storm.

## ⬜ Decision 3 — a winter lower bound on what curve Set will accept
In Armed, the demand floor and DHW floor guarantee the tank never coasts below what a draw or a
calling zone needs. In Set, **you own comfort** — a too-cool curve in January means cold baseboards.
(a) no bound beyond the existing envelope (I4 band, strictCap) — trust the owner
(b) refuse a held curve whose output at design outdoor (2.2 °F) is below `dhwFloorF` (120 °F) — the
DHW-ready floor is unconditional in every other mode and should be here too
(c) (b) plus a warning, not a refusal, when it sits below the local `requiredAwtF` for a verified
baseboard zone

**Recommend (b) as a refusal and (c) as a warning.** `hbx-override-modbus-wins`: a wrong curve *can*
hold heat off; the DHW floor is the one line the rest of the system never crosses either.

## ⬜ Decision 4 — a foreign writer moves the curve while Set
The single-writer detector (#36) already pages on `HBX config changed (outside the planner)`.
(a) alert only (today's behaviour)
(b) re-assert the held curve on the next poll (rate-limited, audited as `set:reassert`)

**Recommend (b).** "Hold" should mean hold. The 15-min rate limit bounds the churn if two writers fight,
and the audit trail shows who.

## Not decisions — fixed by existing rules
- Every write goes through `setTarget`/the PATCH path: envelope, I1 cross-check, 15-min rate limit,
  read-back, audit. Set mode gets no bypass.
- I8 hygiene is non-negotiable: the soak block is emitted by the Set plan generator exactly as by the
  shadow plan, so `sanitizeDueNow()` → soak → I1-coordinated via Phase B. Set cannot skip a soak.
- Switching Set → Off leaves the held curve in place (Off writes nothing). Set → Armed resumes replans.
- The Railway env `AUTOPILOT_DRY_RUN`/`PHASE_B_DRY_RUN` remain seeds only; the row is authoritative.

## Surfaces
- **Planner:** `setPlan(heldCurve, forecast, sanitizeDue)` generator; mode check in the storm/DP passes;
  `/api/autonomy` accepts `{mode:"set", held_curve?}`; heartbeat carries `held_curve`; `/health` shows
  `autonomy: {mode, held_curve}`.
- **Mirror:** the Set & forget segment actuates (drop PREVIEW ONLY); a small dbt/mbt editor with the
  envelope shown and Decision-3 validation inline; "Running now" renders the held curve.
- **Tests:** generator returns the curve's target per hour; sanitize block still emitted when due;
  storm shaping skipped in Set; Decision-3 refusal; Set→Off leaves the curve; `req` still 501.

## Sequencing
Planner PR (through the gate — one control-plane change), then the mirror PR. After #129 and FINDING-1
are settled; not before. Estimated size: planner ~150 lines + tests, mirror ~120 lines.
