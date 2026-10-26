#!/bin/sh
# A2W (2026-10-25, owner-approved): the Pi sits at -78 dBm on "6 BB - AC". After a few failed WPA
# authentications wpa_supplicant ignores the access point for 1800 s, so a blip became a multi-hour
# outage (266 disconnects Oct 14-22; 06:09-08:14 ET Oct 21 ended only by the bridge-watchdog reboot).
# Every minute: if wlan0 has been down for 2 checks in a row, clear the ignore list and reconnect.
# Remove with: systemctl disable --now a2w-wifi-recover.timer
# The Wi-Fi connection to bring back up: A2W_WIFI_CONN, else the first saved Wi-Fi profile.
CONN="${A2W_WIFI_CONN:-$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2 == "802-11-wireless" { print $1; exit }')}"
FLAG=/run/a2w-wifi-down
state=$(nmcli -t -f GENERAL.STATE device show wlan0 2>/dev/null | cut -d: -f2)
case "$state" in 100*) rm -f "$FLAG"; exit 0 ;; esac
if [ ! -e "$FLAG" ]; then touch "$FLAG"; exit 0; fi
/usr/sbin/wpa_cli -i wlan0 bssid_ignore clear >/dev/null 2>&1
logger -t a2w-wifi-recover "wlan0 down ($state): cleared the AP ignore list, reconnecting"
[ -n "$CONN" ] && nmcli connection up "$CONN" >/dev/null 2>&1 || true
