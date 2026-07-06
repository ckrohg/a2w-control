# Raspberry Pi 5 setup — heatpump-bridge

The idiot-proof path: **the SD card only ever gets the OS**; the bridge installs itself
with one pasted command afterward. End state: bridge on systemd, UI on the LAN,
everything restarts itself.

## 1. The SD card (on the Mac)

Any 16 GB+ microSD card. Everything on it will be erased.

1. Install the **Raspberry Pi Imager**: `brew install --cask raspberry-pi-imager`
   (or download from raspberrypi.com/software)
2. Insert the SD card, open the Imager:
   - **Choose Device** → Raspberry Pi 5
   - **Choose OS** → Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**
   - **Choose Storage** → the SD card
3. Click **Next** → **Edit Settings** (this is the part that makes it headless):
   - General: hostname **`heatpump-pi`** · username **`pi`** + a password ·
     WiFi SSID + password + country **US** (skip WiFi if using Ethernet — preferred
     if there's a jack near the enclosure) · timezone **America/New_York**
   - Services: **enable SSH**, "use password authentication"
4. **Write**, wait, eject. That's the whole card — nothing else ever goes on it.
5. Card into the Pi, power on, give it ~2 minutes on first boot.

## 1b. Getting the Pi on the network

**Decision (2026-07-04): all three devices — the Pi and both W610s — run on WiFi.**
No Ethernet anywhere; one less wire in the enclosure.

- The Pi's WiFi needs nothing beyond step 3 above — the credentials typed into the
  imager ride in on the SD card and it joins automatically on first boot.
  If the WiFi password ever changes, the cleanest headless fix is re-flashing the
  card with new credentials (2 minutes; nothing on the card is precious — the
  bootstrap script rebuilds everything). The W610s' WiFi onboarding is in
  `w610-setup.md`.
- All **three devices get DHCP reservations** in the router (Pi + both W610s) so
  addresses never drift.
- Everything monitoring-related depends on the WiFi router being up — acceptable by
  design: if WiFi (or the whole bridge stack) dies, the heating chain is untouched.
  The comm error-rate tracking in the UI is the ongoing check that WiFi is holding
  up; a wired fallback (Ethernet for the Pi, USR-N510-class wired serial servers
  for the pumps) remains possible later with only config-level changes.

Note the Pi mostly needs the **home LAN** (to reach the W610s and be reached by your
phone); actual internet is only used by the bootstrap/update command (GitHub) and
later by the Cloudflare Tunnel. Both arrive over the same connection automatically.

## 2. Everything else — one command

From the Mac:

```bash
ssh pi@heatpump-pi.local
```

then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/ckrohg/a2w-control/main/heatpump-bridge/deploy/pi-bootstrap.sh | bash
```

The script installs git/curl/uv/tailscale, clones the repo, installs dependencies, creates
`~/bridge-data/config.yaml` from the production template (config and database live
OUTSIDE the repo so updates can never clobber them), installs + starts the systemd
service and the auto-update timer, and health-checks everything. It is idempotent —
safe to re-run any time.

**Remote-ready in one shot (optional):** supply a dashboard password and a Tailscale
auth key (from https://login.tailscale.com/admin/settings/keys) and the Pi boots already
reachable from anywhere, login-gated — no follow-up steps:

```bash
A2W_UI_PASSWORD='a-long-passphrase' A2W_TAILSCALE_AUTHKEY='tskey-auth-...' \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/ckrohg/a2w-control/main/heatpump-bridge/deploy/pi-bootstrap.sh)"
```
(One-time: enable HTTPS + Funnel for your tailnet in the admin console. Secrets land in
shell history — `history -c` after, or put them in a file you `source`.) Without these
vars, Tailscale is still installed; run `deploy/setup-remote.sh` when you're ready.

Then open **http://heatpump-pi.local:8000** from your phone. Both pumps show
**OFFLINE** until the W610s exist — that's expected and correct.

## 3. When the W610s are up

```bash
nano ~/bridge-data/config.yaml     # set the two W610 IPs
sudo systemctl restart heatpump-bridge
```

Keep `write_enabled: false` until Phase 2 — Phase 1 is read-only by rule (handoff §8).

## 3b. How updates reach the Pi (hands-off)

Code changes are pushed to GitHub; the Pi checks every 15 minutes
(`heatpump-bridge-update.timer`) and applies new commits automatically:
pull → reinstall deps → restart → **health check → automatic rollback** to the
previous commit if the new code doesn't come up healthy (a failed commit is
quarantined and never retried; the next good commit supersedes it).

- Apply an update immediately: `sudo systemctl start heatpump-bridge-update.service`
- Watch update activity: `journalctl -u heatpump-bridge-update -f`
- Turn auto-updates off: `sudo systemctl disable --now heatpump-bridge-update.timer`

## 4. Remote access (any network, not just home)

**Fastest, free, no domain — Tailscale Funnel.** Gives the Pi a fixed public HTTPS URL you
open from any browser (no app to install), gated by the dashboard login.

1. Set the login in `~/bridge-data/config.yaml` (required before exposing publicly):
   ```yaml
   auth:
     protect: all                       # nothing visible without login
     ui_password: "a-long-passphrase"
   ```
   `sudo systemctl restart heatpump-bridge`
2. `bash ~/a2w-control/heatpump-bridge/deploy/setup-remote.sh`
   (installs Tailscale, joins your tailnet via a one-time login link, exposes the URL).
3. Open the printed `https://heatpump-pi.<tailnet>.ts.net` from anywhere → login page →
   your password. Bookmark it; it never changes.

**Want a pretty custom URL** (`heat.yourname.com`, ~$10/yr domain)? Use Cloudflare Tunnel
instead — `cloudflared-notes.md`. The bridge doesn't change; only the front door does, so
you can start with Funnel and switch later.

**For machine access (TempIQ):** `api-integration.md`. Same URL, a bearer token instead of
the login.

## 5. Sanity checklist

- [ ] `curl localhost:8000/api/health` → pumps_total = 2
- [ ] Reboot the Pi → service comes back by itself (`Restart=always` + `enable`)
- [ ] Set a DHCP reservation for the Pi in the router (stable LAN IP)
- [ ] Later, pull a W610's power → pump goes `offline` in UI, alert logged, no crash
- [ ] Error rate visible per pump in the UI comm footer (validates unshielded wiring)
