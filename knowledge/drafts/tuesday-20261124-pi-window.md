# Tuesday 2026-11-24 09:00 ET — Pi window command sheet

Owner decisions (2026-11-21): one window, owner present, in this order. Each step has its own bracket
(verify before the next). Nothing here touches the planner or hub; the other a2w session owns those.
Procedure detail for step 3 is `knowledge/reference/span-v2-cutover.md`; this sheet only sequences it.

**Prerequisites (08:45 ET, this session's reminder):** Tailscale SSH check approved (link printed by
`ssh -F ~/.ssh/a2w-pi.conf a2w-pi` if needed); no deploy in progress (planner `/health.writer_lease.held`
true, `instance.peers` empty); both pumps idle or close to it (mild morning after the DHW boost). The element
night did not run on Sun Nov 22 (rescheduled past Thanksgiving), so it is no longer a prerequisite. The
"a2w project structure" session has disabled its own Tuesday task and stays off the Pi (confirmed Mon 2026-11-23);
both other lanes were asked Mon 20:45 ET to keep the planner/hub quiet 08:30-11:00 ET (no gate merges, no Railway
changes, no tag).

**Owner decisions Mon 2026-11-23 ~20:40 ET (popup, this session):**
- Window confirmed: 09:00 ET, owner watching; sequence as below. The owner says go in chat before step 3.
- Step 4 waits for pump 2 to be idle. If pump 2 is heating or defrosting, the flip stands and the relay test waits
  for the next idle moment the owner can watch; it is never run on a running pump.
- Rollback authority: on the runbook's triggers (`read` stays v1 after a few polls, `cycle_open_unconfirmed`,
  `verify_mismatch`) this session restores the backup config and restarts ON ITS OWN, then tells the owner.
  `close_failed` still pages the owner urgently and means the panel.
- Ethernet: "hoping to do this tomorrow, remind me". Default order: flip first; after about an hour of verified
  `auto`, the cable goes in, eth0 gets a lease, then the Wi-Fi pin comes off (§5). A 10:20 ET reminder is set.
- After the window: commission the December tag plan draft (tenet delegate, account B) as
  `knowledge/drafts/december-tag-plan.md`. (#308–#310 were merged Mon 21:19–21:31 ET by another session on the
  owner's ~21:00 decision, with #315 and #322; nothing for this lane to merge Tuesday. Owner: the December tag is
  **Tue Dec 1 AM**; main's bridge is six PRs ahead of release-20261122-1.)
- After the window, second bracket (owner 2026-11-23 22:35 ET, ~10:30–11:00 ET): the off-Pi backup path. On the Pi, an
  sshd drop-in `/etc/ssh/sshd_config.d/90-a2w-backup-pull.conf` adds `ListenAddress 100.70.39.44:2222` (the Pi's
  Tailscale address only; port 22 and Tailscale SSH untouched) with key-only auth for `admin`; `sshd -t`, then
  `systemctl reload ssh`. From the Mac: `ssh -F ~/.ssh/a2w-pi-backup.conf a2w-pi-backup true` (port 2222 through
  `tailscale nc`, BatchMode), then `scripts/pi-backup-pull.sh` by hand (expect "OK pulled: bridge-20261124.db"), then
  `launchctl bootstrap` of `scripts/launchd/com.a2w.pi-backup-pull.plist` (04:07 daily, KEEP=14 → ~3 GB in
  `~/a2w-pi-backups`). Rollback: delete the drop-in, reload ssh, `launchctl bootout`.
- Thu Nov 26 22:30 → Fri Nov 27 03:00 ET: element-calibration night (hydronic lane). Deploy and Pi-change freeze
  22:00 Thu – 03:30 Fri: no Pi edits, no pin removal, no tag in that window.

## 1. Release tag — ALREADY DONE on Sun 2026-11-22

The owner had `release-20261122-1` cut on 77a94da (#311 power_w = SPAN circuit, plus #292 self-heal
blind-Pi rule, #297, #287, #271, #265) at 18:56Z Sunday from a 6bb-rooted session; the Pi has run it since
about 19:12Z (journal 2026-11-22T19:26). **Owner decision 2026-11-23: no new tag on Tuesday.** The flip runs on release-20261122-1; #308–#310,
#315/#318 and #317 ride the December tag together with #313 after a week of clean `auto`. (If that ever changes,
the tag command is:)

```bash
git fetch origin --tags && git tag -a release-20261124-1 -m "release-20261124-1: <PR list>; owner-authorized in chat 2026-11-24" origin/main && git push origin release-20261124-1
```

`heatpump-bridge-update.timer` (every 15 min; `deploy/pi-update.sh`: newest `release-*`, forward-only,
update + restart + health check, rollback on failure) lands it. Verify on the Pi, at 09:00 regardless:

```bash
cd /home/admin/a2w-control && git describe --tags && cut -c1-8 heatpump-bridge/.deployed && systemctl is-active heatpump-bridge
curl -s http://127.0.0.1:8000/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["healthy"], d["pumps_online"], d["pumps_fresh"], "self_heal live", d["self_heal"]["live"], "blind", d["self_heal"].get("blind"))'
```

Done when `git describe` says `release-20261122-1` (or the newer tag), `.deployed` matches the tag's commit,
`healthy` is true, 2/2 pumps fresh, and `self_heal.blind` is present (the #292 field; `null` when the Pi can see).

**Prerequisite that lapses:** the Tailscale SSH check must be approved on the morning (the link printed by the
first `ssh` attempt; it was `l11edf6ef314865` on Mon 2026-11-23 09:29 ET and changes when re-issued).

## 2. Pre-flip snapshot — DONE 11:27:50 ET (6420 / 6420 / 0 / 2 unavailable)

```bash
curl -s http://127.0.0.1:8000/api/health | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["span"], indent=1))' | tee /home/admin/span-soak-final-20261124.json
```

Want: `mode v1`, `read v1`, `soak.disagree` 0 (the Sunday 14:12 ET deploy restart cleared the counters; the
2026-11-13 blind spell is gone from them; Mon 20:30 ET read 4295 compared / 4295 agree / 2 unavailable), `soak.v2.connected` and
`.synced` true, `last_message_age_s` small, `register_strikes 0`, `auth_alarm false`. No breaker action running:
`self_heal.pumps.*.phase` idle.

## 3. SPAN flip to `auto` — DONE 11:28:19 ET (owner go 11:27; read v2 at t+10 s)

```bash
cp -p /home/admin/bridge-data/config.yaml /home/admin/bridge-data/config.yaml.bak-20261124-v2auto
python3 - <<'EOF'
import re
p="/home/admin/bridge-data/config.yaml"; t=open(p).read()
t2=re.sub(r"^(span:\n)", r"\1  transport: auto\n", t, count=1, flags=re.M)   # config has no transport line today (v1 default)
t2=t2.replace("  v2_soak: true\n", "  # v2_soak: true   # ignored in auto; left for a rollback to v1\n")
open(p,"w").write(t2)
EOF
diff /home/admin/bridge-data/config.yaml.bak-20261124-v2auto /home/admin/bridge-data/config.yaml
sudo systemctl restart heatpump-bridge
```

Within 2 min, `/api/health.span`: `mode auto`, `read v2` with fresh `read_ts`, `write null`, `v2.started/connected/synced`
true, `v2.broker span-nj-2312-003t6.local:8883`, `v2_error null`, `soak null`. If `read` stays `v1`: read `v2_error`,
wait a few polls, else roll back (restore the backup, restart) and journal.

## 4. Deliberate v2 write test — DONE 11:30:19–11:31:21 ET (OPEN and CLOSE verified over v2, close_attempts 1)

The only proof that v2 writes work is a real relay action; the owner chose one power-cycle of Air-Water 2.
Preconditions: pump 2 idle (`/api/pumps/pump2/status`: not heating, no fault), tank comfortable, outdoor mild,
self-heal shows no fault. **Auth (corrected 2026-11-24 11:20 ET):** `/api/span/breaker` is `require("human")` (`bridge/auth.py`): API bearer
tokens are refused unconditionally; only a signed `a2w_ui` session cookie from `POST /api/session` (the config's
`auth.ui_password`) is accepted. The Pi's `auth.tokens` list is empty and the systemd unit's environment holds only
`BRIDGE_CONFIG`, so the earlier "control token from the unit environment" fallback never existed. Pi-side fallback that
works (used 2026-11-24 11:30 ET on the owner's instruction): read `ui_password` with the venv's yaml into a JSON body,
`curl -c jar -d "$PWJSON" /api/session`, then `curl -b jar -d '{"circuit":"Air-Water 2","action":"power_cycle","off_s":60}' /api/span/breaker`;
the password never leaves the Pi.

**Owner decision 2026-11-23: the owner triggers the power-cycle from the dashboard's breaker control** (dashboard →
hub `/api/breaker` → Pi over the hub link; no token on the Pi). The dashboard's hold is fixed at 60 s
(`analytics-mirror/lib/breaker-state.ts` `DASHBOARD_OFF_S`; the hub accepts 60–600 s). This session watches from the Pi: `span.write`
turning `"v2"` with a fresh `write_ts`, the `cycle_opened` / `cycle_done` events "(verified)", Air-Water 2 OPEN
for ~60 s then CLOSED, pump 2 back online within a few polls. The curl above is the fallback only. Expected: `span.write` becomes `"v2"` with a fresh `write_ts`; events `cycle_opened` then `cycle_done`, each
"(verified)" from the relay read-back; Air-Water 2 reads OPEN for ~60 s, then CLOSED; pump 2 comes back online
within a few polls. Bad outcomes and what they mean are in the runbook §4: `cycle_open_unconfirmed` /
`verify_mismatch` = v2 OPEN not honoured → roll back to v1 (§5 of the runbook) while v1 still exists;
`close_failed` = urgent page, turn the breaker on at the panel.

## 5. After

- `scripts/drift-check.sh` from a checkout: `[10]` should clear (no soak in `auto`).
- Journal: soak snapshot file, backup name, diff, restart time, post-flip health fields, the test's event codes
  and `span.write`, and the release verification. Update issue #199 (status: `auto` live, test outcome) and the
  README's live-state note.
- Off-Pi backup copy (owner 2026-11-23): DONE 2026-11-24 11:55 ET. `scripts/pi-backup-pull.sh` + `scripts/launchd/com.a2w.pi-backup-pull.plist`
  on the administrator Mac pull the newest `bridge-YYYYMMDD.db` nightly at 04:07 to `~/a2w-pi-backups/` (keep 14) over the
  Pi's new 2222 listener. First pull: `OK pulled: bridge-20261124.db (212361216 bytes)` in 85 s; launchd job bootstrapped
  (`com.a2w.pi-backup-pull`, next run 04:07). Bug found and fixed on the first run: the verify step opened the copy with
  `mode=ro`, which fails on a WAL-mode database copied without its `-shm`; now `mode=ro&immutable=1`, and the script stops
  after two failed candidates instead of walking back through every backup on the Pi.
- Ethernet: not in as of 2026-11-21; when the cable arrives, confirm eth0 has a lease, then remove the Wi-Fi pin
  (`nmcli con mod "netplan-wlan0-6 BB - AC" 802-11-wireless.bssid ""` + `con up`, via `systemd-run --on-active=5`).

## 6. Second bracket — DONE 11:43–11:55 ET: the off-Pi backup path (owner go 11:43 ET)

Facts read Mon 22:40 ET: the Pi's sshd listens on `0.0.0.0:22` and `[::]:22`; `/etc/ssh/sshd_config` has the
`Include sshd_config.d/*.conf` at line 12, no `Match` block, `UsePAM yes`; the only drop-in is `50-cloud-init.conf`
(root-only; `sudo cat` it first). Tailscale SSH answers port 22 on `100.70.39.44` (check mode). The tailnet passes
port 2222 (a `tailscale nc a2w-pi 2222` was *refused* in 2.4 s, so the ACL lets it through). The Mac's key is in
`~admin/.ssh/authorized_keys` (2 of 2 lines). rsync 3.4.1 on the Pi, openrsync on the Mac. `ssh.service` is only
`After=network.target`, so the Tailscale address may not exist when sshd binds at boot: `ip_nonlocal_bind` covers that.
Mac side is ready: `~/.ssh/a2w-pi-backup.conf` (alias `a2w-pi`, port 2222, BatchMode, own known_hosts file).

```bash
sudo cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.bak-20261124
sudo tee /etc/ssh/sshd_config.d/90-a2w-backup-pull.conf >/dev/null <<'CONF'
# a2w backup pull (owner 2026-11-23): keep port 22 everywhere, add 2222 on the Tailscale address only
ListenAddress 0.0.0.0:22
ListenAddress [::]:22
ListenAddress 100.70.39.44:2222
CONF
sudo tee -a /etc/ssh/sshd_config >/dev/null <<'CONF'

# a2w backup pull (owner 2026-11-23): the tailnet-only 2222 listener is key-only, admin only.
# A Match block must stay at the END of this file (drop-ins are included at line 12).
Match LocalPort 2222
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    AllowUsers admin
CONF
echo 'net.ipv4.ip_nonlocal_bind = 1' | sudo tee /etc/sysctl.d/90-a2w-nonlocal-bind.conf >/dev/null && sudo /usr/sbin/sysctl -q -p /etc/sysctl.d/90-a2w-nonlocal-bind.conf
sudo sshd -t && sudo systemctl reload ssh && sleep 2 && sudo ss -ltnp | grep -E ':22 |:2222 '
```

Want: three listeners (`0.0.0.0:22`, `[::]:22`, `100.70.39.44:2222`), the current Tailscale SSH session still alive.
Then from the Mac, in this order: `ssh -F ~/.ssh/a2w-pi-backup.conf a2w-pi true` (accepts the new host key once),
`scripts/pi-backup-pull.sh` by hand (want `OK pulled: bridge-20261124.db (… bytes)` in `~/a2w-pi-backups/pull.log`,
about 210 MB over the tailnet), then
`cp scripts/launchd/com.a2w.pi-backup-pull.plist ~/Library/LaunchAgents/ && sed -i '' "s|__REPO__|$PWD|" ~/Library/LaunchAgents/com.a2w.pi-backup-pull.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.a2w.pi-backup-pull.plist`.
Rollback: `sudo rm /etc/ssh/sshd_config.d/90-a2w-backup-pull.conf; sudo cp -p /etc/ssh/sshd_config.bak-20261124 /etc/ssh/sshd_config; sudo sshd -t && sudo systemctl reload ssh`;
`launchctl bootout gui/$(id -u)/com.a2w.pi-backup-pull`. Not in Thursday's freeze window.

## 7. Close-out (owner 2026-11-23 22:50 ET: this session closes after Tuesday's work)

After §1–§6 and the December tag plan draft are done (about 11:30 ET): update
`knowledge/drafts/handover-20261121-heat-pumps-down-session.md` with the window's outcome (health fields, event codes,
soak snapshot file, backup name, listener state, pull log line), the Dec tag plan location and what is left open
(Ethernet pin removal if the cable did not come, #199 status, Thursday's freeze); write the final journal entry; then
archive this session. Anything still open goes to the planner-lane or hydronic session by journal, not by chat.

## Abort rules

Stop at any step if: a pump shows a fault, the hub shows the Pi disconnected, the planner is mid-handover, or the
owner is not watching. Step 1 can stand alone; steps 3 and 4 only together with the owner present.
