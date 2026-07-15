# W0-5 — storm wiring: pollers + events + notify-first + manual API (issue #12, plan §6.11)

Modify `planner/src/index.ts` and (minimally) `planner/src/shadow.ts`. Notify-first:
with the enable flag off, storm triggers page the owner but never shape the plan
(plan §11 Q6 is an open owner question).

## index.ts

- New envs: `STORM_MODE_ENABLED` ("1" = shape the plan; default off = notify-only),
  `STORM_CAP_F` (default "135"), `OUTAGEWATCH_URL`
  (default "https://victorious-light-production.up.railway.app").
- Import from `./storm`: `fetchNwsAlerts`, `fetchStormForecast`, `deriveSyntheticTriggers`,
  `fetchOutageStatus`, `evaluateStormState`, `stormCeilingF`, `StormState`.
- Module state: `let stormState: StormState = { kind: "idle" }` plus a pending-manual slot.
- **Trigger poll (every 30 min, own setInterval + immediate first run):** fetch NWS alerts
  + OpenMeteo synthetic triggers (each in try/catch → empty array on failure; log warn).
  Cache them.
- **Every 5-min loop (inside `loop()` after `pollOnce`):** `fetchOutageStatus` →
  `evaluateStormState(stormState, { alerts, synthetic, outageActive, manual: pendingManual }, new Date())`;
  clear the manual slot after consuming. On each transition string:
  - persist: entering armed/active → `store.insertStormEvent(trigger, detail, ceilingF)`;
    returning to idle → `store.closeStormEvent()`;
  - `ntfy("Storm mode: <transition>", <human detail>, "high")` for arm/active,
    default priority for stand-down.
- **Plan shaping (only when `STORM_MODE_ENABLED` and state is armed/active):** in
  `shadowOnce()`, after `computeShadowPlan`, for blocks whose `ts` falls inside
  [windowStart, windowEnd]: `tank_target_f = max(tank_target_f, round(stormCeilingF(curveTargetF(cfg, block.outdoor_f), STORM_CAP_F)))`,
  recompute `hp1_setpoint_f = clamp(tank_target_f + opts.i1MarginF, opts.hpMinF, opts.hpMaxF)`,
  and set `reason = "storm mode: banking heat (" + trigger + ")"` — **only-raises rule:
  a block's target is never lowered.** Import `curveTargetF` from `./shadow` if not already.
- **Manual API (both require the existing `authed()` bearer check):**
  - `POST /api/storm/arm` body `{ hours?: number }` (default 24, clamp 1–72) → set the
    pending-manual slot, run the evaluation immediately, respond `{ state }`.
  - `POST /api/storm/disarm` → pending disarm, evaluate immediately, respond `{ state }`.
- `/health` gains `storm: { state: stormState.kind, trigger, windowEnd, enabled: STORM_MODE_ENABLED }`
  (trigger/windowEnd null when idle).

## Constraints
- Disabled flag ⇒ `shadowOnce` output unchanged.
- OutageWatch/NWS/OpenMeteo failures never arm anything and never crash the loop.
- `npx -p typescript tsc --noEmit -p planner/tsconfig.json` passes. Max 2 files changed.
