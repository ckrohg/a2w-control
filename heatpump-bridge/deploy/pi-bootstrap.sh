#!/usr/bin/env bash
# @purpose: One-command Raspberry Pi provisioning for heatpump-bridge.
# On a freshly imaged Pi (Raspberry Pi OS Lite 64-bit, SSH enabled), run:
#
#   curl -fsSL https://raw.githubusercontent.com/ckrohg/a2w-control/main/heatpump-bridge/deploy/pi-bootstrap.sh | bash
#
# Idempotent: safe to re-run (also serves as the update command).
set -euo pipefail

echo "==> apt packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl

echo "==> uv (python package manager)"
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

echo "==> clone / update a2w-control"
if [ -d "$HOME/a2w-control/.git" ]; then
  git -C "$HOME/a2w-control" pull --ff-only
else
  git clone https://github.com/ckrohg/a2w-control.git "$HOME/a2w-control"
fi
# Boot on the latest promoted release-* tag, NOT mutable main — matches the auto-updater's
# forward-only policy (same --sort=-creatordate selection + reset --hard, so it's compatible and
# stays on a branch). First boot then runs exactly the code a normal update would, even if main
# is mid-change on install day. No release tag yet -> stay on the cloned HEAD.
git -C "$HOME/a2w-control" fetch -q --tags --force 2>/dev/null || true
_latest_tag=$(git -C "$HOME/a2w-control" tag -l 'release-*' --sort=-creatordate | head -1)
if [ -n "$_latest_tag" ]; then
  git -C "$HOME/a2w-control" reset --hard -q "$_latest_tag"
  echo "    booting release $_latest_tag (not mutable main)"
fi
cd "$HOME/a2w-control/heatpump-bridge"

echo "==> python dependencies"
uv sync --no-dev

echo "==> config + data dir (outside the repo so updates can never clobber them)"
mkdir -p "$HOME/bridge-data"
if [ ! -f "$HOME/bridge-data/config.yaml" ]; then
  # template paths assume /home/pi — adapt to whatever user was chosen in the imager
  sed "s|/home/pi|$HOME|g" deploy/config.production.yaml > "$HOME/bridge-data/config.yaml"
  echo "    created ~/bridge-data/config.yaml (pumps show OFFLINE until the W610 IPs are real)"
  echo "    edit later with: nano ~/bridge-data/config.yaml"
else
  echo "    ~/bridge-data/config.yaml already exists — leaving it alone"
fi

# If a dashboard password was supplied (needed to expose a public URL safely), bake
# protect=all + the password into the live config. Auto-generate one if a Tailscale
# auth key was given without a password (never expose an unauthenticated dashboard).
if [ -z "${A2W_UI_PASSWORD:-}" ] && [ -n "${A2W_TAILSCALE_AUTHKEY:-}" ]; then
  A2W_UI_PASSWORD="$(openssl rand -base64 12 2>/dev/null || head -c 12 /dev/urandom | base64)"
  echo "    ⚠  no A2W_UI_PASSWORD given — generated one for you (SAVE IT): $A2W_UI_PASSWORD"
fi
if [ -n "${A2W_UI_PASSWORD:-}" ]; then
  uv run python - "$HOME/bridge-data/config.yaml" "$A2W_UI_PASSWORD" <<'PY'
import sys, yaml
path, pw = sys.argv[1], sys.argv[2]
cfg = yaml.safe_load(open(path))
cfg.setdefault("auth", {})
cfg["auth"]["protect"] = "all"       # nothing visible without login (safe for a public URL)
cfg["auth"]["ui_password"] = pw
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "    set auth.protect=all + ui_password (dashboard requires login)"
fi

# If a hub token was supplied, wire the Railway hub block into the live config so the Pi
# dials OUT to the hub on boot — remote setpoint control with no inbound port on the Pi.
# The token is a SECRET: it lives only here (env at bootstrap time) and on Railway, never
# in the repo. The URL defaults to the live production hub; override with A2W_HUB_URL. The
# hub client stays inert until BOTH url and token are set, so plain bootstraps skip it.
if [ -n "${A2W_HUB_TOKEN:-}" ]; then
  A2W_HUB_URL="${A2W_HUB_URL:-wss://a2w-hub-production.up.railway.app/pi}"
  uv run python - "$HOME/bridge-data/config.yaml" "$A2W_HUB_URL" "$A2W_HUB_TOKEN" <<'PY'
import sys, yaml
path, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = yaml.safe_load(open(path))
cfg["hub"] = {"url": url, "token": token, "state_interval_s": 15}
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "    wired hub: $A2W_HUB_URL (Pi dials OUT to the Railway hub — setpoint-only, leased)"
fi

# If an analytics ingest token was supplied, wire the read-only cloud mirror: the bridge
# pushes a state snapshot to the Vercel app every interval_s so the history dashboard fills.
# Pure OUTBOUND, best-effort — NOT a control path; if it's down nothing here is affected. The
# token is a SECRET (env-only, never in the repo). URL defaults to the live mirror; override
# with A2W_ANALYTICS_URL. Inert unless BOTH endpoint_url and token are set.
if [ -n "${A2W_ANALYTICS_TOKEN:-}" ]; then
  A2W_ANALYTICS_URL="${A2W_ANALYTICS_URL:-https://a2w-analytics-mirror.vercel.app/api/ingest}"
  uv run python - "$HOME/bridge-data/config.yaml" "$A2W_ANALYTICS_URL" "$A2W_ANALYTICS_TOKEN" <<'PY'
import sys, yaml
path, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = yaml.safe_load(open(path))
cfg["analytics"] = {"endpoint_url": url, "token": token, "interval_s": 60}
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "    wired analytics mirror: $A2W_ANALYTICS_URL (best-effort outbound snapshot push)"
fi

# Alerting (optional, independent): ntfy push + external dead-man heartbeat. Either or both
# wire from env — ntfy needs no account (just a hard-to-guess topic you subscribe to in the
# app); A2W_HEARTBEAT_URL is a healthchecks.io-style ping URL — if the Pi stops pinging
# (power/WiFi/ISP dead) THAT service alerts you (silence = alarm). Neither is a secret leak
# risk, but they live only here + on your phone/hc.io, never in the repo.
if [ -n "${A2W_NTFY_TOPIC:-}" ] || [ -n "${A2W_HEARTBEAT_URL:-}" ] || [ -n "${A2W_RESEND_API_KEY:-}" ]; then
  uv run python - "$HOME/bridge-data/config.yaml" <<'PY'
import os, sys, yaml
path = sys.argv[1]
cfg = yaml.safe_load(open(path))
n = cfg.get("notifications") or {}
if os.environ.get("A2W_NTFY_TOPIC"):
    n["ntfy_topic"] = os.environ["A2W_NTFY_TOPIC"]
    n["ntfy_server"] = os.environ.get("A2W_NTFY_SERVER", "https://ntfy.sh")
if os.environ.get("A2W_HEARTBEAT_URL"):
    n["heartbeat_url"] = os.environ["A2W_HEARTBEAT_URL"]
if os.environ.get("A2W_RESEND_API_KEY") and os.environ.get("A2W_RESEND_TO"):
    n["resend_api_key"] = os.environ["A2W_RESEND_API_KEY"]
    n["resend_to"] = os.environ["A2W_RESEND_TO"]
    if os.environ.get("A2W_RESEND_FROM"):
        n["resend_from"] = os.environ["A2W_RESEND_FROM"]
cfg["notifications"] = n
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "    wired alerts (ntfy / heartbeat / resend email from env)"
fi

echo "==> systemd service"
sed -e "s|/home/pi|$HOME|g" \
    -e "s|^User=pi|User=$USER|" \
    deploy/heatpump-bridge.service | sudo tee /etc/systemd/system/heatpump-bridge.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now heatpump-bridge
sudo systemctl restart heatpump-bridge   # pick up new code when re-run as updater

echo "==> auto-update timer (checks GitHub every 15 min, health-checks, rolls back)"
echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart heatpump-bridge" \
  | sudo tee /etc/sudoers.d/heatpump-bridge >/dev/null
sudo chmod 440 /etc/sudoers.d/heatpump-bridge
sed -e "s|/home/pi|$HOME|g" -e "s|^User=pi|User=$USER|" \
    deploy/heatpump-bridge-update.service | sudo tee /etc/systemd/system/heatpump-bridge-update.service >/dev/null
sudo cp deploy/heatpump-bridge-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now heatpump-bridge-update.timer

echo "==> waiting for service"
for _ in $(seq 1 20); do
  if curl -fsS localhost:8000/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS localhost:8000/api/health && echo

echo "==> remote access (Tailscale)"
# Always install Tailscale so remote access is one step away. If an auth key was
# supplied, bring it up + expose the dashboard publicly now — the Pi boots remote-ready.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if [ -n "${A2W_TAILSCALE_AUTHKEY:-}" ]; then
  A2W_TAILSCALE_AUTHKEY="$A2W_TAILSCALE_AUTHKEY" \
    bash "$HOME/a2w-control/heatpump-bridge/deploy/setup-remote.sh" || \
    echo "  remote-access setup hit an issue — finish manually: deploy/setup-remote.sh"
else
  echo "  Tailscale installed. To turn on remote access, run:"
  echo "    bash ~/a2w-control/heatpump-bridge/deploy/setup-remote.sh"
fi

echo
echo "✓ Done. Open http://$(hostname).local:8000 from a phone/laptop on the same network."
echo "  Pumps show OFFLINE until the W610 gateways are up at the IPs in config.yaml — that's expected."
echo "  Service logs: journalctl -u heatpump-bridge -f"
