<!--
@purpose Copy-paste command sheet for the FINDING-1 arming (#117). The RUNBOOK
(finding1-arm-baseline-runbook.md) is the source of truth and explains WHY; this is the same
procedure with the interpretation removed — owner decision 52 °C already substituted for the
runbook's 48, and the #117 pre-flight step folded in. If the two ever disagree, the runbook wins.
Written 2026-09-25. Do NOT run during the 2026-09-26/27 storm; deferred to a calm daylight slot.
-->

# FINDING-1 arming — command sheet

**Value: `baseline_setpoint_c: 52`** (owner decision 2026-09-24, reasoning in #117's comments — 52
sits *below* what Phase B commands so a lapse genuinely falls back, and *above* `dhwFloorF: 120` so
hot water keeps working while it is in force).

Two terminals: **[L]** laptop, **[P]** the Pi over Tailscale.

---

## 1 · [L] Bracket — before anything

```bash
cd ~/Documents/Claude/a2w-control
bash scripts/drift-check.sh | tee /tmp/a2w-before.txt
```

**Proceed only if:** `[2]` is **DRIFT** on both pumps, and `[1]`, `[3]`, `[4]` are all green.

**STOP if** anything in `[1]` is red — never layer a config change onto an unhealthy system; that is
how causation gets lost. A bracket captured hours earlier is not a bracket: this must be now.

## 2 · [P] Back up the live config

```bash
cp -a ~/bridge-data/config.yaml ~/bridge-data/config.yaml.bak-$(date +%Y%m%d-%H%M%S)
ls -la ~/bridge-data/config.yaml*
```

Rollback becomes a `cp`, not a reconstruction. The bridge never reads `.bak-*`.

## 3 · [P] Pre-flight the live bounds (#117's added step)

The runbook validated 48 against the *template* defaults, but the Pi reads `~/bridge-data/config.yaml`,
which bootstrap created and never updates. Check what is actually there:

```bash
grep -nE "setback_setpoint_c|unattended_min_setpoint_c|setpoint_max_c|baseline_setpoint_c" \
  ~/bridge-data/config.yaml
```

**Expect:** no `baseline_setpoint_c` line (that is the bug). Note the other three.

**52 validates if** `floor <= 52 <= setpoint_max_c`, where `floor = unattended_min_setpoint_c or
setback_setpoint_c` (`config.py:86`). Both plausible floors pass — 40 if unattended is unset, 45 if it
is set — and `setpoint_max_c` is 75. **STOP and re-check if** `setpoint_max_c < 52` or the floor is
above 52. A bad value raises at startup and the bridge will not start.

## 4 · [P] Edit

```bash
nano ~/bridge-data/config.yaml
```

Under the existing `guardrails:` key, add exactly these three lines (two-space indent, matching its
siblings):

```yaml
  baseline_setpoint_c: 52       # warm default reverted to when a lease lapses (owner decision 2026-09-24)
  lease_max_minutes: 180
  lease_warn_minutes: 15
```

**Do NOT also add `unattended_min_setpoint_c`.** That is the winter-safe FLOOR and a separate
decision — its template comment records confidence LOW, and between roughly −15 °C and −20 °C ambient
a de-rated compressor may not physically reach 45 °C. Arming the lease is strictly safe; arming the
floor is not.

**Change nothing else in this window.** No tag, no merge, no second edit.

## 5 · [P] Apply

```bash
sudo systemctl restart heatpump-bridge
sudo systemctl status heatpump-bridge --no-pager | head -20
```

**If it fails to start**, the YAML or the value is bad:

```bash
journalctl -u heatpump-bridge -n 50 --no-pager     # names the offending field
```

→ go to **Rollback**.

## 6 · [L] Verify — wait ~2 min first

Phase B needs one write-and-read-back cycle. No token needed: since #97 the planner's public
`/health` reports what the Pi *actually armed*.

```bash
sleep 120
bash scripts/drift-check.sh | tee /tmp/a2w-after.txt
diff /tmp/a2w-before.txt /tmp/a2w-after.txt
```

**Success is both of these:**

1. `[2]` flips on **both** pumps, from
   `DRIFT pumpN: wrote a setpoint but the Pi armed NO lease`
   to `ok pumpN: Pi confirmed a live lease — failsafe armed (... lease Nm armed)`
2. The diff shows **nothing else changing**. A second difference means the restart moved something
   you did not intend — investigate before walking away.

**If `[2]` says `lease unverified`:** the planner could not read hub state. The arming is *unproven,
not failed*. Re-run in a few minutes before concluding anything.

Optional corroboration from the Pi's own reported value:

```bash
cd planner && export HUB_CLIENT_TOKEN=$(railway variables --json | jq -r .HUB_CLIENT_TOKEN) && cd ..
curl -s -H "Authorization: Bearer $HUB_CLIENT_TOKEN" \
  https://a2w-hub-production.up.railway.app/api/state | jq '.pumps[] | {id, remote_lease_until}'
```

`remote_lease_until` must be a timestamp, not `null`, on both pumps.

## Rollback

```bash
cp -a ~/bridge-data/config.yaml.bak-<stamp> ~/bridge-data/config.yaml
sudo systemctl restart heatpump-bridge
```

Returns to exactly today's behaviour — no lease, no revert. Nothing else depends on those lines. Then
re-run `drift-check.sh` and confirm `[2]` is back to DRIFT with the rest green.

## After success

Close **#117** quoting the `[2]` before/after lines, and update
`knowledge/reference/live-state-*.md` so the next reader does not re-discover this. The whole point of
FINDING-1 was a doc promising behaviour the live config did not implement — leaving the doc stale
after fixing it would be the same mistake with the sign flipped.
