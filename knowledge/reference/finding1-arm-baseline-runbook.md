<!--
@purpose Owner runbook to arm the revert-to-baseline failsafe on the LIVE Pi (FINDING-1,
2026-09-16). The accompanying PR fixes the TEMPLATE, which only affects a future/fresh Pi —
the running bridge reads ~/bridge-data/config.yaml, which lives OUTSIDE the repo
(pi-bootstrap.sh:41 "so updates can never clobber them") and is created only if absent
(pi-bootstrap.sh:43). No merge, tag, or deploy can change it. This is a hands-on Pi edit.
-->

# Runbook — arm `baseline_setpoint_c` on the live Pi

**Status: NOT DONE until you run this.** The PR alone does not protect the house.

## Why

`poller.py:600` records a setpoint lease only `if lease_minutes and g.baseline_setpoint_c is
not None`. On the live Pi `baseline_setpoint_c` is unset, so:

- no lease is ever recorded (confirmed: `remote_lease_until: null` on both pumps while Phase B
  is actively writing)
- `check_lease()` (`poller.py:762`) returns early every tick
- the revert to baseline, the "⚠ optimizer stale — reverted to baseline" alert, and the 15-minute
  `lease_warn_minutes` warning **can never fire**

Every doc promises this failsafe (`railway-hub.md:28`, `api-integration.md:121`,
`planner/README.md:158`, `phaseb.ts:8`). It does not currently exist.

## Exposure if you don't

Not an imminent freeze hazard: if the planner dies now, both pumps hold 52 °C (warm) and the
house keeps heating. The real exposure is no automatic recovery from a stale value, silence on
that alert channel, and the bad case — Phase B's last write landing at its 45 °C floor before
the planner dies during a cold snap, with nothing to correct it. Severity rises sharply in winter.

## Before you touch anything — the known-good bracket

This is the 2026-09-16 lesson made procedural. That session merged nine PRs, four inside five
minutes, across a live deploy, and when the Pi dropped 10 minutes later the honest answer to
"did we cause it?" was *probably not* rather than *no*. The fix is not to move slower; it is to
leave a record that makes the question answerable. One change, bracketed, verified.

**1. Capture a known-good before-state** (from your laptop, before you SSH in):

```bash
bash scripts/drift-check.sh | tee /tmp/a2w-before.txt
```

Expect `[2]` to be **DRIFT** (that is today's truth) and `[1]`, `[3]`, `[4]` to be green. If
anything in `[1]` is red, **stop** — do not change a config on a system that is already unhealthy.
You would be layering a change onto an unknown failure, and that is how causation gets lost.

**2. Back up the live config** (on the Pi, before editing):

```bash
cp -a ~/bridge-data/config.yaml ~/bridge-data/config.yaml.bak-$(date +%Y%m%d-%H%M%S)
ls -la ~/bridge-data/config.yaml*
```

Rollback is then a `cp` back, not a reconstruction from memory. The bridge never reads `.bak-*`.

**3. Change nothing else in the same window.** No tag, no merge, no second edit. If the restart
misbehaves, the cause must be unambiguous.

## Change

SSH to the Pi (Tailscale), then edit `~/bridge-data/config.yaml`. Under `guardrails:` add:

```yaml
  baseline_setpoint_c: 48       # warm winter default reverted to when a lease lapses
  lease_max_minutes: 180
  lease_warn_minutes: 15
```

**Do NOT also add `unattended_min_setpoint_c` in this change.** That is the winter-safe FLOOR,
a separate decision: its own template comment records confidence LOW, and between roughly −15 °C
and −20 °C ambient a de-rated compressor may not physically REACH 45 °C. Arming the lease is
strictly safe (48 °C is warm; the only new behaviour is reverting TO it). Arming the floor is not.

### Why 48 validates (checked — a bad value raises at startup and the bridge won't start)

`config.py:86` → `floor = unattended_min_setpoint_c or setback_setpoint_c`. With
`unattended_min_setpoint_c` unset, floor = `setback_setpoint_c` = 40. The check is
`floor <= baseline <= setpoint_max_c` → `40 <= 48 <= 75`. Passes.

## Apply

```bash
sudo systemctl restart heatpump-bridge
sudo systemctl status heatpump-bridge --no-pager | head -20
```

If the service fails to start, the config is invalid — `journalctl -u heatpump-bridge -n 50`
will name the offending field. Revert the edit and restart to get back to the current state.

## Verify (do not skip — this is the whole point)

From your laptop, ~2 minutes after the restart so Phase B has written once and read the
result back. **No token needed** — since #97 the planner's public `/health` reports what the Pi
actually armed, and `drift-check.sh` now asserts on it directly:

```bash
bash scripts/drift-check.sh | tee /tmp/a2w-after.txt
diff /tmp/a2w-before.txt /tmp/a2w-after.txt
```

Section `[2]` must flip from
`DRIFT pumpN: wrote a setpoint but the Pi armed NO lease` to
`ok  pumpN: Pi confirmed a live lease — failsafe armed (... lease Nm armed)` on **both** pumps,
and the diff must show **nothing else changing**. A second difference means the restart moved
something you did not intend.

If `[2]` instead reports `lease unverified`, the planner could not read hub state — the arming
is unproven, not failed. Re-run in a few minutes before concluding anything.

Optional corroboration from the Pi's own reported value, via the hub:

```bash
cd planner && export HUB_CLIENT_TOKEN=$(railway variables --json | jq -r .HUB_CLIENT_TOKEN)
cd .. && bash scripts/drift-check.sh   # [2b] now also runs
```

Raw check if you prefer:

```bash
curl -s -H "Authorization: Bearer $HUB_CLIENT_TOKEN" \
  https://a2w-hub-production.up.railway.app/api/state | jq '.pumps[] | {id, remote_lease_until}'
```

`remote_lease_until` must be a timestamp, not `null`, on both pumps.

## Rollback

Restore the backup and restart:

```bash
cp -a ~/bridge-data/config.yaml.bak-<stamp> ~/bridge-data/config.yaml
sudo systemctl restart heatpump-bridge
```

The system returns to exactly today's behaviour (no lease, no revert) — nothing else depends on
those lines. Then re-run `drift-check.sh` and confirm `[2]` is back to DRIFT and the rest green,
so the rollback itself is bracketed too.

## Related

- `knowledge/reference/live-state-20260916.md` — FINDING-1 evidence chain
- FINDING-1b: **fixed** by #97 (`3e023a9`, 2026-09-16). `/health` used to render `lease 90m`
  from the planner's own `LEASE_MINUTES` constant regardless of what the Pi did. It now reports
  what the Pi actually armed (`phaseb.ts:192/198`), which is what makes the token-free assertion
  in `drift-check.sh [2a]` possible at all. The phase_b string is now trustworthy on this point.
- `phaseb.ts:23` claims `FLOOR_C = 45 // the Pi enforces this too` — it does not; the Pi's
  effective unattended floor is `setback_setpoint_c` (40). Phase B's own clamp still holds.
