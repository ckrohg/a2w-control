# ROADMAP — A2W Control

> Phases are settled (handoff §8). Phase 0 needs no hardware and can start immediately.

## Now — Phase 0: simulator-first build

- [ ] Scaffold `heatpump-bridge/` repo exactly per handoff §6.2
- [ ] `sim/fake_pump.py` — pymodbus server simulating a MAHRW030ZA (regs 2003, 2050–2052, 2063/2088, 2110–2118, fault-injection knobs)
- [ ] `registers.py` + `faults.py` + `modbus_client.py` with tests
- [ ] Guardrails + poller + SQLite store + API
- [ ] Mobile UI against two simulated pumps
- [ ] **Exit:** setpoint change from phone UI + injected fault appears/clears as plain-English alert

## Next — Phases 1–2: first real hardware (gated on Winnie's CN22/pinout reply)

- [ ] Phase 1: one pump, read-only (write path behind flag). Verify addressing/scaling/signedness/CRC against reality. Watch error rates 48h.
- [ ] Phase 2: enable guarded writes on pump 1; confirm wall controller reflects the change.

## Later — Phases 3–4

- [ ] Phase 3: second pump + Cloudflare Tunnel + systemd hardening (`Restart=always`)
- [ ] Phase 4 (future): weather-predictive / price-optimized setpoint scheduling, HBX awareness — as a new consumer of existing API endpoints

## Decisions deferred

- Notifications beyond in-UI (push/email) — v1.1, after alert quality is proven
- Predictive control design — after months of run history exist
- Shielded cabling — only if logged comm error rates say so

## External dependencies

- Winnie @ Guangdong Macon: CN22 confirmation, pinout, activation, slave address (emailed 2026-07-04, reply pending — upload reply to `knowledge/reference/` when it arrives, plus board photos when the panel is open)
