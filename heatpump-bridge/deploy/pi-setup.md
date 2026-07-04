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

## 2. Everything else — one command

From the Mac:

```bash
ssh pi@heatpump-pi.local
```

then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/ckrohg/a2w-control/main/heatpump-bridge/deploy/pi-bootstrap.sh | bash
```

The script installs git/curl/uv, clones the repo, installs dependencies, creates
`config.yaml` from the production template, installs + starts the systemd service,
and health-checks it. It is **idempotent — re-running it later is also the update
command** (pulls latest code and restarts).

Then open **http://heatpump-pi.local:8000** from your phone. Both pumps show
**OFFLINE** until the W610s exist — that's expected and correct.

## 3. When the W610s are up

```bash
nano ~/a2w-control/heatpump-bridge/config.yaml   # set the two W610 IPs
sudo systemctl restart heatpump-bridge
```

Keep `write_enabled: false` until Phase 2 — Phase 1 is read-only by rule (handoff §8).

## 4. Remote access (any network, not just home)

See `cloudflared-notes.md`. Summary: cloudflared tunnel → `https://heat.<your-domain>`
with Cloudflare Access (email OTP) in front, zero open ports. After the tunnel works,
edit `/etc/systemd/system/heatpump-bridge.service` to `--host 127.0.0.1` so the tunnel
is the only way in.

## 5. Sanity checklist

- [ ] `curl localhost:8000/api/health` → pumps_total = 2
- [ ] Reboot the Pi → service comes back by itself (`Restart=always` + `enable`)
- [ ] Set a DHCP reservation for the Pi in the router (stable LAN IP)
- [ ] Later, pull a W610's power → pump goes `offline` in UI, alert logged, no crash
- [ ] Error rate visible per pump in the UI comm footer (validates unshielded wiring)
