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
cd "$HOME/a2w-control/heatpump-bridge"

echo "==> python dependencies"
uv sync --no-dev

echo "==> config"
if [ ! -f config.yaml ]; then
  cp deploy/config.production.yaml config.yaml
  # template paths assume /home/pi — adapt to whatever user was chosen in the imager
  sed -i "s|/home/pi/a2w-control|$HOME/a2w-control|g" config.yaml
  echo "    created config.yaml (pumps will show OFFLINE until the W610 IPs are real)"
  echo "    edit later with: nano ~/a2w-control/heatpump-bridge/config.yaml"
else
  echo "    config.yaml already exists — leaving it alone"
fi

echo "==> systemd service"
sed -e "s|/home/pi/a2w-control|$HOME/a2w-control|g" \
    -e "s|^User=pi|User=$USER|" \
    deploy/heatpump-bridge.service | sudo tee /etc/systemd/system/heatpump-bridge.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now heatpump-bridge
sudo systemctl restart heatpump-bridge   # pick up new code when re-run as updater

echo "==> waiting for service"
for _ in $(seq 1 20); do
  if curl -fsS localhost:8000/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS localhost:8000/api/health && echo

echo
echo "✓ Done. Open http://$(hostname).local:8000 from a phone/laptop on the same network."
echo "  Pumps show OFFLINE until the W610 gateways are up at the IPs in config.yaml — that's expected."
echo "  Service logs: journalctl -u heatpump-bridge -f"
