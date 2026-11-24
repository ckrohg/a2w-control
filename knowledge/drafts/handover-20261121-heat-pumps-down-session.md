# Handover from the "Heat pumps down status" session (2026-11-13 → 2026-11-21)

Written Sat 2026-11-21 13:10 ET. The owner chose the other a2w session's Sat/Mon/Tue plan and told this
session to hand over and stop. Nothing below is still in flight from this session.

## What this session changed

| When (ET) | What | Evidence |
|---|---|---|
| Nov 13 | #292 merged (inert): self-heal treats a blind Pi as blind; the both-down page gets an all-clear. **Not on the Pi** until a release tag. | journal 2026-11-13 |
| Nov 13 17:44 | Pi wlan0 pinned to mesh node `02:92:BF:76:2C:EF` (`nmcli con mod … 802-11-wireless.bssid`, persisted in `/etc/netplan/90-NM-eb48b880-….yaml`). Pre-pin backup and `wifi-pin-rollback.sh` in `/root/a2w-netplan-backup/` on the Pi. | hub dropouts: 21/24 h before → 0–2 one-second ones a day after; 1 in the last 24 h (9 s) |
| Nov 20 18:52–18:57 | #297 (bridge 422), #296, #295 (mirror) gate-merged, inert, clean brackets. | deploy-gate output |
| Nov 20 18:52–19:03 | #294 (planner 400/413) gate-merged; 10 min lease handover, clean bracket. | deploy-gate output |
| Nov 20 18:54 | PR #299 opened: `knowledge/reference/span-v2-cutover.md` (docs only, still open). | PR #299 |

Nothing else was merged, no Railway variable was changed, no tag was cut, the Pi config was not touched.

## Delegate outputs (tenet delegate, account A, all read-only except the runbook)

- `knowledge/drafts/pr-293-second-review-20261120.md` — independent review of #293: MERGE WITH NOTES.
  Still relevant after the merge: (1) a hub command gated by the async `holdsWriterLease()` SELECT can go
  out after the early lease release (`shutdown.ts:114-120` vs `index.ts:241`); after the Monday apply, check
  `phase_b_log` for a "sent" row from the old instance after its release line. (2) The apply deploy itself
  will NOT show the `[shutdown]` proof lines; the first deploy after the apply is the proof. (3) Run
  `scripts/rehearsal/handover.sh` against the local Postgres before the apply. (4) `drift-ack.txt` line for
  #117 expired 2026-11-15; if the daily drift check is red for that, new drift is hidden.
- `knowledge/drafts/89-design-brief-20261120.md` — set `FORECAST_FETCH_ENABLED=1` only (shadow). Do NOT flip
  `FORECAST_PREHEAT_ENABLED` as built: `planPreheat` bypasses the cost-first floor and its blocks are not
  excursions under the live shaped curve. The settling test is a night below ~20 °F with a baseboard stat on;
  read `zone_floor_snapshots`.
- `knowledge/drafts/76-root-cause-brief-20261120.md` — Aug 5 was Pi-side Wi-Fi (~63 %) plus a real W610
  gateway share (~37 %). Keep #76 open narrowed to the gateway path; W610 link quality is readable over
  UDP 48899 AT commands; five instrumentation items listed.
- PR #299 — SPAN v2 cutover runbook. Before the Tuesday flip: save the soak snapshot (counters are in
  memory and the restart erases them); there is **no safe v2 test write**, the first real self-heal or gate
  action is the first proof; `drift-check [10]` fails today on the one soak disagreement and clears with
  the flip; after 2026-12-31 on v1, `span.read` still says "v1" (never cleared), judge by the timestamps.

## Pi access and release (for Tuesday)

- Tailscale SSH check approval has lapsed; the link printed by every attempt since Nov 20 is
  `https://login.tailscale.com/a/l3656e81317d26`. Once the owner approves it, a fresh
  `ssh -F ~/.ssh/a2w-pi.conf a2w-pi` connects (no held attempt needed).
- The Pi runs `release-20261102-1`. Main carries #292 (blind-Pi rule + all-clear), #297 (bridge 422),
  #287, #271, #265 for the bridge. Tag convention (owner only), from the last tag:
  `git fetch origin && git tag -a release-20261124-1 -m "release-20261124-1: <PR list>; owner-authorized in chat 2026-11-24" origin/main && git push origin release-20261124-1`.
  `heatpump-bridge-update.timer` runs `deploy/pi-update.sh` every 15 min: newest `release-*` tag,
  forward-only, update + restart + health check, rollback on failure, `.deployed` marker written only
  after a passed health check.
- Order for Tuesday: tag first, let the updater land it and verify `/api/health`, then the SPAN flip
  (config + restart), so each restart has its own bracket. Bridge `/health` is 404; use `/api/health`.
- Ethernet: eth0 profile `netplan-eth0` (DHCP) is ready. When the cable is in: confirm eth0 has a lease,
  then remove the pin (`nmcli con mod "netplan-wlan0-6 BB - AC" 802-11-wireless.bssid ""` + `con up`, via
  `systemd-run --on-active=5` so the SSH drop does not kill it).

## Leftovers to tidy

- `.claude/reviews/pr-293/` holds the PR diff and description (untracked); the review worktree was removed.
- Local branch `delegate/span-v2-cutover-runbook` is pushed (PR #299); delete after merge.
- Two stale messages reached the hydronic session on Sat 13:07 ET (composed Fri 19:03 ET, delivered after
  an 18 h popup wait); a correction followed. Disregard them.

## Addendum, Sat 2026-11-21 14:35 ET — this session is now the Pi / ops / reviews lane

The owner reversed the archive decision: this session owns the Pi (SPAN v2 flip, Wi-Fi pin and Ethernet,
release verification), independent second reviews via tenet delegate, and docs. "a2w project structure"
keeps every planner and hub merge and the Railway variables. Decisions today:

- **Tuesday Pi window, in this order:** owner cuts the release tag → `pi-update.sh` lands it (15 min timer) →
  verify `/api/health` → SPAN flip to `transport: auto` (save the soak snapshot first; config has `v2_soak: true`
  and no `transport:` line today) → **one deliberate, owner-present power-cycle of Air-Water 2 over v2 with pump 2
  idle**, read-back verified, so the first v2 write is observed and not discovered in a January E21 fault.
- **Tailscale** was approved 14:05 ET; SSH works. Pi at 14:13 ET: `release-20261102-1`, updater active, eth0 DOWN,
  wlan0 pinned at 47 %, SPAN soak 64,270 compared / 1 blind-spell disagreement / 34 unavailable, v2 connected
  and synced, Python 3.13.5.
- **PR #299** (SPAN v2 cutover runbook) merged 14:15 ET, inert. The squash subject is the delegate's prompt line.
- **#76:** three bridge instrumentation tasks queued on tenet (branches `delegate/76-pi-wifi-sample`,
  `delegate/76-offline-attribution`, `delegate/76-modbus-latency-crc`); this session reviews them and opens PRs.
  The W610 UDP AT probe and hub-episode persistence were not queued.
- **Forecast flag:** `FORECAST_FETCH_ENABLED=1` is the other session's to set today; never the pre-heat flag as built.
- **Reviews:** #303 and #305 both MERGE WITH NOTES (`knowledge/drafts/pr-303-second-review-20261121.md`,
  `pr-305-second-review-20261121.md`): merge #303 on a day above 8 °F outdoor; merge #305 while
  `backup_alarmed` is false.
- **How to ask the owner when away:** chat text + push notification; after 4 h take the recommended option only
  if reversible and not live.

## Addendum, Tue 2026-11-24 12:00 ET — the window's outcome (this session closes after it)

- **No tag.** Owner decision Mon: the Pi stayed on `release-20261122-1` (77a94da) all day; the December tag is Tue Dec 1 AM.
- **SPAN flip (owner go 11:27 ET).** Final soak 6420 compared / 6420 agree / 0 disagree / 2 unavailable, saved to
  `/home/admin/span-soak-final-20261124.json`. Config backup `~/bridge-data/config.yaml.bak-20261124-v2auto`; one line
  changed (`v2_soak: true` → `transport: auto`, soak line commented). Restart 11:28:19 EST; at t+10 s `span.mode auto`,
  `read v2`, `soak null`, v2 connected/synced, no errors; hub re-linked in < 1 s.
- **First real v2 write (11:30:19 ET).** 60 s `power_cycle` of Air-Water 2 sent from the Pi through a bridge UI session
  (the endpoint is human-only; API tokens are refused). `cycle_opened` "OFF (verified)" 11:30:20, `cycle_done` "OFF 61 s,
  back ON (verified)" 11:31:21, `close_attempts 1`, `span.write v2`. Pump 2 (idle) comm-offline 3 polls, back 11:31:41.
- **Restart side effects.** Phase B reported "NO LEASE ARMED" for its 11:32 cycle and re-armed at 11:37 (the restart
  clears the Pi's in-memory lease). drift-check: [2] green again, [6] 3 zero-minute dropouts (one is the restart),
  [10] cannot run from this Mac (no `HUB_CLIENT_TOKEN` here). Record: #199 comment 2026-11-24.
- **Backup listener (owner go 11:43 ET).** Pi sshd also on `100.70.39.44:2222`, key-only, admin only (drop-in
  `90-a2w-backup-pull.conf`, `Match LocalPort 2222` at the END of `sshd_config`, `ip_nonlocal_bind=1`); port 22 and
  Tailscale SSH unchanged; `sshd_config.bak-20261124` kept. First pull 11:55: `OK pulled: bridge-20261124.db
  (212361216 bytes)` in 85 s after fixing the verify step (`immutable=1`: WAL-mode copy has no `-shm`). launchd
  `com.a2w.pi-backup-pull` bootstrapped, 04:07 daily, keep 14, `~/a2w-pi-backups/`.
- **December tag plan:** `knowledge/drafts/december-tag-plan.md` (delegate, account B). Recommends #308/#309/#310/#315/
  #317/#322 on Dec 1 and #313 in a second tag Dec 3–4 after a rebase; #319 out until fixed; six owner questions at the end.

**Open after this session (by journal, not chat):**
- Ethernet: cable not in at 12:00 ET (eth0 NO-CARRIER). When it is: confirm `eth0` lease, then remove the Wi-Fi pin via
  `systemd-run --on-active=5` + `nmcli con mod "netplan-wlan0-6 BB - AC" 802-11-wireless.bssid ""` + `con up`;
  rollback `/root/a2w-netplan-backup/wifi-pin-rollback.sh`. Its own bracket, never inside the Thu freeze.
- Freeze Thu 2026-11-26 22:00 → Fri 03:30 ET (hydronic lane's element night): no Pi change, no tag.
- #313: rebase (conflicts with main), fix review findings 1 and 6, merge after the week of clean `auto` (ends Dec 1 11:28 ET).
- #319: fix per `pr-319-second-review-20261123.md` before it ships.
- drift-check [10] corroboration needs the hub client token on the ops Mac (owner's password manager).
- Rollbacks still available: `config.yaml.bak-20261124-v2auto` (v1 works until 2026-12-31); sshd: rm the drop-in, restore
  `sshd_config.bak-20261124`, `sshd -t`, `systemctl reload ssh`; `launchctl bootout gui/$(id -u)/com.a2w.pi-backup-pull`.
- Tip: an ssh ControlMaster to a2w-pi (`ControlPersist 5h`) survives the Tailscale check lapse (~12 h); open it right after the owner's click.
