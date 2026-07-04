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
2. Read-back verification after writing reg 2003
3. Rate limit writes per pump (~60s min interval)
4. Watchdog: N failed polls → offline; never replay stale writes
5. Audit log every write attempt
6. Comm error-rate tracking (CRC/timeout/reconnect) exposed in `/status` — validates the unshielded-wire decision

## Fault alerting rules

- Bitfields 2111–2117 → {code, plain-English message, severity} via `faults.py` (bit maps in the register map doc)
- **P17 anti-freeze = Info, never pages** — normal NH winter behavior
- De-duplicate: alert once on onset with "still active" state; record onset/clear timestamps
- Always show raw code alongside plain English (for distributor calls)

## Out of scope (v1)

User accounts (Cloudflare Access handles auth), schedules, predictive logic, HBX integration, push/email notifications (fine for v1.1). Phase 4 (weather-predictive / price-optimized control) must arrive as a new API consumer, not a rewrite.

## Open questions

- Sane setpoint clamp range (hardware max outlet 85 °C; reg 2027 default caps at 55 °C; pick operating bounds with owner)
- From Winnie (email sent 2026-07-04): CN22 = BMS port? pin order? bus independence? activation param/DIP + default slave address? mating pigtail? — blocks Phase 1, not Phase 0
- Commissioning checklist in `reference/modbus-register-map.md` (scaling, signedness, addressing offset, CRC, power units)
