# December bridge release plan: `release-20261201-1` (draft, 2026-11-24)

Drafted by a read-only tenet delegate (account B, Opus, 2026-11-24 11:50 ET) at the request of the Pi/ops/reviews session,
after the SPAN `auto` flip and the proven v2 write earlier the same day. Nothing was run. For the owner and for the agent
that runs the "December tag prep" task (Tue Dec 1, 08:37 ET). Sources: `heatpump-bridge/deploy/pi-update.sh`,
`heatpump-bridge/deploy/heatpump-bridge-update.{timer,service}`, `heatpump-bridge/bridge/api.py:437-475`,
`scripts/drift-check.sh`, `CLAUDE.md:98-117`, `knowledge/reference/span-v2-cutover.md`, the reviews of #313, #319 and
#322, the #315/#318 comparison, `knowledge/drafts/tuesday-20261124-pi-window.md` §1, and the TENET journal for Nov 21–24.

## 1. Summary

The Dec 1 tag ships six bridge PRs that are already on main: #308, #309, #310, #315, #317 and #322. #320 also rides along, but it is scripts and docs only. Most of the batch is telemetry. Two PRs change behaviour:
- **#315:** a timer added after its time of day now waits until the next day.
- **#322:** the bridge refuses to start if `baseline_setpoint_c` is not a whole number. The Pi's value is 52, so this does not bite today.

Only the owner cuts the tag, on Tue Dec 1 in the morning, after the 08:37 prep. The Pi's update timer picks it up within about 16 minutes. **The owner has one decision:** put #313 (SPAN v2 becomes the code default) in this tag, or ship it in a second tag a few days later. I recommend the second tag (§3).

## 2. Scope

| PR | What changes on the Pi | Kind | First-hour risk, and how you would notice | Config it depends on |
|---|---|---|---|---|
| #308 | System stats sample the Wi-Fi signal, BSSID and roams | Telemetry | The sampler fails, so the new fields are null or missing in system stats. Control is unaffected. | none |
| #309 | Every comm/offline event is tagged with hub, peer and gateway state | Telemetry | New event fields are missing or malformed in comm events | none |
| #310 | CommStats gains a per-poll Modbus round-trip time and splits out CRC errors | Telemetry | CommStats fields are null; a poll-time regression would show as `pumps_fresh` < 2 | none |
| #315 | **Behaviour:** a timer added after its time of day no longer fires at once. It is stamped "fired today" and runs tomorrow. Use manual control to switch a pump now. | Behaviour | None in the first hour: the schedules table had 0 rows on Nov 23. You would only notice when you next add a timer. | none |
| #317 | Unit tests for LAN discovery | Tests only | none | none |
| #322 | **Behaviour at boot:** logs a warning when a timer is below the unattended floor, and refuses to load a fractional `baseline_setpoint_c` (`config.py:104-108` in the PR) | Behaviour (start-up check) + log | A fractional baseline crashes the import and puts the service in a restart loop: `systemctl is-active` flaps and `/api/health` stops answering. With today's config (restriction on, setback 40, no floor) there should be no `WARNING bridge.main guardrails.` lines. | `guardrails.baseline_setpoint_c` must be whole (Pi: 52) |
| #320 | drift-check [4] and CLAUDE.md | Not bridge code | none | none |
| #313 | Only if the owner includes it (§3) | Behaviour of the default only | With an explicit `transport: auto` it should change nothing on the Pi | `span.transport` stays explicit |
| #319 | Not in the tag (§4) | n/a | n/a | n/a |

The tag carries everything on `origin/main` at the moment it is cut, including any planner or hub commits. `pi-update.sh` restarts only the bridge, so those commits change nothing on the Pi. The prep re-lists the bridge commits (§5).

## 3. Decision on #313

**Option A: include it in the Dec 1 tag.** Before the tag, someone rebases #313 onto main (it conflicts today). CI and a local `cd heatpump-bridge && uv run pytest -q` must pass the three-config suites (`v1`, `auto`, `v2`). It is merged through the normal route, then tagged.

**Option B (recommended): a second tag a few days later**, for example Thu Dec 3 or Fri Dec 4, never Thu night.

Reasons for B:
- The week of clean `auto` began at 11:28 ET on Nov 24, so it ends at **11:28 ET on Dec 1**, three hours after the prep runs.
- #313 conflicts with main today. Two of its review findings are unfixed: finding 1, the docs and drift-check tell you to remove the key; finding 6, a leftover `v2_soak` is ignored silently.
- With an explicit `auto`, #313 is inert on the Pi anyway. The step that actually changes behaviour is the later config edit to `transport: v2`, so nothing is lost by waiting.
- Separate brackets mean any SPAN anomaly can't be confused with the telemetry batch.
- The cost is one more restart: one lease transient and one 0-min dropout. December 31 still leaves four weeks of margin.

**"A week of clean auto" means all of these hold** from 2026-11-24 11:28 to 2026-12-01 11:28 ET:
- In `/api/health.span`:
  - `mode` is `auto` and `read` is `v2`;
  - `read_ts` and `last_ok_ts` are under 60 s old;
  - `v2.connected` and `v2.synced` are true;
  - `v2_error`, `v1_error` and `v2.error` are null;
  - `v2.register_strikes` is 0 and `v2.auth_alarm` is false.
- `scripts/drift-check.sh` [10], run with `HUB_CLIENT_TOKEN` set, says "SPAN local reads come over v2 (MQTT eBus), mode auto" on every run in the week.
- None of these lines in the bridge log since the flip: `journalctl -u heatpump-bridge --since "2026-11-24 11:28" | grep -E "over v2 failed|waiting for v2|v2_ca_changed|v2_register_backoff"`.
- Every `span.write` since the flip is `v2`. The real v2 write was already proven on Nov 24 at 11:30: an Air-Water 2 power cycle, OPEN and CLOSE verified, `close_attempts` 1.
- Caveat: `span.read` names only the last transport that answered (`span-v2-cutover.md` §6). I did not find a log line for a read that fell back to v1, so a short fallback in the middle of the week shows only in [10] snapshots taken at that moment.

**What the Pi config says over time** (`/home/admin/bridge-data/config.yaml`):
- **Through the Dec 1 tag, and through the #313 tag:** keep the explicit `transport: auto`. Do not edit the config in the same bracket as either tag.
- **After the #313 tag has had one clean hour** (§7 #313 items): back up the config and set the explicit `transport: v2` in its own bracket with a restart. In that same edit, delete the commented `# v2_soak: true` line. It does nothing outside `v1`, and after Dec 31 a rollback to v1 is impossible anyway.
- **Never rely on the absent-key default** (review finding 1). On any release older than #313, an absent key means `v1`. A slipped or re-pinned tag would leave the Pi blind to the panel from Dec 31.

## 4. #319: not in the tag

#319 stays out unless it is fixed as its review asks. "Fixed" means:
- The copy is written to `bridge-YYYYMMDD.db.part`, checked (`quick_check`, page count), fsynced, then `os.replace`d onto the final name.
- "Done today" means today's file exists with a valid SQLite header, not "the newest file is over 0 bytes".
- The review's tests 1–7 pass.

Until then the 03:30 backup works as it does today, and the 04:07 pull avoids the half-written window.

## 5. Pre-tag checklist (Dec 1, 08:37 prep; the agent reports, the owner decides)

1. **What ships.** `git fetch origin --tags && git log --oneline release-20261122-1..origin/main -- heatpump-bridge/`. The list should match §2 plus anything merged since Nov 24. Anything new gets a line in the report.
2. **Main CI is green.** `gh run list --branch main -L 5`: the head commit's bridge-tests job has passed.
3. **The bridge suite passes on main.** `git worktree add /tmp/a2w-dec1 origin/main && cd /tmp/a2w-dec1/heatpump-bridge && uv run pytest -q`. The last result was 641 passed on Nov 23.
4. **No deploying merge in the last 2 h.** `git log --since="2 hours ago" --oneline origin/main -- planner/ hub/` is empty, and `scripts/deploy-gate.sh status` says ok. The last scheduled gate merge is Mon Nov 30 13:03 (#328).
5. **drift-check is green apart from the known [6].** `HUB_CLIENT_TOKEN=… scripts/drift-check.sh`. [10] passes. [11] is dated Dec 1 (railway.toml); if it is red, report it as a planner-lane item, not a bridge blocker.
6. **The Pi is healthy.** Run the §6 commands. `healthy` true, 2/2 pumps online and fresh; the span fields as in §3.
7. **The baseline is whole.** `grep -n baseline_setpoint_c /home/admin/bridge-data/config.yaml` shows 52, a whole number. #322 refuses anything else.
8. **No pump is about to be needed.**
   - Planner: `curl -s https://a2w-planner-production.up.railway.app/health | jq '.phase_b.mode, .phase_b.lastResults, .unserved.all_idle, .unserved.stages, .writer_lease'`. Want no stage with `called_not_heating_min` > 0 and no open `unserved`/`fault` episode.
   - Pi: `/api/pumps/pump1/status` and `/api/pumps/pump2/status` show both pumps idle, or at least not starting a call (these need a UI session; the bridge's `samples` table read-only works too). `self_heal.pumps.*.phase` is idle.
   - Whether the HBX is about to call is not determined from the repo. The best proxy is the current stage-call state above.
9. **Not in a freeze.** The only freeze is Thu Nov 26 22:00 → Fri Nov 27 03:30 ET. Also keep clear of 03:30 (the Pi's backup) and 04:07 (the pull).
10. **The owner is present in chat** and says go.

## 6. The tag (owner only) and the Pi afterwards

Only the owner cuts it (`CLAUDE.md:105`). No agent runs this command:

```bash
git fetch origin --tags && git tag -a release-20261201-1 -m "release-20261201-1: #308 #309 #310 #315 #317 #322 (+#320 scripts); owner-authorized in chat 2026-12-01" origin/main && git push origin release-20261201-1
```

**What happens on the Pi:**
- **When.** The timer fires every 15 min with up to 60 s of random delay (`heatpump-bridge-update.timer:7-9`), so the tag lands within about 16 min. Last time: tag at 18:56Z, Pi running it at about 19:12Z.
- **What `pi-update.sh` does, in order:**
  1. Fetches tags and picks the newest `release-*` by creation date.
  2. Refuses anything that is not ahead of HEAD (`:59-62`).
  3. Writes the target to `.update-state`.
  4. Runs `git reset --hard`, `uv sync --no-dev` and `systemctl restart` (`:72-76`).
  5. Polls `/api/health` for up to 60 s (30 × 2 s, `:86-94`). Success writes `.deployed`.
- **How long.** Measured on Nov 24: SPAN reads over v2 10 s after a restart. The exact restart duration is not determined from the repo; the updater allows 60 s.
- **What the planner and hub show:**
  - The restart clears the in-memory lease. Expect one planner cycle with "NO LEASE ARMED" (drift-check [2] red), then "lease …m armed" on the next 5-min cycle.
  - The hub records one 0-min Pi dropout, so [6] goes up by one.
  - Both are expected.

**Verify on the Pi** (adapted from the Tuesday sheet §1):

```bash
cd /home/admin/a2w-control && git describe --tags && cut -c1-8 heatpump-bridge/.deployed && git rev-list -n1 release-20261201-1 | cut -c1-8 && systemctl is-active heatpump-bridge
journalctl -u heatpump-bridge-update --since "-30 min" | grep -E "release|update:|healthy on|FAILED"
curl -s http://127.0.0.1:8000/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["span"]; print(d["healthy"], d["pumps_online"], d["pumps_fresh"], "self_heal live", d["self_heal"]["live"], "blind", d["self_heal"].get("blind"), "| span", s["mode"], s["read"], s.get("v2_error"), s.get("deprecated"))'
journalctl -u heatpump-bridge --since "-15 min" | grep -E "guardrails|DEPRECATED|Traceback"
```

The release is in when all of these hold:
- `git describe` says `release-20261201-1`, and `.deployed` matches the tag's commit.
- The service is `active`.
- `healthy` is true and 2/2 pumps are fresh.
- `self_heal.live` is true and `backup_fallback` is still shadow.
- span is `auto` / `v2` / `v2_error` null.
- The log has no guardrails warnings and no tracebacks.

## 7. First-hour watch

**Expected:**
- One cycle of planner `phase_b` "NO LEASE ARMED", re-armed by the next cycle; [2] red for that one cycle.
- Hub `pi_dropouts_24h` +1, `longest_dropout_min` 0.
- `span.write` and `write_ts` null; the self-heal and CommStats counters start from zero.
- New fields: Wi-Fi signal/BSSID/roams in system stats (#308), RTT and CRC split in CommStats (#310), hub/peer/gateway tags on comm events (#309).

**Investigate (no rollback):**
- `span.read` reads `v1`, or `v2_error` is set. `auto` falls back on its own; note the time and the error.
- A `WARNING bridge.main guardrails.` line at boot (#322).
- The #308–#310 fields are null or missing (telemetry only).
- `pumps_fresh` is 1/2 for more than a few polls with no pump fault.
- `phase_b` shows no lease for a second consecutive cycle.

**Roll back now:**
- `systemctl is-active heatpump-bridge` is not `active`, or it flaps (restart loop; check `journalctl -u heatpump-bridge` for a traceback at import).
- `/api/health` returns 503 or `healthy: false` for more than 2 min.
- `pumps_online` < 2 with no pump fault to explain it.
- `phase_b` shows "NO LEASE ARMED" for 3 cycles (15 min) or more.
- Any `setpoint_write` event with `rejected` from `source: baseline-revert`.
- Note: `close_failed` is an urgent page and a job for the panel. It is not a release rollback.

**Only if #313 is in the tag:**
- Expected: `span.mode` `auto`, `deprecated` null, no `DEPRECATED` line in the log, no new panel registration, [10] passes.
- Investigate: a `DEPRECATED` line, which means the config is pinned to v1.
- Then, in a separate bracket: switch to `transport: v2` and restart. Expect mode, read and write all `v2`. Watch for a "SPAN local link down … since startup" alert on the first poll (review finding 2), and for `self_heal` / `backup_fallback` panel evidence under 120 s old.

## 8. Rollback

**Automatic** (`pi-update.sh:78-98`): if the apply fails, or `/api/health` gives no 2xx within 60 s, the script re-applies the previous commit, restarts, and leaves the bad target in `.update-state`, so it never retries it.

What the automatic check catches: `/api/health` returns 503 only when the bridge is blind, meaning no pump has polled fresh in 90 s (`api.py:449-451`). So it catches a crash or restart loop and total loss of the pumps. It does **not** catch a SPAN, lease or telemetry problem. Those need the manual path.

**Manual**, back to the previous tag:

```bash
cd /home/admin/a2w-control && export PATH="$HOME/.local/bin:$PATH"
git rev-list -n1 release-20261201-1 > heatpump-bridge/.update-state       # the timer then skips this tag
git reset --hard -q release-20261122-1 && (cd heatpump-bridge && uv sync --no-dev) && sudo systemctl restart heatpump-bridge
git rev-parse HEAD > heatpump-bridge/.deployed
```

Writing `.update-state` matters. Without it, the timer re-applies the Dec 1 tag within 15 min, because the tag is ahead of HEAD. After a rollback, the fix ships as a newer tag. Check the result with the §6 commands; expect `release-20261122-1`.

A rollback is a second restart: one more lease transient and one more 0-min dropout. Whether the agent may roll back on its own authority (as on Nov 24) is open question 4.

## 9. What not to do

- No agent cuts, moves or deletes a `release-*` tag.
- No tag during Thu Nov 26 22:00 → Fri Nov 27 03:30 ET, and none within 2 h of a planner gate merge.
- Never edit the Pi config and push a tag in the same bracket. The baseline, the transport and the Wi-Fi pin each get their own bracket.
- No relay action on Buffer Tank, and no breaker action as a test.
- Do not remove `span.transport` from the Pi config, now or after Dec 31. Use the explicit `v2`.
- Do not merge #319 as it stands. Do not merge #313 without a rebase and a green three-config run.

## 10. Open questions for the owner

1. #313: Dec 1 tag or a second tag (recommended: Thu Dec 3 or Fri Dec 4)?
2. Who rebases #313 and makes the finding 1 fix (explicit `transport: v2` as the main instruction in the docs and in drift-check [10]'s wording) and the finding 6 fix (warn on a leftover `v2_soak`)?
3. What time is the tag on Dec 1? After the prep report, owner present.
4. On a "roll back now" trigger, may the agent run §8 by itself and then tell you, as on Nov 24?
5. #319: fixed for a later tag, or parked while the 04:07 pull covers the gap?
6. If the Ethernet cable goes in this week: its own bracket, not on Dec 1.
