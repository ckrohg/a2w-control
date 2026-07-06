# USR-W610 configuration — per heat pump

## ⚠ Restrict who can reach the gateways (fusion audit, risk #1) — layered, router-agnostic

The problem: each W610 exposes a **raw Modbus TCP port (8899) with NO authentication** and a
web admin page. On a flat network, anything on the WiFi can open a socket and write Modbus
frames straight to a pump, bypassing every software guardrail; a second connection can also
starve the Pi's polling. The software works fine either way — this is *hardening*, and the
worst case is capped by the untouched manual/HBX chain (heat can't be lost). But close it.

**These layers are independent — do the ones your setup allows; the first three and the
last work on ANY router. Aim for at least one strong barrier + detection.**

**A. Device-level (works on any router, no network skills):**
- **Change the W610 admin password** and **disable its cloud / remote-config service**.
- **Set max TCP clients = 1.** The Pi holds that one connection persistently, so a rogue
  client is *refused* while the Pi is connected — a real (if imperfect: a reconnect window
  exists) lock that needs no router support.
- **Strongest, verify on the bench:** run the W610 in **TCP-Client mode dialing the Pi**
  instead of TCP-Server. Then the gateway has **no listening port on the LAN at all** — it
  makes an outbound connection to the Pi, so nothing can connect *to* it. This works on any
  router and eliminates the exposure entirely. It needs a small Pi-side listener change;
  test it during Phase 1 (the pymodbus side must accept the W610's connection as its
  transport). If it works cleanly on your hardware, prefer it.

**B. Network-level (if your router supports it — see the UniFi note below):**
- **VLAN / separate network** for Pi + gateways, with a firewall rule permitting only the
  Pi to reach the gateways.
- **Firewall ACL** on a flat network: block the W610 IPs from everything except the Pi's IP.
- (Client-isolation on a guest/IoT SSID does NOT work here — it would also block the Pi
  from reaching the gateways.)

**C. Bring-your-own isolation (works with literally any main router):**
- A **~$30 dedicated mini-router** (e.g. GL.iNet): put the Pi + both W610s on it, uplink to
  the main network. Those three are on their own subnet, isolated by default, and the Pi
  still reaches the internet. Zero dependence on the main router's features.

**D. Detection (always on, any router — already built):** the bridge alerts if a pump's
power/mode changes with no matching dashboard/API write — surfacing a rogue write (or a
wall-controller change) even if a barrier is later misconfigured.

### UniFi / Ubiquiti (Dream Machine, UDM, or AmpliFi Alien)
You have the best case for layer B. On a UniFi console: create an **IoT network/VLAN**, put
the Pi + gateways on it, then add a **firewall rule** allowing only the Pi's IP to reach the
gateway IPs on 8899 (and block the gateways from initiating to the rest of the LAN). AmpliFi
Alien is more limited — if its firewall can't scope per-IP, fall back to layer A + C.



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
| Max clients | **1 (recommended, as a security lock — layer A above)**: only the Pi's persistent connection is accepted, a rogue client is refused. The bridge never probes a gateway it's already using, so 1 is fine operationally. |
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
