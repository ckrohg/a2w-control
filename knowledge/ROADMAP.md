# ROADMAP — A2W Control

> Phases are settled (handoff §8). Phase 0 needs no hardware and can start immediately.

## Done — Phase 0: simulator-first build ✅ (2026-07-04)

- [x] Scaffold `heatpump-bridge/` repo per handoff §6.2
- [x] `sim/fake_pump.py` — RTU-over-TCP pymodbus servers w/ toy physics + HTTP fault-injection API
- [x] `registers.py` + `faults.py` + `modbus_client.py` + guardrails + poller + SQLite store + API — 27 tests passing
- [x] Mobile UI (no build step) against two simulated pumps
- [x] **Exit verified:** setpoint changed from phone-sized UI with verified read-back; P01/P17/E18 injected → plain-English alerts appeared with correct severities and cleared

## Pre-hardware checklist (everything doable before the W610s arrive)

- [ ] **Pi dress rehearsal** (if the CanaKit Pi is on hand): flash the SD card, boot,
      run the one-command bootstrap. Optionally run the simulator ON the Pi
      (`uv run python sim/fake_pump.py` + point config at localhost) — full dashboard
      from a phone, exercising the exact production stack end-to-end.
- [ ] **Cloudflare account + domain** (~$10/yr) for the from-anywhere tunnel — the only
      remaining purchase decision that isn't hardware. (Alternative: Tailscale, no
      domain needed, app per device.)
- [ ] **Router prep**: confirm a 2.4 GHz-capable SSID with no client isolation; plan
      three DHCP reservations (Pi, W610 ×2).
- [ ] **Bench kit for W610 day**: any 12 V DC adapter for bench config, labels.
- [ ] **Decide alert notifications** (v1.1): critical faults (P01 water flow) currently
      show only in the UI — nobody gets paged. Options: ntfy.sh (free, no account),
      Pushover (~$5 once), or email. Fully buildable + testable against the sim now.
- [ ] Winnie: reply pending on BMS port/pinout (sent 2026-07-04); add the
      forced-defrost-register question when nudging.

## Next — W610 prep + Phases 1–2

- [ ] When W610s arrive: bench-configure per `heatpump-bridge/deploy/w610-setup.md` (transparent mode, 2400 8N1, TCP server 8899, DHCP reservations)
- [ ] Pi provisioning per `heatpump-bridge/deploy/pi-setup.md` (can be done before the heat pump connection exists — bridge will just show pumps offline)
- [ ] Phase 1 (gated on Winnie's CN22/pinout reply): one pump, read-only (write_enabled: false). Run the commissioning checklist in `reference/modbus-register-map.md` (addressing offset, temp scaling/signedness, CRC, power units — cross-check vs SPAN). Watch error rates 48h.
- [ ] Phase 2: flip write_enabled on pump 1; confirm wall controller reflects the change.

## Later — Phases 3–4

- [ ] Phase 3: second pump + Cloudflare Tunnel + systemd hardening (`Restart=always`)
- [ ] Phase 4 (future): weather-predictive / price-optimized setpoint scheduling — as a new consumer of existing API endpoints
- [ ] Phase 4 (future): **coordinated HP + HBX control** — hard requirement (2026-07-04): A2W must write HBX setpoints so buffer tank and heat pumps work in conjunction. Write path discovery: Proxyman capture of the SensorLinx app changing a setpoint (owner already built the read side this way). Same guardrail discipline as heat pump writes.

## Decisions deferred

- Notifications beyond in-UI (push/email) — v1.1, after alert quality is proven
- Predictive control design — after months of run history exist
- Shielded cabling — only if logged comm error rates say so
- **TempIQ integration shape** (decided 2026-07-04 to defer): either TempIQ writes the target temp via our guarded setpoint API, or TempIQ feeds signals and A2W's own logic decides. Both are just API consumers — nothing in Phases 0–3 changes. Leaning toward A2W owning the decision logic (guardrails and pump protection live here) — and the HP+HBX coordination requirement strengthens that lean, since the coordinator must command both devices and A2W is the only thing that will speak to both.
- HBX read patterns — borrow from TempIQv2's SensorLinx connector (reference only, NEVER edit that repo); HBX *write* must be discovered, see Phase 4 above and `reference/tempiq-borrowables.md`

## External dependencies

- Winnie @ Guangdong Macon (emailed 2026-07-04, reply pending — save reply to `knowledge/reference/`):
  - **Worth waiting for:** which board connector is the RS-485 BMS port (CN22?) and its pin order. Even this has a field fallback (silkscreen + CN23 wire tracing).
  - Bus independence (shared with CN23 vs dedicated) is **self-verifiable at tie-in** — safe procedure in `reference/modbus-register-map.md` (continuity check powered-off, listen-before-transmit). Kept in the email only because a "shared" answer would mean asking Macon for an alternative anyway — saves a round-trip in the bad case.
  - Non-blocking extras if she's answering anyway: units of 2063/2088 power regs, temp scaling (1 vs 0.1 °C/bit), what reg 2092 really is (current vs voltage), explicit defrost indicator?
  - Self-serve, no longer needed from her: slave address (= SW2 DIP, readable on the board; bridge can scan 1–16), activation (doc implies none), pigtail connector (order from a photo).
