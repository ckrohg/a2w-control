# PRODUCT SPEC — A2W Control (heatpump-bridge)

> Authoritative spec: `reference/heatpump-bridge-handoff.md` §6–§8. This file is the working summary. Register map: `reference/modbus-register-map.md` (distilled from Winnie's `A2W Modbus.docx`, which is the source of truth).

## Scope (v0.1 = Phase 0, simulator-first)

Full bridge service + UI running against **two simulated pumps** (`sim/fake_pump.py`). No hardware required. Exit criteria: change a setpoint from a phone UI, inject fault bits in the simulator, watch a plain-English alert appear and clear.

## Architecture (settled — do not redesign)

- **Bridge:** Python, FastAPI + pymodbus (async), single process on a Pi 5. One Modbus client per pump.
- **Framing gotcha:** W610 gateways run transparent mode → the Pi speaks **Modbus RTU framing over a TCP socket** (`AsyncModbusTcpClient` + `FramerType.RTU`), *not* Modbus TCP. This is the #1 likely first-connection bug.
- **Persistence:** SQLite (samples, events, comm_stats). No InfluxDB/Postgres/Grafana.
- **Remote access:** Cloudflare Tunnel + Cloudflare Access (email OTP). No custom auth, no open ports.
- **UI:** mobile-first SPA served by FastAPI at `/`. Both pumps visible at once.

## Surface inventory

```
GET  /api/pumps                        list pumps + connection health
GET  /api/pumps/{id}/status            latest snapshot (temps, setpoint, power, faults, comm stats)
GET  /api/pumps/{id}/history?hours=24  time-series samples
GET  /api/pumps/{id}/events?days=7     fault onset/clear + setpoint audit log
POST /api/pumps/{id}/setpoint          guarded write, returns verified read-back
GET  /api/health                       service self-check
```

Repo layout: `bridge/` (main, config, modbus_client, registers, faults, guardrails, poller, store, api), `ui/`, `sim/fake_pump.py`, `tests/`, `deploy/` — exact scaffold in handoff §6.2.

## Write guardrails (non-negotiable, before any write path is exposed)

1. Clamp setpoint to configured bounds; reject out-of-range with 422 (never silently clamp)
2. Read-back verification after every setpoint write
3. Rate limit writes per pump (~60s min interval)
4. Watchdog: N failed polls → offline; never replay stale writes
5. Audit log every write attempt
6. Comm error-rate tracking (CRC/timeout/reconnect) exposed in `/status` — validates the unshielded-wire decision

**Mode-aware setpoints (added 2026-07-04):** the units run heating OR cooling (reg 2001),
and each mode has its own setpoint register with its own valid range — heating → reg 2003
(clamp 30–75°C), cooling → reg 2002 (clamp 12–25°C), hot water → reg 2004 (writes refused,
409 — wall controller only). The write path re-reads the mode register fresh before every
write so a stale snapshot can never route a value to the wrong register.

**Control parity principle (owner decision 2026-07-04):** everything the wall controller
can do (and more) must be possible from the web view. Wall-controller capability audit
(factory manual §IV) → web status:

| Wall controller (§IV) | Web view |
|---|---|
| 2.2 On/off | ✅ power button + confirm modal (reg 2000) |
| 2.3 Setpoint | ✅ mode-aware stepper, clamp + verify |
| 2.4 Mode selection | ✅ Heat/Cool segmented + confirm (reg 2001, 0/1 only) |
| 2.5 Clock setting | N/A — timers run on the bridge's own clock instead |
| 2.6 Forced defrost | ❌ **only true gap** — no Modbus register exists; wall-controller-only (▼+function). Ask Winnie if a register exists. |
| 2.7/2.8 On/off timers (2 groups) | ✅ **superset**: unlimited daily on/off rules, stored in SQLite on the bridge, fire through the guarded audited write path (source=`schedule`), survive reboots, work even if the wall clock is unset |
| 2.9 Running parameter display (O2…d5) | ✅ Details table maps 1:1 to the manual's list |
| Installer parameters (params 0–28) | ✅ **writable** from the Unit parameters panel — tap to edit, warning modal citing manual §2.8, value validated against the protocol doc's own range per register, read-back verified, audited (`param_write`) |
| 2.1 Keyboard lock | N/A — Cloudflare Access is the auth layer |
| Emergency switch override (reg 2005, no wall equivalent) | ✅ writable like a parameter (0 auto / 1 force on / 2 force off) |

All control writes share the guardrail discipline — write_enabled flag, per-control rate
limiter lanes (setpoint/mode/power/param each independent), read-back verify, audit event,
immediate re-poll.

**Layered setpoint MAX (corrected 2026-07-04 against the manual):** the spec table (p.3)
states max water outlet = **85°C (185°F)**, with rated operation at 75°C down to −12°C
ambient. Layers: 85°C code hard ceiling (config refuses to start above it) > config clamp
(default **75°C / 167°F**) > **live reg 2027** (the unit's own max-water-temp parameter,
read every poll; effective max = min(config, reg 2027)). Effective bounds are in every
snapshot (`setpoint_bounds_c`) and shown under the setpoint control in the UI.
⚠️ Reg 2027 (wall param 17) ships at a factory default of 55°C and firmware-caps the
setpoint — it must be raised on the unit to actually command >55°C / 131°F water.

**Wall-controller parity (added 2026-07-04):** the UI shows everything the wall controller
can — mode, defrost indicator (heuristic: heating + running + four-way valve energized —
verify in Phase 1), what's firing (compressors, fan speed, circulating pump, electric heat,
crankcase/chassis heaters), per-stage refrigerant detail (discharge/coil/suction temps,
compressor Hz, current, EEV steps, IPM temp, pressures, bus/AC voltage), and hardware
switch states (water flow!, HP/LP, emergency) in a collapsible Details panel per pump.

## Fault alerting rules

- Bitfields 2111–2117 → {code, plain-English message, severity} via `faults.py` (bit maps in the register map doc)
- **P17 anti-freeze = Info, never pages** — normal NH winter behavior
- De-duplicate: alert once on onset with "still active" state; record onset/clear timestamps
- Always show raw code alongside plain English (for distributor calls)

## Out of scope (v1)

User accounts (Cloudflare Access handles auth), schedules, predictive logic, HBX integration, TempIQ integration, push/email notifications (fine for v1.1). Phase 4 (weather-predictive / price-optimized control, TempIQ signals) must arrive as a new API consumer, not a rewrite.

**Design seam for future integration:** every setpoint write carries a `source` identifier (e.g. `ui`, later `tempiq`/`scheduler`) in the request and audit log — handoff §6.4 already requires source in the audit; making it explicit in the API means a future machine consumer needs zero schema change.

## Open questions

- Sane setpoint clamp range (hardware max outlet 85 °C; reg 2027 default caps at 55 °C; pick operating bounds with owner)
- From Winnie (email sent 2026-07-04): CN22 = BMS port? pin order? bus independence? activation param/DIP + default slave address? mating pigtail? — blocks Phase 1, not Phase 0
- Commissioning checklist in `reference/modbus-register-map.md` (scaling, signedness, addressing offset, CRC, power units)
