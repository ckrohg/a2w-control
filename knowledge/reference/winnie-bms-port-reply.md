# Winnie's BMS/Modbus port answers — CONFIRMED 2026-07-07

Reply from **Winnie Liang @ Guangdong Macon** to the four questions emailed 2026-07-04
(the Phase-1 blocker). This is the authoritative record; it resolves every "pending Winnie"
item in the handoff, register map, ROADMAP, and deploy guides.

## The questions (as asked) and her answers

**Q1 — Which connector is the BMS RS-485 port? Is it CN22 (4-pin, next to wire-controller
port CN23)?**
> **CN22.** Confirmed — CN22 is the BMS RS-485 / Modbus port.

**Q2 — Pin order? e.g. pin 1 = 12V, pin 2 = GND, pin 3 = A(+), pin 4 = B(−)?**
> **"The same as you mention."** Confirmed pinout:
> | Pin | Signal |
> |---|---|
> | 1 | **12V** |
> | 2 | **GND** |
> | 3 | **A (+)** / D+ |
> | 4 | **B (−)** / D− |
>
> ⚠️ We use pins **2 (GND), 3 (A+), 4 (B−)** only. **Do NOT connect pin 1 (12V)** — the
> W610 + isolated repeater are powered from the Mean Well RS-15-12, not from the board.
> Pin-1 12V into a bus/data terminal could damage the repeater or the board.

**Q3 — Independent bus, or shared with the wire controller? (I want the wall controller to
keep working.)**
> **"The communication bus for the wired controller is separate from the Modbus
> communication bus. The wired controller must remain connected; otherwise, the unit will
> malfunction."**
>
> Two facts:
> 1. **Separate buses.** CN22 (Modbus/BMS) is electrically independent of CN23 (wall
>    controller). Our tap on CN22 does **not** share the wall-controller bus → genuinely
>    additive, non-interfering. This is the founding guarantee, now manufacturer-confirmed.
> 2. **The wall controller MUST stay connected** or the unit malfunctions. We never planned
>    to remove it — but this makes it a hard rule: **never disconnect CN23.**

**Q4 — Does the BMS port need activation (parameter/DIP)? Default slave address?**
> **"The unit can operate normally even if the Modbus communication port is left
> unconnected. No parameter adjustments or DIP switch modifications are required for default
> use. Communication can be established directly by following the protocol specifications.
> The default Modbus slave address of the heat pump is 1."**
>
> - **No activation, no parameter change, no DIP change** for default use.
> - **Default slave address = 1** → confirms `device_id: 1` in config.
> - The port being connected or not does not affect unit operation (safe to tap/untap).

## What this unblocks / changes

- **Phase 1 read-only commissioning is no longer gated** — wiring can proceed as soon as the
  hardware is on hand (still pending: the W610 bench config + Pi provisioning + BOM arrival).
- The continuity check in `modbus-register-map.md` is now a *confirmation* step (expect
  isolation), not a go/no-go gate.
- `device_id: 1` is CONFIRMED (was "assume 1").

## Still open with Winnie (non-blocking)

- She replied asking for the **series/model number** ("As you do not order from us directly
  we need to check…"). **Action: reply with the model — MAHRW030ZA/BEH2** (from the unit
  nameplate) so she can confirm against the exact board revision.
- **Forced defrost** (manual §2.6) still has no known Modbus register — the one true control
  gap; ask if a register exists when you send the series number.
