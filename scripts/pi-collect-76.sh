#!/usr/bin/env bash
# READ-ONLY diagnostic collector for a2w #76 (Pi network drop, 2026-09-16 14:16-15:29 UTC).
# Writes nothing outside /tmp, restarts nothing, touches no pump, no config, no service.
# Run ON the Pi. Deliberately uncommitted: pushing to main redeploys the planner.
set -u
OUT=/tmp/a2w-76-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$OUT") 2>&1

echo "=== 0. can journald still see 2026-09-16? (retention check, do this first) ==="
journalctl --no-pager -o short-iso -n 1 --reverse --since "2000-01-01" 2>/dev/null | head -1
echo "-- oldest retained entry above; journal storage config: --"
grep -E '^\s*Storage=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null || echo "Storage= not set (default: auto -> persistent only if /var/log/journal exists)"
ls -d /var/log/journal 2>/dev/null && echo "/var/log/journal EXISTS -> persistent" || echo "NO /var/log/journal -> VOLATILE, logs die at reboot"
journalctl --disk-usage 2>/dev/null

echo; echo "=== 1. did it ever reboot? (expect: no) ==="
uptime
journalctl --list-boots --no-pager 2>/dev/null | tail -5

echo; echo "=== 2. bridge log across the episode ==="
sudo journalctl -u heatpump-bridge --no-pager -o short-iso \
  --since "2026-09-16 14:00:00 UTC" --until "2026-09-16 15:35:00 UTC" 2>&1 | tail -200

echo; echo "=== 3. kernel: the wifi signature (brcmfmac / deauth / DHCP) ==="
sudo journalctl -k --no-pager -o short-iso \
  --since "2026-09-16 13:30:00 UTC" --until "2026-09-16 15:45:00 UTC" 2>&1 \
  | grep -iE 'wlan|wifi|brcmfmac|dhcp|link|deauth|disassoc|auth|carrier' | tail -120

echo; echo "=== 4. is the cheapest mitigation even applicable right now? ==="
iw wlan0 get power_save 2>&1 || echo "iw unavailable"
echo "-- current signal / association --"
iw dev wlan0 link 2>&1 | head -12
echo "-- addressing: DHCP or static? --"
ip -4 addr show wlan0 2>&1 | head -5
nmcli -t -f NAME,DEVICE,TYPE connection show --active 2>/dev/null | head -5

echo; echo "=== 5. SD card / filesystem health (look hardest here) ==="
sudo dmesg -T 2>&1 | grep -iE 'mmc|ext4|read-only|I/O error' | tail -30 || echo "none"
findmnt -no SOURCE,TARGET,OPTIONS / 2>&1

echo; echo "=== 6. why is the Pi not on the tailnet? (remote access is the winter lifeline) ==="
tailscale status 2>&1 | head -5
systemctl is-active tailscaled 2>&1

echo; echo "=== 7. watchdog + updater timers, state only ==="
systemctl is-active heatpump-bridge bridge-watchdog.timer heatpump-bridge-update.timer 2>&1

echo; echo "=== done. full output saved to: $OUT ==="
