# PR #313 — independent second review (tenet delegate, account A / Opus, read-only, 2026-11-23 10:20 ET)

Requested by the Pi/ops/reviews session ahead of the December release that will carry #313 (SPAN v2 as the code default;
v1 a deprecated fallback). The reviewer saw the PR description, the diff (base 77a94da), a checkout of the branch and main;
nothing was run.

**Verdict: MERGE WITH NOTES.** The code change is small and correct. The risks are in the operator guidance and test coverage, not in the transport logic.

## What I checked

- **Default resolution.** With `span.transport` absent the bridge runs v2 only, and `auto` and `v1` run the same code as before. The default is `"v2"` in `config.py:253`. `main.py:73` builds the poller, which passes `cfg.transport` at `span_local.py:603`. With v2, `span_local.py:102-106` builds the v2 session and no soak. Reads wait for the session and raise rather than fall back (`span_local.py:217-221`).
- **No v1 traffic under `v2`.** v1 registration, reads and writes are only reachable through `_v1_fetch_sync` and `_v1_set_relay_sync`, and both sit behind those two v2 guards. `_load_token` at `span_local.py:93` only reads a file.
- **Diff scope.** The diff only changes two defaults (`config.py:253`, `span_local.py:603`), adds the start-up warning (`span_local.py:85-87`) and adds the `deprecated` key (`span_local.py:315`).
- **Rollback claim.** Confirmed: an absent key now means v2, so restoring an old config.yaml without the key is not a rollback.
- **Relay writes.** Every write path ends in `SpanClient._set_relay_sync` (`span_local.py:361`): dashboard `api.py:431`; hub command `hub_client.py:244`; self-heal `self_heal.py:632`; Pi backup fallback `backup_fallback.py:281` (a close); element arm `span_local.py:747` (a close with no permit); the controller's own writes `span_control.py:469/548/673`. The OpenPermit check (`:371-376`) still runs before any transport. The rule against a second OPEN on v1 after one that may have reached the panel over v2 (`:386-396`) is untouched. Under `v2`, `:397-398` raises before any v1 code runs. In `auto`, an OPEN that never left over v2 may still go to v1; unchanged.
- **Deprecation notice.** One log warning per process plus a health field, reaching `/api/health` via `span_local.py:699` and the hub frame via `span_control.py:139`. Nothing outside the bridge, tests, drift-check and README reads `deprecated`, so it cannot page or email anyone.

## Findings, by severity

**1. Medium: "remove the key" only works on the new release, and nothing checks which release is running.** Confidence: high.
- `drift-check.sh:383` says "remove span.transport"; `drift-check.sh:371` says "drop span.transport: v1 (v2 is the default)". Both docs make removing the key the main post-Dec-31 step. Drift-check cannot tell which release the Pi runs.
- **Failure scenario:** the December tag slips, or auto-update re-pins an older tag. The owner follows the red [10] and removes the key. An older bridge reads an absent key as v1, so from Dec 31 the bridge cannot read or switch the panel: no self-heal, no element close.
- **Fix:** make an explicit `transport: v2` the main instruction everywhere (it has worked on every release since #239); mention removing the key only as optional cleanup.

**2. Medium-low: a pure-v2 boot with the broker down pages straight away and refuses safety closes.** Confidence: high.
- Applies only once the key is removed or set to v2. On Tuesday's explicit `auto`, the first start of this release behaves exactly as today: v1 answers reads and CLOSEs.
- With `_last_ok == 0`, `down_for` is infinite (`span_local.py:780-781`): the first failed poll (after the 15 s wait at `span_v2.py:551`) sends "SPAN local link down … since startup". `_down_alerted` resets per process, so every watchdog or auto-update restart during the outage pages again. Breaker actions return 503 (`span_control.py:370`), including the backup-element close; self-heal and the backup fallback lose panel evidence after 120 s (`self_heal.py:58`).
- Always true for an explicit `v2`; what is new is that it becomes the default about five weeks before v1 dies. Acceptable, but it belongs in the runbook.

**3. Low-medium: a v1 leak in the end-to-end suites would not fail them.** Confidence: high.
- The three runs do use three real configs (`v1` and `auto` forced at `conftest.py:40-46`; `v2` unforced, no suite passes `transport=`). But the v1-removed fake answers v1 calls with a 404 (`fake_span.py:135-137,167-169`) instead of failing the test; the v1 id lookup swallows that error (`span_local.py:400-404`); `conftest.py` has no teardown check that `v1_requests == []`. Only the new tests at `test_span_v2.py:298, 481-549` check for leaks, and none covers the backup fallback directly.
- **Fix:** record every FakeSpan the fixture creates and assert `v1_requests == []` at teardown when the param is `v2`.
- Runtime: those suites go from two runs to three, about +50 % on five files, not triple. The description's "704 passed in 8m37s" is unverified here.

**4. Low: drift-check dates are UTC.** `TODAY` comes from `date -u` (`drift-check.sh:27`): the v1 gate turns red at 19:00 ET on Dec 14, the `auto` gate at 19:00 ET on Dec 30, the same day the docs give as the deadline. Neither can go red earlier. Without `HUB_CLIENT_TOKEN`, [10] skips (`:360-361`), as before.

**5. Low: docs drift.** `span-v2-local-api.md:120` still says the suites run "twice". `span-v2-cutover.md:221` says the link-down alert comes "after 4 h": true for a running bridge, but a restart pages immediately (finding 2). §5 rollback (`span-v2-cutover.md:198-202`) and §3's post-Dec-31 step (`:143-148`) match the code apart from finding 1.

**6. Low: a leftover `v2_soak: true` is ignored silently.** With `v2_soak: true` and no transport key, this release quietly goes v2-only and drops the soak (`config.py:254`) with no log line. Suggest a one-line warning when `v2_soak` is set and transport is not `v1`.

**Outside scope.** `span-v2-cutover.md:166-171` still says the v2-write test is an open owner decision; the owner decided it on 2026-11-23 (Tuesday power-cycle from the dashboard). The PR does not touch this section, but it is now stale.

## First hour on the Pi after the December tag

- The tag should not change behaviour while `auto` is set: `/api/health.span.mode` `auto`, `deprecated` null, `read` `v2` with `read_ts` and `last_ok_ts` under a minute old; `v2.connected` and `synced` true, `v2_error` null, `register_strikes` 0; no new panel registration; no `DEPRECATED` line in the bridge log (one means the config is pinned to v1).
- Confirm drift-check [10] passes with `HUB_CLIENT_TOKEN` set.
- Only then set `transport: v2` explicitly, restart, and expect mode, read and write all `v2`; watch for a "SPAN local link down … since startup" alert within the first poll; `self_heal` and `backup_fallback` should report panel evidence under 120 s old.

Relied on: the 2026-11-23 10:00 owner decision (no new tag Tuesday, dashboard-triggered power-cycle), the Nov 21–23 plan (#313 for a December tag), the #199/#239 journal entries. The Tuesday cutover has not happened yet.
