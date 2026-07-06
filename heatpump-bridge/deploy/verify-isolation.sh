#!/usr/bin/env bash
# @purpose: Prove the W610 gateways are network-isolated BEFORE enabling writes (re-audit
# fix 1 — the #1 remaining risk). The bridge's guardrails all live in software; a raw
# Modbus write straight to a gateway's tcp/8899 bypasses every one of them. Isolation is
# the only thing that stops that, and "documented" is not "verified".
#
# Run this from a NON-Pi laptop/phone on the SAME home network as the gateways (not from
# the Pi — the Pi is *supposed* to reach them). Every port must be UNREACHABLE.
#
#   bash verify-isolation.sh 192.168.1.61 192.168.1.62
#
# A PASS here is the hard gate before you flip write_enabled: true on any pump. Re-run it
# after any router/firmware/VLAN change — asymmetric or dropped ACLs are the realistic
# failure, not "forgot to isolate".
set -u

[ $# -ge 1 ] || { echo "usage: bash verify-isolation.sh <gateway-ip> [<gateway-ip> ...]"; exit 2; }

probe() {  # host port -> 0 if reachable
  if command -v nc >/dev/null 2>&1; then
    nc -z -w2 "$1" "$2" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1
  fi
}

fail=0
for ip in "$@"; do
  for port in 8899 80 443; do   # Modbus + web admin (http/https)
    if probe "$ip" "$port"; then
      echo "  REACHABLE (BAD): $ip:$port is open from this host"
      fail=1
    else
      echo "  ok: $ip:$port unreachable"
    fi
  done
done

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — gateways are isolated from this host. Safe to enable writes."
else
  echo "FAIL — a gateway port is reachable from a general LAN host. Isolate the W610s"
  echo "       (VLAN / firewall ACL / IoT client-isolation) before enabling writes."
fi
exit "$fail"
