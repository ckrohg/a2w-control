# USR-W610 configuration — per heat pump

## ⚠ Restrict who can reach the gateways (fusion audit, risk #1) — layered, router-agnostic

The problem: each W610 exposes a **raw Modbus TCP port (8899) with NO authentication** and a
web admin page. On a flat network, anything on the WiFi can open a socket and write Modbus
frames straight to a pump, bypassing every software guardrail; a second connection can also
starve the Pi's polling. The software works fine either way — this is *hardening*, and the
worst case is capped by the untouched manual/HBX chain (heat can't be lost). But close it.

**Assume the realistic topology: the W610s live on a busy shared IoT network with 100+
other devices, on a consumer router that can't do per-device firewalling.** So the primary
defense is DEVICE-LEVEL (independent of the network), not network isolation. Layers A + D
are the baseline; B/C are optional extras only if you happen to have the gear.

**A. Device-level — the baseline (works on any shared network, no network skills):**
- **Set max TCP clients = 1.** The Pi holds that one connection persistently, so every one
  of the 100+ other devices gets *connection refused*. The only gap is a brief window during
  a Pi/W610 reconnect, and grabbing it needs a device *actively targeting* that IP:8899 with
  Modbus — not random traffic. This is the main barrier on a shared network.
- **Change the W610 admin password** and **disable its cloud / remote-config service**.

**D. Detection — the other half of the baseline (always on, any network — already built):**
the bridge alerts if a pump's power/mode changes with no matching dashboard/API write, so a
rogue write (or a legitimate wall-controller change) surfaces even without a barrier.

Baseline residual risk: a *targeted* attacker already on your IoT network, who knows Modbus
+ this pump's register map, connects in a reconnect window, and writes — which then alerts
you and still can't stop the heat (manual/HBX chain untouched). Acceptable for a home.

**E. Airtight upgrade — TCP-Client mode (verify at the bench, Phase 1):** run the W610
dialing OUT to the Pi instead of listening. Then it has **no listening port at all** — the
100+ neighbors literally cannot connect to it. This is the true "works on any network" fix
and the recommended end-state. Not yet built: the Pi needs an accept-side transport, and the
real W610 may send a registration/heartbeat packet on connect that must be handled — both
confirmed on the bench, then a contained code change (same RTU data plane).

**B/C. Only if you already have the gear (most won't):** a VLAN + per-IP firewall rule
(UniFi-class routers), or a ~$30 mini-router for the Pi + gateways. Not expected here.

### This install: AmpliFi Alien + a shared IoT network (100+ devices)
The Alien is a consumer mesh router — no VLANs, no per-IP firewall rules — and the gateways
join the existing busy IoT network. So B/C don't apply. **Plan: layer A (max-clients=1 +
admin pw + disable cloud) + layer D detection as the baseline, then layer E (TCP-Client
mode) as the airtight end-state, verified on the bench.** That's a full defense that never
depends on isolating the gateways from their 100+ neighbors.



Each pump gets its own W610 + isolated repeater chain (no shared bus). Configure each
W610 identically except for its IP/name. Do this on the bench BEFORE wiring to the pumps —
you can validate the whole chain against the simulator first (see bottom).

## Serial side (must match the heat pump BMS port)

| Setting | Value |
|---|---|
| Work mode | **Transparent mode** (transmission mode) |
| RS-485/RS-232 | **RS-485** — ⚠️ CHECK EXPLICITLY: a unit left on RS-232 passes every other check but its A/B terminals are dead. First item in the no-comms triage, before A/B swap. |
| Baud rate | **2400** |
| Data bits | 8 |
| Parity | None |
| Stop bits | 1 |
| Flow control | None (RS-485 direction is automatic) |
| Serial package / auto-frame (UARTF) | **OFF (factory default — do not enable).** Packing that merges/splits frames confuses RTU framing; default pass-through is exactly right at 2400 baud. |

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
| Max clients | **1 (recommended, as a security lock — layer A above)**: only the Pi's persistent connection is accepted, a rogue client is refused. NOT the factory default (ships allowing many, AT+MAXSK) — set it in the web console's socket settings or via `AT+MAXSK=1`. The bridge never TCP-touches a gateway it's already using (scan + probe both skip it), so 1 is fine operationally. |
| TCP timeout (AT+TCPTO) | **60 s** — ⚠️ factory default is 0 = a dead client connection is held FOREVER. With max clients = 1, a Pi WiFi blip that dies without a clean close would then lock the Pi out of its own gateway. 60 s: the 20 s poll keeps a healthy socket alive; a dead one frees in ≤ 60 s. |
| IP | DHCP + **reservation in the router**. Suggested: .61 for pump 1, .62 for pump 2 |

**Verify the client-lock behavior (2 min, per unit):** (1) open TWO simultaneous
`nc <gw-ip> 8899` sessions from a laptop — the second must fail/refuse. (2) The stale-socket
recovery test: while the bridge is polling at 0% error, kill it uncleanly
(`sudo systemctl kill heatpump-bridge`), restart it, and time how long until polls succeed
again — should be ≤ the TCP timeout you set above. Record both results here.

## Wiring (per handoff §3 — settled; CN22 CONFIRMED by Winnie 2026-07-07)

Heat pump **BMS header CN22** → JST pigtail → isolated repeater → 18/3 or Cat5e run →
W610 RS-485 A/B terminals. A→A, B→B throughout; if no comms at all, swapping A/B is the
first thing to try.

**CN22 pinout (confirmed — `knowledge/reference/winnie-bms-port-reply.md`):**
`pin1 = 12V · pin2 = GND · pin3 = A(+) · pin4 = B(−)`. Land **pins 2/3/4 only**
(GND→repeater GND, A→A, B→B). ⚠️ **Do NOT connect pin 1 (12V)** — the W610 + repeater are
powered from the RS-15-12; 12V into a bus terminal can damage the repeater or the board.
⚠️ CN22 is a **separate bus** from the CN23 wall controller — **leave CN23 connected**, the
unit malfunctions without it. Slave address = **1** (no DIP/param change needed).

**The isolated repeater at 2400 baud:** check its manual for baud DIP switches or a minimum
supported rate — set 2400 explicitly if it has switches (some "auto-baud" repeaters don't go
that low). Prove it BEFORE the pump: put the repeater INTO the dongle bench chain
(dongle → repeater → W610 → sim poll at 0% error). A repeater that can't do 2400 looks
exactly like an A/B swap on the real bus. If comms work but `error_rate` is nonzero, enable
the repeater's bias/termination options before blaming the cable.

## Bench validation against the simulator (no heat pump needed)

This proves the exact framing the bridge uses in production (RTU-over-TCP ↔ real RS-485)
through a real W610 **before any pump is touched** — the #1 first-connection de-risk. The
Mac plays both ends; they only meet by crossing the physical W610:

```
bridge (master) ──WiFi/TCP:8899──▶ W610 ──RS-485 A/B──▶ USB-RS485 dongle ──USB──▶ sim (--serial)
```

1. **Configure the W610** (above): 2400 8N1, transparent, TCP server :8899, on the LAN.
2. **Wire the dongle** A/B → the W610's RS-485 A/B terminals (A→A, B→B).
3. **Run the sim on the dongle's serial port** (one pump; the sim's `--serial` mode uses the
   `pyserial` dev dep). Find the device with `ls /dev/tty.usb*` — usually
   `/dev/tty.usbserial-XXXX` (or `/dev/tty.wchusbserial*` for CH340 dongles, which may need a
   driver; FTDI/CP210x are plug-and-play on recent macOS):

   ```bash
   uv run python sim/fake_pump.py --serial /dev/tty.usbserial-XXXX   # 2400 8N1, device_id 1
   ```
4. **Point `config.yaml` at the W610's IP:8899** and confirm polls succeed at **0% error**.
   Inject a fault through the sim's control API (`curl -X POST localhost:8090/pumps/1/fault/P01`)
   and confirm it surfaces in the UI — that exercises decoding through the real gateway too.
5. Watch `error_rate` in the UI comm footer — this is the ongoing validation of the
   unshielded-wire decision. Rising error rate = revisit cabling, not baud rate.

> No dongle yet? Skip hardware and point the bridge at the sim's TCP ports (`config.yaml`
> defaults) — that's the pure-software path (Phase 0). The `--serial` path was verified
> end-to-end over a virtual null-modem (read + write round-trip); the dongle just replaces
> the virtual link with real wire.
