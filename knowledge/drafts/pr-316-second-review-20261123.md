# PR #316 — independent second review (tenet delegate, account A / Opus, read-only, 2026-11-23 10:35 ET)

Requested by the Pi/ops/reviews session before the planner lane gates #316 (a hub deploy). The reviewer saw the PR
description, the diff (base e9d8213), a checkout of the branch, main, the planner and the dashboard; nothing was run.

**Verdict: MERGE WITH NOTES.** I found no correctness bug. One message the dashboard shows people gets worse, and the 502 path misses the most common way the link actually drops.

**What I relied on:** the PR description and diff; the checkout's `hub/src/index.ts` and `command.ts`; `planner/src/{hub,phaseb,owneralerts}.ts`; the dashboard (`analytics-mirror`); `heatpump-bridge/bridge/hub_client.py`. From TENET memory: the #316 e2e journal entry (head 92c3e38, CI green), #166/#178 on dropouts (the replacement-socket race), and the Oct 18 note that Wi-Fi wedges cause daily Pi dropouts.

## 1. Validator: no behaviour change
`parseCommandBody` (`checkout/hub/src/command.ts:410-439`) is the old route logic line for line: same `body ?? {}`, same check order, same four messages, same defaults (`null`, `"optimizer"`). The route still wraps the result as `400 {ok:false, detail}` (`index.ts:400-404`). Everything before the route is untouched: auth 401/403, the read-only 403, `express.json()` errors for bad JSON (400) and oversized bodies (413). Edge cases behave as on main: `pump_id: " "`, `lease_minutes: 0` and `source: ""` are still accepted, unknown fields dropped. The 503 / 200 / nack-502 / 504 paths are unchanged.

## 2. Findings, most severe first

**F1 (low-medium; confidence high): the dashboard now says "Rejected" for a command that may have been applied.**
- `control-client.tsx:121-122` turns any 502 into `Rejected: Pi disconnected before ack`. Before, the same event showed "Timed out waiting for the pump to acknowledge", which correctly left the outcome open.
- The bridge runs the setpoint write first and only then acks, on the same socket (`hub_client.py:188`). If the link drops between the two, the Pi has applied the setpoint but the person reads "Rejected" and may send it again. The harm is small: the resend is the same value, and the Pi's rate limit and guardrails still apply.
- Fix in the dashboard copy, in this PR or a follow-up. The PR's Safety section only covers the planner.

**F2 (low; confidence high): a half-open socket that gets replaced still produces a 504, not a 502.**
- After a Wi-Fi wedge the Pi redials while the hub still sees the old socket as OPEN. `index.ts:779` calls `markDisconnected(old)` only when the old socket is not OPEN; then `piSocket = ws` (`index.ts:786`), so the old socket's later `close` does nothing (`index.ts:311`). Commands pending on the old socket wait out their 10 s and get 504, exactly as today. Safe, but the description's table row "Pi drops while pending → 502 at once" is broader than the code, and no test covers this case.

**F3 (low; confidence medium): the missed-pong race.** `index.ts:818` marks the link down before the terminate, so an ack already in the buffer loses to the 502. Disclosed by the PR; acceptable.

**Planner effect (no finding):** `sendSetpoint` (`planner/src/hub.ts:123-125`) collapses every non-200 into `{ok:false, detail}`, so 502 and 504 look the same. Phase B adds at most one to `failStreak` per pump per 5-minute cycle (`phaseb.ts:452`); the engineer-only record fires at 3 (`phaseb.ts:456`); the owner alert needs `CONTROL_FAILING_STREAK = 7` (`owneralerts.ts:29`), roughly 35 minutes. `controlOutcome` treats a failure as "Pi unreachable" only if `/no Pi connected/` matches or `state.pi_connected === false` (`owneralerts.ts:91`); neither new nor old detail matches the regex, but `verifyLeases` now reads the hub state about 10 s sooner after the drop, so it is more likely to see `pi_connected:false`. Net: a burst of 502s during a reconnect cannot trip an owner alert sooner than before. Optional follow-up: add `Pi disconnected before ack` to that regex.

**Bookkeeping (verified):** every pending command is settled exactly once (deleted from the map before it is resolved, `command.ts:455-459`); the sweep walks a snapshot and only touches `failOnDisconnect` entries (`command.ts:469-472`), called only from `markDisconnected`, which runs at most once per socket; a late ack finds no entry and does nothing (`index.ts:867`).

## 3. Breaker, dead-man, dropout tracker, state frame
- `/api/breaker` and `/api/write-enable`: only doc comments change (`index.ts:601-602, 610-612`); they do not set `failOnDisconnect`, so they behave as before.
- Dropout tracker: `markDisconnected` moved below `pending` but keeps the same guard and still calls `piDropouts.disconnected()` first. The log line gains `— failed N pending command(s)`; `link.e2e.test.ts:76` matches by substring and still passes; no script greps the exact line.
- Dead-man and state frame: untouched. Shutdown still clears pending commands without answering them (`index.ts:898-901`).

## 4. Tests
`npm test` globs `src/*.test.ts`, so both new files run. Covered: disconnect mid-command (unit, plus e2e with a clean close and a terminate), ack-then-drop, drop-then-late-ack, breaker and write-enable entries left alone, timers cleared, the validator table including check order. Weak spot: e2e case 3 sends its late ack on the new socket and would pass on main; the dying-socket late ack is only covered by the unit test. Not covered: the F2 replacement path.

## 5. Out of scope
Nothing. Four files under `hub/src`; main's hub is unchanged since the merge base.

## Watch during the first Pi reconnect after the deploy
- Hub logs: `[hub] Pi disconnected` (with `— failed N pending command(s)` only if a command was in flight), then `Pi connected` and `Pi reconnected after X min`. Any `Cannot set headers after they are sent` means a command was answered twice: hold or revert. A `Pi missed pong — terminating` followed by an `ack timeout` 504 rather than a 502 is the F2 shape and expected.
- `/health`: `pi_connected` goes false and back to true; `pi_dropouts_24h` rises by exactly one for the deploy bounce (deploy-gate and drift-check [6] allow ≤ 1).
- Planner `/health`: `phase_b.fail_streak` at most 1 per pump after the bounce and back to 0 next cycle; `lastResults` may show `failed: Pi disconnected before ack` once.
