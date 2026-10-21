# The identification driver's "plan wants X °F" must be what the auto-pilot COMMANDS, not `block.tank_target_f` (2026-10-20)

**Question.** #215 (stale SensorLinx report → use the curve in force) merged at 05:36Z on 2026-10-20. Six minutes
later `/health.identification.lastResult` read *"idle: plan wants 135 °F but the plant is at 120 °F — letting the
auto-pilot settle the base first"*, with `curve.in_force` 120/118 (dot 29, wwsd 125, shaped **true**, output
119.8 °F) and `curve.plan_implies` 120/118. The stale-report proof had done its job — the base was finally the
curve in force — and the NEXT gate stalled the driver. Why would the auto-pilot never settle the plant at 135 °F?

**Verdict.** Because it never commands 135 °F. Under `SHAPED_CURVE` live, `curveDecision()` in `autopilot.ts`
classifies every non-excursion block that carries a stamped `shaped_curve` as a **curve hour**: the auto-pilot
writes the curve's endpoints (`set_curve`) and the device drives to the curve's output at the live outdoor.
`block.tank_target_f` is written only for **excursions** (bank / soak / pre-boost / storm, by flag or by the legacy
reason regex) and for blocks without a curve. The identification driver's `currentPlanTargetF()` read
`tank_target_f` for its plan-settled gate, for `plan_moved` and for the `plan_moved` handoff. The two numbers agree
on floor hours (tank_target_f 120 vs curve output 119.3–121.7) and diverge by 15 °F on **"winter guard: mimic HBX
curve"** blocks, whose `tank_target_f` mimics the AS-FOUND curve (141/137 at dot 30 → 135 °F at 49 °F) while the
stamped curve is the demand curve (120/118). The driver idled on every such hour; nothing was unsafe, nothing was
probed. The fix (this doc's PR) gives the auto-pilot one pure function, `commandForBlock()`, that says what it
drives the plant to for a block, and routes all three driver comparisons through it. Not a plan bug, not a
device bug: two readers of the same plan block that had drifted apart since #133 (b) went live.

Everything below is from the local restore of `a2w-db-2026-10-20T014442Z` (`scripts/analyze-local.sh`; plans to
21:19 ET Oct 19, SensorLinx to 21:44 ET), the live `/health` at 05:42Z Oct 20 and the planner source at `6adae66`.
No production query was run.

---

## 1 · The live case, row by row

| source | row | ET | what it says |
|---|---|---|---|
| `shadow_plans` | 2322–2325 | 18:19–21:19 | blocks 19:00, 20:00, 21:00, 22:00: `tank_target_f` **135**, outdoor 44.0–48.8, reason `winter guard: mimic HBX curve`, no `sani`/`bank`/`boost`/`storm`, `shaped_curve` {dot 28–29, dbt **120**, mbt **118**, wwsd 125} |
| `autopilot_log` | 1886 | 19:04 | `target_f` 135, reason `winter guard: mimic HBX curve`, result **`set-curve`** |
| `autopilot_log` | 1887 | 19:09 | same, `held-curve` (the dedup key then swallows the rest of the evening) |
| `hbx_writes` | 1380 | 19:04:24 | `autopilot` **`set_curve`** {dbt 120, dot 29, mbt 118, wwsd 125} accepted — *"output 119.6 °F at 49 °F outdoor"* |
| `/health` | — | 05:42Z | `identification.lastResult` "plan wants 135 °F but the plant is at 120 °F"; `demand_floor_cadence.lastBlockF` 135; `curve.in_force` 120/118 shaped true, output 119.8; `curve.plan_implies` 120/118 |

The same afternoon shows both auto-pilot paths side by side (`hbx_writes` 1372–1379): at :04 every hour the
"DHW window floor" block (tank_target_f 120) was written as `set_curve` 120/118, and at :19 the re-planned
"afternoon bank to 128 °F" block was written flat, `set_target` 128 (the #218 double write, fixed separately).
The ledger's `target_f` on a `set-curve` row is the block's declared number, **not** what was written — the
endpoints are in `hbx_writes`.

### Why the block said 135

`computeShadowPlan` (shadow.ts) takes the winter-guard branch for any hour below `winterGuardF` (50 °F) when
`shadowOnce` passed **no demand floor** (index.ts: the floor is null when TempIQ's insight has no binding zone —
"the demand floor has never bound", deep dive 2026-10-19). The branch raises the block to the as-found curve's
output at the forecast outdoor (`curveTargetF(hbxConfig, …)`: 141/137 → 135 at 49 °F) and labels it
"winter guard: mimic HBX curve". In the same `shadowOnce`, with the demand feed healthy, `shapeCurve()` stamps the
demand-shaped curve (120/118: demand at the design outdoor is at or under the 120 °F DHW floor) on every block.
Under `SHAPED_CURVE` live the stamped curve is the command and the winter guard's 135 is informational. That
split is #133 (b)'s design, not an accident — the shaped curve's whole point is to replace the generic as-found
curve with the measured demand — but nothing told the identification driver.

## 2 · How often, since Oct 15

Hourly samples at :30 local, 2026-10-15 00:30 → 2026-10-19 21:30 ET (118 hours), the block in force from the
newest plan computed by then, the curve's output at the live outdoor (nearest `slx_readings` ≤ 1 h):

| hour kind (what the auto-pilot writes) | hours | block target − curve output | reasons |
|---|---:|---:|---|
| curve hour, block target **≥ 3 °F** off the curve | **20** | +14.5 … +15.4 | `winter guard: mimic HBX curve` — every one |
| curve hour, block target within 3 °F | 78 | −1.7 … +0.7 | `DHW window floor`, `off-window DHW-ready floor` |
| excursion (flat write of tank_target_f, by design) | 20 | +7.2 … +24.6 | bank, daily sanitize, pre-boost |

So 20 of the 98 curve hours in five days — about one in five — put the driver's gate 15 °F away from the plant,
and the gate idles at ≥ 3 °F. (A 21st block carried the winter-guard reason — Oct 17 13:00, target 145: the soak whose
reason the guard overwrote, the #168 class — but kept its `sani` flag, so it was written flat and counted as an excursion.) In the de-duplicated `autopilot_log` the same stretch shows 59 hours with a curve
decision row, 12 of them winter-guard; the ledger undercounts because an unchanged `held-curve` is not a new row.
Shaped curves have been stamped on every plan since 2026-09-29 17:12 ET; the auto-pilot has written them live since
#133 (b) went live on 2026-09-30.

## 3 · What the auto-pilot writes, per block kind — and therefore what the driver compares against

| block | identity | auto-pilot, `SHAPED_CURVE` live | the plant goes to | driver now uses |
|---|---|---|---|---|
| DHW window floor, off-window floor, binding-zone demand floor, **winter guard**, floor-cadence raise, DP raise | no flag; reason outside the excursion regex | `set_curve(shaped_curve)` when its endpoints differ from the device's | `curveOutputF(shaped_curve, live outdoor)` | the same, rounded to 1 °F |
| afternoon bank (#58) | `bank` / "bank" | `set_target(tank_target_f)`, everyday cap | `tank_target_f` | `tank_target_f` |
| daily soak (I8) | `sani` / "sanitize" | `set_target`, `sanitizeCapF` | `tank_target_f` | `tank_target_f` |
| pre-boost (#135) | `boost` / "boost", "pre-charge" | `set_target` | `tank_target_f` | `tank_target_f` |
| storm raise (§6.11) | `storm` / "storm" | `set_target`, `STORM_CAP_F` | `tank_target_f` | `tank_target_f` |
| any block without a usable `shaped_curve` (feed degraded, malformed curve) | — | `set_target(tank_target_f)` | `tank_target_f` | `tank_target_f` |
| any block, `SHAPED_CURVE` off or **shadow** | — | `set_target(tank_target_f)` | `tank_target_f` | `tank_target_f` |
| block with no finite `tank_target_f` | — | nothing ("plan block missing tank_target_f") | unchanged | nothing → gate fails closed |

Two details that matter: the resolver takes the **instance's** shaped-curve mode (`autopilot.commandForBlock`),
so `SHAPED_CURVE=shadow` — stamped but written flat — resolves flat, as it should; and an excursion is decided by
`curveDecision()` itself, so a reason the floor cadence rewrote still counts through the flag (#135, a2w#156).

## 4 · The fix

- `planner/src/autopilot.ts` — `commandForBlock(block, outdoorF, shapedCurve)`: pure; null when the block has no
  finite `tank_target_f` (the auto-pilot refuses it before classifying) or a curve hour has no outdoor to evaluate
  at; `{ targetF, basis: "curve" | "flat" }` otherwise. `AutoPilot.commandForBlock(block, outdoorF)` applies the
  instance's mode. `curveOutputF` is `curve.ts`'s — the same function `/health.curve` and Phase B's lead use.
- `planner/src/identify.ts` — `currentPlanBlock()` (the block in force) and `currentPlanTargetF(plan, now,
  command)` with the declared target as the default resolver; the driver's private `planCommandF()` resolves
  through `autopilot.commandForBlock` at the live SensorLinx outdoor (the block's forecast `outdoor_f` stands in
  when there is no live reading). Three comparisons now use it: the plan-settled gate in `maybeStart`, `plan_moved`
  in `tick()`, and the handoff refresh in `cleanupPending()`. When the command and the declared target differ the
  idle reason shows both: *"… [the block says 135 °F; the auto-pilot commands its shaped curve, 120 °F at 49 °F
  outdoor]"*.
- `plan_moved` semantics follow: on a curve hour a declared `tank_target_f` moving 135 → 140 moves nothing (the
  window stays open); a re-shaped curve moves the base even when `tank_target_f` is unchanged; a steep winter
  curve lets the device itself carry the plant ≥ 3 °F across a window on a large outdoor swing, and that is a
  genuine `plan_moved` (the plant is no longer where the window recorded it).
- Tests: `identify.test.ts` §11 (the live block in both modes, the steep curve, the curve-less block, the
  refused block, `plan_moved` on a hold arm and on a live probe with the handoff at the curve's output, flat mode
  unchanged) and `autopilot.test.ts` §11 (the resolver against every block kind, and the instance's
  `commandForBlock` agreeing with what `applyLatestPlan` wrote for the same block). `tsc` clean, 33 suites green.
- Left alone: `stale-target.ts` and the stale-report proof (#215), `shadow.ts` and the plan's numbers, #218.

## 5 · Not changed — follow-ups

1. **Phase B leads the declared target — done in the follow-up PR (a2w-control#222, stacked on this one; deploys
   the planner).** `phaseb.ts currentPlanTarget()` read `block.tank_target_f` and led the pump setpoints to
   `max(operative, plan, probe, curveLead)`: on a winter-guard hour it led 135 + margin while the plant sat at 120.
   Now `planLeadF()` leads `commandForBlock`'s number for the block in force — on a curve hour the curve's EXACT
   output (the resolver's whole-°F rounding would sit under the `setCurve` I1 cross-check at the zero-slack points
   117 / 126 / 135 / 144 °F, where a whole °C is a whole number of °F + 5), on an excursion the flat `tank_target_f`
   as before — plus the NEXT block's curve at its forecast outdoor when that block is a curve hour (the device's
   curve, which `curveLeadF` reads, is a flat line after an excursion and does not cover the curve the auto-pilot
   writes back at the top of the hour), and never an excursion ahead (a soak / bank / pre-boost is led once in
   force, exactly as before, so the hour before it does not run hotter). The declared target still leads when the
   command cannot be evaluated (no outdoor anywhere); the device curve and the operative report stay in the max; so
   no lead is ever below what the auto-pilot writes. `/health.phase_b.lead` shows every term of the max.
   **What it cost**, from the same restore (scratch `lead_hours`, the 118 hours of §2): on 13 of the 20 winter-guard
   hours the 135 term set the setpoint — 60 °C sent to both pumps, 52–55 °C under the command. On the other 7 (Oct 17
   04:30–06:30 and 14:30, Oct 19 19:30–21:30) the frozen post-soak report (139.9 / 142 °F) set it — 63–64 °C — and this
   change does not touch that term (item 5). During calls on the winter-guard hours pump 1 ran at a 60.3 °C setpoint
   (floor hours: 56.7) and its outlet reached 65 °C, with 22 % of heating minutes at ≥ 60 °C (floor hours: 14 %); at a
   52 °C setpoint — what these hours get now — the outlet sits at the setpoint 44 % of the time and never passes 54 °C:
   the pump modulates against its setpoint instead of running free to 64–65 °C. Only six winter-guard hours had calls
   at all, and call length depends on the tank at call start, so no COP figure is claimed.
2. **The winter-guard block's 135 is informational under shaped-curve live.** `/health.demand_floor_cadence
   .lastBlockF`, the dashboard's plan strip and `plan_scores` all show the declared number. Whether the stamped
   curve should itself be floored by the as-found curve below `winterGuardF` (the guard's intent) is a winter-DP
   design question (#87), not a driver question.
3. **The `plan_moved` handoff on a curve hour is a flat write** of the curve's output. In October the stamped
   curve has a 2 °F spread, so the flat line sits within `APPLY_TOLERANCE_F` of it and the auto-pilot holds it as
   "already commanded". A steep winter curve (dbt 135 at dot 5) differs at the dbt endpoint and the auto-pilot
   rewrites the curve after the 15-min slot. Acceptable; a `setCurve` handoff would be the tidy version.
4. **`autopilot_log.target_f` on a `set-curve` row is the declared target**, not the command (1886: 135,
   set-curve). The ledger reads correctly only beside `hbx_writes`; recording the curve's output there would make
   the dashboard honest on its own.
5. **Phase B's operative term is the raw report.** `runOnce()` tracks `getLatestSlx().targetF` as reported, so the
   frozen post-soak report (`stale-slx-target-2026-10-19.md`) leads both pumps to 63 °C for 7–16 h after every soak:
   39 of the 78 floor hours since Oct 15 had the report ≥ 3 °F above the curve (Phase B's setpoint on floor hours
   averaged 55.6 °C, max 63), and it set the setpoint on 7 of the 20 winter-guard hours in item 1. The #215 proof
   (`stale-target.ts`) says when the curve in force is the operative target; Phase B should read the report the same
   way. More hours than item 1; a separate PR, since it changes live setpoints.

Related: `stale-slx-target-2026-10-19.md` (the gate before this one), `bank-rebank-2026-10-19.md` (#218, the :04/:19
double write visible in §1), `incident-20261016-hp2-e21-investigation.md` §6 (why the winter guard exists at all).
