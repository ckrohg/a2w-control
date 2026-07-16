# TempIQ auto-pilot — design & rollout

**Drafted 2026-07-16.** Goal: the HBX buffer target (and eventually pump setpoints) follow an
optimizer continuously instead of a fixed manual value. Scaffold shipped (commit `c8bbd7c`,
flag-off). A2W stays STANDALONE — TempIQ is advisory; if it's down, A2W falls back safely.

## The pieces already existed
- **The optimizer** — `planner/src/shadow.ts computeShadowPlan()` already produces an hourly optimal
  `tank_target_f` (24h) from the outdoor forecast + DHW windows + I8 sanitize + the **TempIQ demand
  floor** (`demand.ts DemandFeed`, which turns TempIQ's learned zone physics into a required
  supply-water temp). Written to `shadow_plans`, advisory until now.
- **The guarded write** — `writes.ts HbxWriter.setTarget()`: the single entry, clamps to the I4
  envelope (`strictCapF=135`), I1-cross-checks live setpoints, respects the sanitize floor + a
  15-min rate limit. Anything the auto-pilot commands is clamped safe here.
- **The template** — `phaseb.ts` (setpoint tracker): flag-gated, dry-run-first, applies a computed
  value each poll cycle. The auto-pilot is its target-side twin.

## What shipped (`planner/src/autopilot.ts`)
`AutoPilot.applyLatestPlan()`, called each poll from `pollOnce()`:
1. Read the latest shadow plan, pick the current-hour block's `tank_target_f`.
2. Skip if already commanded there (avoids curve churn / rate-limit spam).
3. `DRY_RUN` → log "would set X°F (reason)". Live → `writer.setTarget(target, "autopilot")`.
4. The 15-min rate limit is treated as normal (retry next cycle); I4/I1 rejections are the
   guardrails working — logged, not paged (the standing I1 + adoption monitors cover sustained fail).

Flags (same pattern as Phase B): `AUTOPILOT_ENABLED=1`, `AUTOPILOT_DRY_RUN=1`.

## Rollout (dry-run first — do NOT skip)
1. **Dry-run** (`AUTOPILOT_ENABLED=1 AUTOPILOT_DRY_RUN=1`): watch the logs for a few days — what would
   it set each hour? The shadow plan targets 120°F off-window/DHW-window / 131°F daily sanitize —
   lower than the manual 135 (COP + standby win) but never below DHW-ready. **Off-window idle was
   raised 110→120 (commit 337628a):** the buffer feeds DHW and draws are unpredictable/year-round, so
   it must not coast below what a tap needs — enforced `Math.max(idleF, dhwFloorF)` in `shadow.ts`.
   Still **validate the windows match real usage before writing** (tune `DEFAULT_OPTS`
   `dhwFloorF`/`idleF`/`dhwWindows`; idle can be raised to bank extra capacity, never below dhwFloorF).
2. **Companion — Phase B** (`PHASE_B_DRY_RUN` → live) so the setpoints track the auto-pilot target
   down (the COP half). Full autonomy = both live.
3. **Live** (`AUTOPILOT_DRY_RUN=0`): the buffer now tracks the plan. Rollback = unset the flag (last
   commanded curve stands) or manual restore to baseline.

## What TempIQ still needs to expose (nice-to-have, not required)
A2W already derives the required buffer target locally (`DemandFeed`). To centralize the zone-physics
logic, TempIQ could expose a `GET /api/insights/recommended-buffer-target?outdoor_f=…` (+ an hourly
24h `demand-forecast`). Filed as a TempIQ issue. Until then, A2W's local demand floor is the input.

## Safety
Every command routes through `setTarget` (I4/I1/sanitize/rate-limit). The plan can't push an unsafe
target. TempIQ down → demand floor null → shadow plan uses the HBX curve → house heats safely.
Adoption is guarded by the 2026-07-16 adoption monitor. Rollback is a single flag.
