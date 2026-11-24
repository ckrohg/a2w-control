# PR #322 — independent second review (tenet delegate, account B / Opus, read-only, 2026-11-23 22:20 ET)

Requested by the Pi/ops/reviews session (owner popup 2026-11-23 20:40 ET) for the hydronic lane, which owns the PR.
The reviewer saw the PR description, the diff (base a973a3c), a checkout of head 083a80a6 and main; nothing was run.
**Pi/ops note on finding 1:** the live Pi config read on 2026-11-23 15:36 ET has `baseline_setpoint_c: 52` (whole), so
the new load-time check does not block the bridge on today's config. Still: add it to the PR description, and keep the
baseline whole in every future edit of `~/bridge-data/config.yaml`.

**MERGE WITH NOTES.** The code is correct and changes nothing on the Pi as it is configured today. The PR description is wrong in three places, though: the Codex P2 is already fixed, there's a new check that can stop the bridge starting which the description never mentions, and its account of the tests contradicts itself. Fix the description and check one value on the Pi before the December tag.

All line numbers are in the checkout (`.claude/reviews/pr-322/checkout/heatpump-bridge/`) unless marked main. I read the code only and ran nothing.

## Findings (most severe first)

### 1. MEDIUM: a new check can stop the bridge starting, and the description doesn't mention it
- **What changed:** `bridge/config.py:104-108` adds a check that raises if `baseline_setpoint_c` isn't a whole degree. It runs inside the config validator, so it fires at `load_config()`. `create_app()` calls that when the module is imported (`main.py:187`, `app = create_app()`).
- **Not in the description:** the PR's file list mentions only `unattended_floor_c` and `guardrail_warnings()` for `config.py`. Yet the description promises the Pi "never refuses to start on a config it already runs". That promise holds for `guardrail_warnings()`, but not for this new check.
- **Failure scenario:** the Pi's `config.yaml` has `baseline_setpoint_c: 52.5`. Main boots fine; on this PR, uvicorn crashes on import and systemd keeps restarting it. I didn't check whether `pi-update.sh` rolls back after a failed start.
- **Why the check itself is right:** on main, a fractional baseline is refused at `poller.py:802` on every lease revert, so the house never reverts.
- **Likely safe on the Pi:** the baseline value isn't among the facts you gave me. The repo points to 52 (`tests/test_scheduler_floor.py:217` comment "the live Pi's 52"; `knowledge/reference/finding1-command-sheet.md:59`), and 52 passes.
- **Action:** confirm the Pi's `baseline_setpoint_c` is whole before tagging, and add this check to the description.

### 2. MEDIUM (description only): the Codex P2 is already fixed in this commit
- **Codex's premise is correct.** `scheduler.py:188-190` returns right after `write_power(...)` when `restrict_unattended_writes` is false. It never writes the setback or comfort setpoint. The diff doesn't touch this code, so main behaves the same.
- **But the head commit already has the fix.** `config.py:149-150` (`if not g.restrict_unattended_writes: return out`) stops before the timer warnings. Only the fractional-floor warning (`config.py:146-148`) comes before it, and that one is correct: machine tokens (`api.py:251`) and the hub (`hub_client.py:180`) still write with `unattended=True` whatever the flag says.
- **And a test covers it:** `tests/test_scheduler_floor.py:199-207`.
- **No code change is needed.** The "Codex review: one P2, not fixed here" section is out of date and should be rewritten.

### 3. LOW (description only): the test-run claims contradict each other
The "Tests" section reports "594 passed, 4 skipped". The "Review" section says "Nothing has been executed by any attempt or any review (this sandbox has no Python runner)". Treat the suite as not run until someone runs it. (Pi/ops note: CI `bridge-tests` is green on the head, so the suite has run there.)

### 4. LOW: no warning when a fractional setback becomes the floor
- **Where:** `config.py:146` warns about a fractional floor only when `unattended_min_setpoint_c` is set explicitly.
- **Scenario:** `unattended_min_setpoint_c` is unset and `setback_setpoint_c` is 40.5. The floor falls back to 40.5, and machine-token writes are held to 41.
  - With restriction on, the only warning is that the setback isn't whole (`config.py:161-163`). It says nothing about the floor.
  - With restriction off, nothing is logged at all.
- **Impact:** none on safety. Writes are still never below the configured floor. It's only a gap in the diagnostics.

### 5. NIT: the wording of refusal messages changes slightly
- `max(30.0, 40)` at `poller.py:837` now returns an `int`. So `guardrails.py:43` prints `"40–75.0°C"` where main printed `"40.0–75.0°C"`.
- Nothing parses these strings. I grepped the bridge and the planner, and the only matches are the bridge's own message strings and the new tests.
- The description's sample message says "46–90°C", but the real upper bound is 75: `_setpoint_bounds` (`poller.py:354-356`) takes min(75, 90). The tests only check for "unattended floor 46", so they still pass.

## Check-by-check

**1. Codex P2:** covered under findings 2 and 4.

**2. Rounding the floor up (ceil):** no write below the configured floor is accepted, and no write accepted on main is refused here.
- **Where the floor is read:**
  - `poller.py:837` is the only place it's enforced while running, and only for heating.
  - `config.py:100` (baseline check) uses the unrounded floor.
  - `guardrail_warnings` (`config.py:143-144`) uses both.
  - `main.py:41-42` only logs.
  - `api.py`, `hub_client.py` and `scheduler.py` don't compute a floor; they pass `unattended=True` to the write path.
- **Accepts the same writes as main:** `poller.py:802` rejects any non-whole value before the floor check. For a whole value v, v ≥ f is the same test as v ≥ ceil(f).
- **No below-floor write:** ceil(f) ≥ f.
- **Lease revert is never refused by the floor:** the baseline must be whole and ≥ f (raw), so it is also ≥ ceil(f).
- **Pi's current config:** the floor falls back to the setback. ceil(40.0) is 40, exactly as on main.

**3. `is None` vs `or`:** these differ only when the floor is 0.
- A floor of 0 is already rejected at `config.py:95-97`, because `setpoint_min_c` is at least `HARD_MIN_SETPOINT_C`. So `config.py:100` (main had `or`) never changed behaviour.
- The only `or` left is `tests/test_lease_armed.py:38`, which is test-only.
- The planner hard-codes `FLOOR_C = 45` (`planner/src/phaseb.ts:57`), which is separate from this logic.
- As the description admits, `test_unattended_floor_is_set_by_is_none_not_truthiness` documents the rule but doesn't prove it.

**4. Boot safety:** `guardrail_warnings()` can't raise on any config that loads.
- It only ever receives a validated `AppConfig`: strings are converted or rejected by pydantic at load; NaN, infinite or negative values, and a floor below `setpoint_min_c`, all fail `_sane_bounds` (`config.py:84-97`, `109-111`); so `math.ceil` and `int()` always get finite floats, and `comfort=None` is skipped (`config.py:159`).
- Logging is set up at import (`main.py:36`), so the warnings reach journald.
- The only way this PR can block startup is finding 1.

**5. Tests:** every assertion I traced matches the code.
- **Messages:** built at `poller.py:839-841` and `guardrails.py:43`.
- **Events:** `get_events` returns `message` and parses `detail` as JSON (`store.py:299-308`).
- **Fake pump:** heating, 45 °C, register 2027 = 90 (`sim/fake_pump.py:73-83`).
- **Second fire:** the 22:00 rule doesn't fire again at 23:00, because `due_schedules` skips rules that already fired today (`store.py:338`).
- **Clock step:** needed. The pre-check at `poller.py:806` applies the rate limit before the floor check, so without the step the 45 write would be rate-limited instead of refused for the floor.
- **Not covered:** machine-token and hub writes against a fractional floor (only the scheduler path is tested); a fractional setback used as the floor (finding 4); a YAML config with a fractional baseline failing at `load_config`; cooling mode skipping the floor.

**6. Out of scope:**
- The baseline check (finding 1).
- `scheduler.py`: two calls joined onto one line each, which changes nothing.
- `deploy/config.production.yaml:57-60`: the comment fix is correct, since a below-floor write is refused, not clamped. But it now says "raise to >= 45", while `knowledge/reference/winter-safe-floor-analysis.md:14` still recommends 46 and still says "silently clamped to 45". That doc is now stale and contradicts the code.

## What to watch on the Pi after the December tag
- **Before tagging:** read `baseline_setpoint_c` from the Pi's `config.yaml` and confirm it's a whole number (52 on 2026-11-23).
- **After it starts:** check that the service is `active` and stays that way (no restart loop). Look in the journal for `WARNING bridge.main guardrails.` lines. With today's config (restriction on, setback 40, no floor, whole numbers) there should be none.
- **When `unattended_min_setpoint_c: 45` is set:** raise the setback to at least 45 in the same edit, or every "off" timer is refused. The startup warning only shows that in the journal, and only once timers exist (the table has zero rows today).
- **Once the floor is live:** keep an eye on `setpoint_write`/`rejected` events from `source: schedule` and `source: baseline-revert`.

## Relied on
- TENET memory: "Pi read-only facts … unattended_min_setpoint_c unset, setback 40, restrict true; schedules empty" (2026-11-23), and the owner's plan to land bridge PRs ahead of a December tag.
- Checkout code: `config.py`, `poller.py` (765-884, 936-962, 349-360), `scheduler.py`, `guardrails.py`, `store.py`, `main.py`, `sim/fake_pump.py`, plus greps of `api.py`, `hub_client.py`, the planner and the tests.
- Main: compared through `diff.patch`, whose context lines show `scheduler._fire` unchanged and the `or` / `is None` code that was removed.
