# USR-W610 configuration — per heat pump

## ⚠ REQUIRED security step: network-isolate the gateways (fusion audit, risk #1)

Every software guardrail (auth, clamp, rate-limit, MAC-pin, read-back, write_enabled)
lives inside the Pi. But each W610 exposes a **raw Modbus TCP port (8899) and a web admin
page** on the home WiFi. Anything else on that network — a phone, a guest laptop, a
compromised smart bulb, a stray `nmap` — can open a socket straight to a gateway and write
Modbus frames directly to a pump, **bypassing every guardrail at once**. A second process
holding that single socket also starves the Pi's polling. "The Pi is the only Modbus
master" is only true if the *network* enforces it.

Do at least one of these before go-live (in rough order of strength):
1. **VLAN / dedicated SSID** for the two W610s + Pi, isolated from the main LAN.
2. **Router firewall ACL**: allow TCP 8899 + the W610 admin port only from the Pi's IP.
3. **Client isolation** on an IoT SSID (blocks device-to-device), with the Pi on that SSID.
4. If the router can't do any of the above, a small dedicated AP for the Pi + gateways.

Plus, on each W610: **change the admin password** from the default, and **disable its
cloud / remote-config service** so it isn't reachable or configurable from outside.



Each pump gets its own W610 + isolated repeater chain (no shared bus). Configure each
W610 identically except for its IP/name. Do this on the bench BEFORE wiring to the pumps —
you can validate the whole chain against the simulator first (see bottom).

## Serial side (must match the heat pump BMS port)

| Setting | Value |
|---|---|
| Work mode | **Transparent mode** (transmission mode) |
| RS-485/RS-232 | RS-485 |
| Baud rate | **2400** |
| Data bits | 8 |
| Parity | None |
| Stop bits | 1 |
| Flow control | None (RS-485 direction is automatic) |

## Network side — joining the home WiFi, step by step

Do the two units **one at a time** (they ship looking identical) and label each
physically (pump 1 / pump 2) as you finish it. Exact menu names vary slightly by
firmware version, but the flow is always the same.

1. **Power the W610 on the bench** — any 5–36 V DC supply (the Mean Well from the
   enclosure works, or a 12 V wall adapter). Give it ~30 s to boot.
2. **Join its temporary setup network**: on a laptop or phone, open WiFi settings —
   a network named **`USR-W610-xxxx`** appears (usually open, no password). Join it.
3. **Open its settings page**: browse to **http://10.10.100.254** — login
   **admin / admin**.
4. **Point it at your home WiFi**: Wireless/WiFi settings → mode **STA** (station =
   "join a network" instead of broadcasting one) → Scan/Search → pick your home
   SSID → enter the WiFi password (WPA2). Leave STA IP on **DHCP**.
   ⚠️ The W610 is **2.4 GHz only** — if your WiFi is a mesh with a combined SSID
   that's fine, but a 5 GHz-only network won't work.
   ⚠️ Use the **same network/SSID as the Pi** — not a guest or "IoT" SSID with
   client isolation, or the Pi won't be able to discover or reach the gateways.
5. **Serial settings — try the automatic way first**: once the unit is on your WiFi,
   go to the dashboard → **Setup → Scan network** → tap the W610 → **Auto-configure
   serial**. The bridge pushes 2400 8N1 + transparent mode over the vendor protocol
   and reboots the unit. (Experimental until verified on unit #1 — if it reports it
   couldn't, fall back to the web console: transparent mode, RS-485, **2400 8N1**;
   socket = **TCP Server, port 8899**.)
6. **Change the admin password**, then **Save + Restart** from the web UI.
7. **The easy way from here — let the bridge find it.** Open the dashboard: the
   offline pump card shows a **Find gateway** button. Tap it — the bridge sweeps the
   LAN (USR broadcast + Modbus-port scan), lists candidates with IP, MAC, and a live
   heat-pump probe (it actually reads temps to prove which box is which). Tap the
   right one and you're done: the bridge connects, **adopts the W610's MAC
   automatically**, persists the assignment across restarts, and from then on
   verifies identity every poll AND follows the MAC to a new IP if DHCP ever
   reshuffles (self-healing, with an audit event).
8. Still recommended (belt + suspenders): give each W610 a **DHCP reservation** in
   the router (suggested .61 / .62) so addresses don't move in the first place.
   Manual alternative to step 7: put IPs + `mac:` values in
   `~/bridge-data/config.yaml` by hand, and check reachability with
   `nc -vz 192.168.1.61 8899`.

**If it goes sideways**: hold the W610's **Reload/Reset button ~5 s** → factory
reset → the `USR-W610-xxxx` setup network comes back and you start over. Nothing
precious is ever stored on the unit.

| Setting | Value |
|---|---|
| WiFi mode | STA |
| Socket | **TCP Server**, port **8899** (factory default) |
| Max clients | 2 if the firmware offers it (lets Setup-tab probes coexist with the live connection); 1 also works — the bridge never probes a gateway it's already using |
| IP | DHCP + **reservation in the router**. Suggested: .61 for pump 1, .62 for pump 2 |

## Wiring (per handoff §3 — settled)

Heat pump BMS header (CN22, pending Winnie's confirmation) → JST pigtail →
isolated repeater → 18/3 or Cat5e run → W610 RS-485 A/B terminals.
A→A, B→B throughout; if no comms at all, swapping A/B is the first thing to try.

## Bench validation against the simulator (no heat pump needed)

The exact framing the bridge will use in production can be tested end-to-end through a
real W610 before the pumps are touched:

1. Run the simulator on the Mac with a serial adapter attached to the W610's RS-485 side
   (USB-RS485 dongle wired A/B to the W610), or skip hardware and just point the bridge
   at the sim's TCP ports (`config.yaml` defaults).
2. Point `config.yaml` at the W610's IP:8899 and confirm polls succeed with 0% error rate.
3. Watch `error_rate` in the UI comm footer — this is the ongoing validation of the
   unshielded-wire decision. Rising error rate = revisit cabling, not baud rate.
