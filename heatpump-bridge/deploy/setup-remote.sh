#!/usr/bin/env bash
# @purpose: One-command remote access via Tailscale Funnel — a fixed public HTTPS URL for
# the dashboard, free, no domain, no app for viewers. The bridge's own login (protect=all
# + ui_password) is what gates it, so this MUST be paired with that config (checked below).
# Run on the Pi:  bash ~/a2w-control/heatpump-bridge/deploy/setup-remote.sh
set -euo pipefail

CONFIG="${A2W_CONFIG:-$HOME/bridge-data/config.yaml}"

echo "==> 0. safety check: is the bridge login configured?"
if ! grep -qE '^\s*protect:\s*(writes|all)' "$CONFIG" 2>/dev/null \
   || ! grep -qE '^\s*ui_password:\s*\S' "$CONFIG" 2>/dev/null; then
  cat <<EOF
  ⚠  Before exposing a PUBLIC URL, set these in $CONFIG:

    auth:
      protect: all                 # nothing visible without login
      ui_password: "a-long-passphrase-you-choose"

  then: sudo systemctl restart heatpump-bridge
  Re-run this script after that. (Refusing to expose an unauthenticated dashboard.)
EOF
  exit 1
fi

echo "==> 1. install Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "==> 2. join your tailnet"
if [ -n "${A2W_TAILSCALE_AUTHKEY:-}" ]; then
  # non-interactive: an auth key from https://login.tailscale.com/admin/settings/keys
  sudo tailscale up --authkey="$A2W_TAILSCALE_AUTHKEY" --hostname=heatpump-pi
else
  echo "   (a login link will print — open it once in any browser)"
  sudo tailscale up --hostname=heatpump-pi
fi

echo "==> 3. expose the dashboard publicly over HTTPS"
# Funnel must be enabled for your tailnet once in the admin console:
#   https://login.tailscale.com/admin/settings/features  (Enable HTTPS + Funnel)
# The exact funnel subcommand can vary by Tailscale version; this is the current form.
sudo tailscale funnel --bg 8000 || {
  echo "  Funnel command failed — likely needs enabling in the admin console (link above),"
  echo "  or your version uses a different syntax. Check: tailscale funnel --help"
  exit 1
}

echo
echo "✓ Remote access is live. Your dashboard URL:"
sudo tailscale funnel status || tailscale status --json | grep -i funnel || true
echo
echo "Open it from any network → you'll get the login page → enter your ui_password."
echo "Bookmark it / add to home screen; it never changes."
echo
echo "To turn remote access off later:  sudo tailscale funnel --bg off"
echo "Prefer a pretty custom URL (heat.yourname.com)?  see deploy/cloudflared-notes.md"
