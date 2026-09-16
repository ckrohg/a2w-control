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

From your laptop, ~2 minutes after the restart so Phase B has written once:

```bash
cd planner && export HUB_CLIENT_TOKEN=$(railway variables --json | jq -r .HUB_CLIENT_TOKEN)
cd .. && bash scripts/drift-check.sh
```

Section `[2]` must flip from `DRIFT` to
`ok  all write-enabled pumps hold a live lease (failsafe armed)`.

Raw check if you prefer:

```bash
curl -s -H "Authorization: Bearer $HUB_CLIENT_TOKEN" \
  https://a2w-hub-production.up.railway.app/api/state | jq '.pumps[] | {id, remote_lease_until}'
```

`remote_lease_until` must be a timestamp, not `null`, on both pumps.

## Rollback

Delete the three lines and restart. The system returns to exactly today's behaviour (no lease,
no revert) — nothing else depends on them.

## Related

- `knowledge/reference/live-state-20260916.md` — FINDING-1 evidence chain
- FINDING-1b: planner `/health` reports `lease 90m` from its own constant
  (`phaseb.ts:123`) regardless of what the Pi did. Fixed separately; until then, trust
  `remote_lease_until`, never the planner's phase_b string.
- `phaseb.ts:23` claims `FLOOR_C = 45 // the Pi enforces this too` — it does not; the Pi's
  effective unattended floor is `setback_setpoint_c` (40). Phase B's own clamp still holds.
