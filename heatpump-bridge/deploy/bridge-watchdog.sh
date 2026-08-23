#!/usr/bin/env bash
# @purpose: Self-heal ladder for the bridge, above the in-process transport rebuild.
# The 2026-08-20..23 incident: both W610 TCP connects failed for 3.2 DAYS while the
# bridge process stayed "up" — only a Pi reboot recovered the link. systemd's
# Restart=always only handles a crashed process, not a wedged one, and not a wedged
# Pi network stack. This watchdog closes that gap:
#
#   rung 1 (in-process): PumpClient rebuilds its pymodbus transport after ~10 min of
#          failed connects (modbus_client.py REBUILD_AFTER_CONNECT_FAILURES)
#   rung 2 (this script): ALL pumps offline >= RESTART_AFTER_MIN, or the health API
#          unresponsive >= API_DEAD_RESTART_MIN -> systemctl restart heatpump-bridge
#   rung 3 (this script): still all-offline >= REBOOT_AFTER_MIN after >= 1 restart
#          -> reboot the Pi (>= REBOOT_COOLDOWN_H between watchdog reboots)
#
# A reboot never threatens heat: the HBX keeps calling/staging regardless of the Pi.
# The script does NOTHING while the service is intentionally stopped (pi-update,
# winter drill step 2, an operator's systemctl stop).
#
# Install (one-time, as root):
#   cp deploy/bridge-watchdog.sh /usr/local/sbin/bridge-watchdog.sh
#   chmod +x /usr/local/sbin/bridge-watchdog.sh
#   cp deploy/bridge-watchdog.service deploy/bridge-watchdog.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now bridge-watchdog.timer
# Verify:  systemctl list-timers bridge-watchdog.timer ; journalctl -u bridge-watchdog
set -u

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/api/health}"
SERVICE="${SERVICE:-heatpump-bridge}"
STATE_DIR="${STATE_DIR:-/var/lib/bridge-watchdog}"
RESTART_AFTER_MIN="${RESTART_AFTER_MIN:-45}"
API_DEAD_RESTART_MIN="${API_DEAD_RESTART_MIN:-15}"
REBOOT_AFTER_MIN="${REBOOT_AFTER_MIN:-120}"
REBOOT_COOLDOWN_H="${REBOOT_COOLDOWN_H:-6}"
REBOOT_ENABLED="${REBOOT_ENABLED:-1}"

mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/state"
NOW=$(date +%s)

# state file: bad_since=<epoch> restarts=<n> last_reboot=<epoch>
bad_since=""; restarts=0; last_reboot=0
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

save_state() {
    printf 'bad_since=%s\nrestarts=%s\nlast_reboot=%s\n' \
        "${bad_since:-}" "${restarts:-0}" "${last_reboot:-0}" > "$STATE_FILE"
}

clear_bad() {
    if [ -n "${bad_since:-}" ]; then
        echo "recovered: pumps reachable again (bad for $(( (NOW - bad_since) / 60 )) min, $restarts restart(s))"
        bad_since=""; restarts=0; save_state
    fi
}

# Intentionally stopped (drill, pi-update, operator) -> not ours to fight.
if ! systemctl is-active --quiet "$SERVICE"; then
    clear_bad
    exit 0
fi

# 503 is a VALID answer (bridge up, a write-enabled pump stale) — only transport-level
# failure counts as "API dead". pumps_fresh = pumps with a successful poll in the last
# 90 s (api.py /health) — exactly the thing the 2026-08-20 wedge zeroed for 3 days.
body=$(curl -m 10 -s "$HEALTH_URL" 2>/dev/null)
curl_rc=$?

if [ $curl_rc -ne 0 ] || [ -z "$body" ]; then
    verdict="api_dead"
else
    verdict=$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    h = json.load(sys.stdin)
except Exception:
    print("api_dead"); raise SystemExit
if int(h.get("pumps_total") or 0) == 0:
    print("ok")          # nothing configured -> nothing to heal
elif int(h.get("pumps_fresh") or 0) >= 1:
    print("ok")
else:
    print("all_offline")')
fi

if [ "$verdict" = "ok" ]; then
    clear_bad
    exit 0
fi

if [ -z "${bad_since:-}" ]; then
    bad_since=$NOW; restarts=0; save_state
    echo "unhealthy ($verdict) — started tracking"
    exit 0
fi

bad_min=$(( (NOW - bad_since) / 60 ))
restart_after=$RESTART_AFTER_MIN
[ "$verdict" = "api_dead" ] && restart_after=$API_DEAD_RESTART_MIN

if [ "$restarts" -eq 0 ] && [ "$bad_min" -ge "$restart_after" ]; then
    echo "$verdict for ${bad_min} min — restarting $SERVICE (rung 2)"
    systemctl restart "$SERVICE"
    restarts=$((restarts + 1)); save_state
    exit 0
fi

if [ "$REBOOT_ENABLED" = "1" ] && [ "$restarts" -ge 1 ] && [ "$bad_min" -ge "$REBOOT_AFTER_MIN" ] \
        && [ $(( NOW - last_reboot )) -ge $(( REBOOT_COOLDOWN_H * 3600 )) ]; then
    echo "$verdict for ${bad_min} min despite $restarts restart(s) — rebooting the Pi (rung 3)"
    last_reboot=$NOW; bad_since=""; restarts=0; save_state
    systemctl reboot
    exit 0
fi

echo "$verdict for ${bad_min} min (restarts=$restarts) — waiting"
save_state
exit 0
