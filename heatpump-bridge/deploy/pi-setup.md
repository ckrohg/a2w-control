# Raspberry Pi 5 setup — heatpump-bridge

One-time provisioning for the CanaKit Pi 5. End state: bridge on systemd,
UI reachable over Cloudflare Tunnel, everything restarts itself.

## 1. OS

- Raspberry Pi OS Lite 64-bit via Raspberry Pi Imager
- In the imager, preconfigure: hostname `heatpump-pi`, SSH on, WiFi (or Ethernet — preferred
  if there's a jack near the enclosure), locale/timezone `America/New_York`
- Set a DHCP reservation for the Pi in the router (stable LAN IP)

## 2. Bridge install

```bash
sudo apt update && sudo apt install -y git curl
curl -LsSf https://astral.sh/uv/install.sh | sh   # uv (installs a recent python too)

# NOTE: the bridge lives in a subdirectory of the a2w-control workspace repo
git clone https://github.com/ckrohg/a2w-control.git ~/a2w-control
cd ~/a2w-control/heatpump-bridge
uv sync --no-dev
cp deploy/config.production.yaml config.yaml
nano config.yaml                                  # set W610 IPs; keep write_enabled: false

# smoke test in the foreground — works BEFORE the W610s exist: the UI comes up
# with both pumps shown offline, and the service just keeps retrying
uv run uvicorn bridge.main:app --host 0.0.0.0 --port 8000
# → http://heatpump-pi.local:8000 from a phone on the LAN

# updates later: cd ~/a2w-control && git pull && cd heatpump-bridge && uv sync --no-dev \
#   && sudo systemctl restart heatpump-bridge
```

## 3. systemd

```bash
sudo cp deploy/heatpump-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now heatpump-bridge
journalctl -u heatpump-bridge -f     # watch it poll
```

Note the unit binds uvicorn to 127.0.0.1 — remote access is via the tunnel only.
For LAN-only testing before the tunnel exists, temporarily use `--host 0.0.0.0`.

## 4. Remote access

See `cloudflared-notes.md`. Summary: cloudflared tunnel → `https://heat.<your-domain>`
with Cloudflare Access (email OTP) in front. Zero open ports.

## 5. Sanity checklist

- [ ] `curl localhost:8000/api/health` → pumps_total = 2
- [ ] Reboot the Pi → service comes back by itself (`Restart=always` + `enable`)
- [ ] Pull a W610's power → pump goes `offline` in UI, alert event logged, no crash
- [ ] Error rate visible per pump in the UI comm footer (validates unshielded wiring)
