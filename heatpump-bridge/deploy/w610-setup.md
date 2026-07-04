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

## Network side

| Setting | Value |
|---|---|
| WiFi mode | STA (join the home LAN; the W610 boots as an AP `USR-W610-xxxx` for setup at 10.10.100.254, default admin/admin) |
| Socket | **TCP Server**, port **8899** (factory default) |
| Max clients | 1 is fine (the Pi is the only master) |
| IP | DHCP + **reservation in the router** (or static). Suggested: .61 for pump 1, .62 for pump 2 |

Change the admin password after setup. Label each unit physically (pump 1 / pump 2).

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
