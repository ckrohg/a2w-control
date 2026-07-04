# USR-W610 configuration — per heat pump

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
5. **Same sitting, set the serial + socket settings** (see the tables in this doc):
   transparent mode, RS-485, **2400 8N1**; socket = **TCP Server, port 8899**.
6. **Change the admin password**, then **Save + Restart** from the web UI.
7. After restart the `USR-W610-xxxx` network disappears — the unit is now on your
   home WiFi. Find it in the **router's client list** and give it a **DHCP
   reservation** (suggested: .61 for pump 1, .62 for pump 2 — must match
   `~/bridge-data/config.yaml` on the Pi).
8. **Verify from the Mac or Pi**: `nc -vz 192.168.1.61 8899` → "succeeded" means the
   TCP server is up and the bridge can reach it.

**If it goes sideways**: hold the W610's **Reload/Reset button ~5 s** → factory
reset → the `USR-W610-xxxx` setup network comes back and you start over. Nothing
precious is ever stored on the unit.

| Setting | Value |
|---|---|
| WiFi mode | STA |
| Socket | **TCP Server**, port **8899** (factory default) |
| Max clients | 1 is fine (the Pi is the only master) |
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
