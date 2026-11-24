# #315 vs #318 — the "timer added after its time fires at once" fix, compared (tenet delegate, account A / Opus, read-only, 2026-11-23 10:15 ET)

Requested by the Pi/ops/reviews session so the planner lane keeps one of the two. Nothing was run.

**Verdict: keep #315.** Its `store.py` change is byte-identical to #318's, and its tests are a strict superset that also clears the Codex P2. #318 has nothing to add.

## 1. Root cause (main)

- **Where "last fired" starts:** `Store.add_schedule` inserts only `(pump_id, time_hhmm, action)` (`heatpump-bridge/bridge/store.py:289-292`). So a new rule's `last_fired_date` starts out NULL (`store.py:50`).
- **How catch-up decides a rule is due:** `due_schedules` returns every enabled rule with `time_hhmm<=now` and `last_fired_date IS NULL OR <> today` (`store.py:298-306`). It uses `<=` on purpose, so that a restart or a stalled tick still fires a rule late.
- **Result:** the scheduler ticks every 20 s with `datetime.now()` (`scheduler.py:66, 91`). A NULL rule whose time has already passed matches on the very next tick, so adding "06:00 off" at 14:00 writes to the pump within about 20 s.

## 2. The two PRs

**Production code is the same in both.** Both diffs carry the same blob hashes (`6d819c4..f881b02`). Both add an optional `now` and store today's date when `time_hhmm <= now.HH:MM` (`pr-315/checkout/heatpump-bridge/bridge/store.py:290-300`, same lines in pr-318). The only production caller passes no `now`, so it uses wall time (`api.py:297`). Wall time comes from `datetime.now()`, the same local clock the scheduler uses, so the two can't disagree.

| Case | Result | Tested in |
|---|---|---|
| Added before its time | NULL, fires today | both (`pr-315/.../test_integration.py:965`) |
| Added after its time | stamped today, fires tomorrow | both (`:942`) |
| Added during its own minute (06:00:30) | `"06:00"<="06:00"`, waits until tomorrow (documented) | #315 only (`:983`) |
| Midnight: "00:00" added at 23:59 | stamped today, but at 00:00 the date has changed, so it fires | #315 only (`:1001`) |
| Bridge restart between add and trigger | the stamp is stored in SQLite, and the scheduler keeps no state per rule (`scheduler.py:91-100`) | indirectly: every test builds a fresh `Scheduler` on the existing store |
| Existing rule genuinely missed while the bridge was down | rules already stored are untouched, so the `<=` catch-up still works | #315 makes this deterministic (`:733-734`) |
| API path stamps a past rule | | #315 only (`:1023`) |

**Behaviour change beyond the bug (both):** a timer added after its time, including during its own minute, no longer acts "now". To switch a pump immediately, the owner uses manual control. There is no edit or re-enable endpoint (`api.py:287-312`), so no other path brings the bug back.

## 3. The Codex P2 on #318

**It is real, but latent.** #318 leaves three scheduler tests calling `add_schedule` without `now` (`pr-318/checkout/heatpump-bridge/tests/test_integration.py:732-733, 893, 910`). Those rules now take the real clock, while their ticks are hard-coded to 2026-07-04. On that real date (or under a clock set to it), a rule whose time had passed would be stamped "fired today", and the catch-up, setback and once-per-day tests would fail. Since that date is past, nothing breaks today. Still, those tests now quietly depend on the wall clock, and the catch-up test no longer reliably exercises a genuinely missed rule.

**#315 doesn't have this problem.** It pins all three calls (`pr-315/.../test_integration.py:733-734, 894, 911`), and every new scheduler test passes an explicit `now=`. Its one wall-clock test (`:1012-1028`) is built to be safe: "00:00" is always at or before now, and it accepts either the date before or after the call, so a run that straddles midnight still passes.

Two calls without `now` remain in both PRs (`:806` and `:1353` in #315). Neither test ticks the scheduler, so they are harmless.

## 4. Recommendation

- **Keep #315 as it is.** Nothing to take from #318: same code, fewer tests, and the P2 still open. Close #318 if it is still open.
- **Optional follow-up for #315:** a test that adds a rule, rebuilds the `Scheduler`, then ticks, to cover the restart case explicitly. Not required.
- **Merge order:** merging to main changes nothing on the Pi; bridge code arrives only with a release tag. Owner's decision 2026-11-23: no new tag Tuesday; #315 goes out with #308–#310, #317 and #313 in the December tag. Merge #315 any time before that tag is cut.

Relied on: the two PR descriptions and diffs, both checkouts' `store.py`, `scheduler.py`, `api.py`, `test_integration.py`, main's `store.py`, and the 2026-11-23 journal entries. The test suite was not run; pass counts come from the PR descriptions.
