# Arctic Heat Pump Control Bridge — Project Handoff & Build Spec

> **Purpose of this document:** Complete context seed for a new Claude project. It captures everything decided, learned, and confirmed across the hardware-planning phase so a fresh Claude session (or Claude Code) can begin building software with zero re-litigation of settled decisions. Read this fully before proposing anything.

---

## 1. Mission

Build a custom IoT control layer for a residential hydronic heating system in southern New Hampshire, ending in a **clean, cloud-accessible web UI** that provides:

1. **Setpoint control** — change the heating target temperature of each heat pump remotely
2. **Live monitoring** — inlet/outlet/ambient temps, power draw, run state
3. **Plain-English fault alerts** — translate raw E/P/r fault codes into human-readable messages with severity and recommended action
4. **Run history** — time-series of temps, power, and events for trend review
5. **(Future phase)** Weather-predictive and electricity-price-optimized control logic

**Hard constraint:** The existing manual control chain must keep working untouched. The white wall controllers remain the local display and fallback. If the entire custom stack dies, the heating system operates exactly as it did before this project existed.

---

## 2. Physical Plant (existing, do not modify)

- **2× Arctic-branded air-to-water heat pumps** — Guangdong Macon **MAHRW030ZA/(BEH2)**, high-temperature two-stage units (R410A + R134a), 208–230V/1PH/60Hz, max outlet 85°C
- **HBX ECO-0600** buffer tank controller managing the buffer tank; it calls the heat pumps via dry contact (CN33 remote on/off input on each heat pump)
- Each heat pump has a **wired wall controller** (white display unit) connected via a 4-wire bus to CN23 on the heat pump's on/off control board
- HBX side already has connectivity via its native WiFi + SensorLinx app — **out of scope** for the bridge; the bridge talks only to the heat pumps

**Three independent control channels exist after this project:**
1. Wall controller ↔ heat pump (existing, untouched)
2. HBX dry contact call (existing, untouched)
3. RS-485 BMS port ↔ our gateway (new, additive)

---

## 3. Hardware Architecture (FINALIZED — do not redesign)

**One gateway chain per heat pump. No daisy-chained bus. Full isolation between the two systems.**

Per heat pump:
- **USR-W610** RS485-to-WiFi gateway
- **RS485-to-RS485 photoelectric isolated repeater** between the heat pump board and the W610 (galvanic isolation protects the heat pump main board)

Shared:
- **Mean Well RS-15-12** PSU (screw-terminal chassis style, base-mounted) powering both chains — single shared PSU was a deliberate right-sizing decision given non-critical failure mode
- **Gratury 14.6"×10.6"** plastic enclosure, perforated backplate, M3 machine screws
- 120V AC tapped from the adjacent Taco zone control enclosure via MC cable (Arlington/Halex connectors, Wago 221 splices)
- **Raspberry Pi 5** (CanaKit PRO) running the always-on bridge service — this is the only Modbus master

Wiring: unshielded 18/3 thermostat wire or scrap Cat5e is acceptable at 2400 baud over short runs. The bridge software **must log communication error rates** as ongoing validation of this decision.

Board connection: JST-style pigtail (pre-crimped, likely JST XH 2.54mm) from the heat pump board header → isolated repeater screw terminals → wire run → W610.

### Settled design principles (do not re-propose alternatives)
- No terminal blocks — direct-to-device wiring at this scale
- No DIN rail — screw-terminal chassis PSU chosen deliberately
- No shielded cable requirement — validate via error-rate logging instead
- Single shared PSU — acceptable failure mode
- The owner consistently rejects over-engineering; propose the right-sized solution first

---

## 4. Modbus Communication Spec

**Source of truth:** the Modbus RTU protocol document provided by **Winnie at Guangdong Macon** (manufacturer contact). Upload that document to this project — it is authoritative over anything summarized here.

### Serial / transport
- **Modbus RTU**, 2400 baud, 8 data bits, no parity, 1 stop bit (**2400 8N1**)
- Physical port: RS-485 BMS port on the heat pump main (on/off) board
- The W610 operates in **transparent mode**: it forwards raw RTU frames over a TCP socket. The Pi therefore speaks **Modbus RTU framing over TCP** — in pymodbus this means `AsyncModbusTcpClient` with the **RTU framer** (`framer=FramerType.RTU`), *not* standard Modbus TCP framing. Getting this wrong is the #1 likely first-connection bug.
- Each W610 gets a static IP (or DHCP reservation) on the home LAN; one TCP socket per heat pump; the two buses never interconnect.

### Key registers (from Winnie's protocol doc)
| Register | Meaning | Access | Notes |
|---|---|---|---|
| 2003 | Heating setpoint | R/W | The primary write target |
| 2050 | Inlet water temp | R/O | |
| 2051 | Outlet water temp | R/O | |
| 2052 | Ambient temp | R/O | |
| 2063 | Power draw (A) | R/O | Confirm units/scaling vs 2088 in protocol doc |
| 2088 | Power draw (B) | R/O | Confirm units/scaling vs 2063 in protocol doc |
| 2111–2117 | Error/protection bitfields | R/O | Bit positions map to E/P/r fault codes; exact bit→code mapping is in the protocol doc |

Verify scaling factors (×0.1 temps are common on Macon boards), signedness, and register offset convention (0-based vs 1-based addressing) against the protocol doc during commissioning — do not assume.

### Open hardware items (blockers for first physical connection, NOT for software build)
1. **Awaiting confirmation from Winnie** (email sent 2026-07-04): (a) is CN22 the BMS RS-485 port, (b) pin order, (c) independent bus vs shared with wall controller on CN23, (d) activation parameter/DIP switch and default slave address, (e) mating pigtail availability/connector type
2. Working hypothesis: CN22 is the BMS port (unused 4-pin twin of the wall controller header CN23); field verification plan exists (wall-controller terminal labels → wire colors → CN23 order; continuity check CN22↔CN23; silkscreen)
3. Default slave address assumed 1 until confirmed; make it configurable

**None of this blocks software development** — build and test against a simulated Modbus slave first (see Phase 0).

---

## 5. Fault Code Reference (for plain-English alerts)

Registers 2111–2117 are bitfields whose bits correspond to the fault codes below (exact bit mapping in Winnie's protocol doc). The unit is a two-stage machine: "System 1" = first stage (R410A), "System 2" = second stage (R134a); each stage has an inverter compressor and an on/off compressor. Full tables are in the installation manual (upload it to this project); condensed for alert design:

| Code range | Category | Plain-English pattern | Suggested severity |
|---|---|---|---|
| E01–E12 | Refrigerant-circuit temp sensor faults (discharge/coil/suction, per system/compressor) | "A temperature sensor on [stage] has failed — heating continues but service is needed" | Warning |
| E18 / E19 | Water outlet / inlet temp sensor fault | "Water temperature sensor failed — control accuracy degraded" | Warning-High |
| E21 | Wall controller ↔ main board comms fault | "Display controller lost communication with the heat pump" | Warning |
| E22 | Ambient temp sensor fault | "Outdoor temperature sensor failed" | Warning |
| E39–E42 | Internal board-to-board comms faults | "Internal control board communication fault — service needed" | High |
| E43 / E44 | Inverter board EEPROM fault | "Inverter board fault — contact distributor" | High |
| P01 | Water flow fault | "Low or no water flow — check circulation pump, valves, and filter" | **Critical** |
| P02–P05 | High pressure protection (per system/compressor) | "High refrigerant pressure — check water flow, dirty coil, or setpoint too high" | High |
| P06–P09 | Low pressure protection | "Low refrigerant pressure — possible refrigerant leak, service needed" | High |
| P10 | Phase / AC voltage protection | "Power supply problem detected" | High |
| P11–P14 | Discharge temp >105°C protection | "Compressor running too hot — check water quality and refrigerant charge" | High |
| P15 | Inlet/outlet ΔT too large | "Water flow too low for current output" | High |
| P16 | Over-cooling protection | (cooling mode; unlikely in this installation) | Warning |
| P17 | Winter anti-freeze protection | "Unit is protecting itself from freezing — NORMAL in cold weather, do not cut power" | **Info** (not an error!) |
| P19–P22 | Compressor AC current protection | "Compressor current abnormal — service if recurring" | High |
| P31–P34 | Inverter board coil overheat / anti-freeze | "Inverter cooling issue — possible refrigerant leak" | High |
| PC | Ambient temp too low | "Outdoor temperature below operating limit" | Warning |
| r01–r31 | Inverter drive board faults (IPM temp, compressor start, phase current, bus voltage, IPM module) | "Inverter drive fault [code] — contact distributor" | High |

Alert-design requirements:
- **P17 must not page anyone** — it is normal cold-weather behavior in New Hampshire; surfacing it as an error would train the owner to ignore alerts
- De-duplicate: a persistent fault should alert once with a "still active" state, not repeat every poll
- Record fault onset/clear timestamps in history
- Show the raw code alongside the plain-English text (useful when calling the distributor)

---

## 6. Software Architecture

### 6.1 Component overview

```
[Heat Pump 1 board] ─RS485─ [isolated repeater] ─RS485─ [W610 #1] ─WiFi─┐
                                                                         ├─ LAN ── [Raspberry Pi 5: bridge service] ── [Cloudflare Tunnel] ── [Browser UI]
[Heat Pump 2 board] ─RS485─ [isolated repeater] ─RS485─ [W610 #2] ─WiFi─┘
```

- **Bridge service (Pi 5):** Python, FastAPI + pymodbus (async). Single process, one Modbus client per heat pump. Serves the JSON API **and the static UI bundle** — no separate cloud host needed.
- **Persistence:** SQLite on the Pi (time-series samples + event log). Right-sized; do not propose InfluxDB/Postgres/Grafana unless SQLite demonstrably fails.
- **Remote access:** **Cloudflare Tunnel** (`cloudflared`) exposing the Pi's FastAPI over HTTPS at a subdomain, with **Cloudflare Access** (email OTP) in front for auth. Zero open router ports, free tier, survives IP changes. Tailscale is the acceptable alternative if the owner prefers; do not build custom auth.
- **UI:** Single-page app (React via Vite, or plain HTML+JS if simpler) served by FastAPI. Mobile-friendly — this will mostly be used from a phone.

### 6.2 Repository scaffold

```
heatpump-bridge/
├── README.md
├── pyproject.toml            # deps: fastapi, uvicorn, pymodbus>=3.6, pydantic-settings, apscheduler (or asyncio tasks)
├── config.yaml               # per-pump: name, host, port, slave_id, poll_interval; global: clamps, rate limits
├── bridge/
│   ├── __init__.py
│   ├── main.py               # FastAPI app factory, lifespan starts pollers
│   ├── config.py             # pydantic-settings models
│   ├── modbus_client.py      # async RTU-over-TCP client wrapper, reconnect logic, error-rate counters
│   ├── registers.py          # register map constants, scaling, decode helpers (single source of truth)
│   ├── faults.py             # bitfield → fault code → {code, message, severity} decoder
│   ├── guardrails.py         # clamp, read-back verify, rate limit, watchdog
│   ├── poller.py             # per-pump polling loop → snapshot cache + SQLite samples + fault edge detection
│   ├── store.py              # SQLite: samples, events, comm_stats tables
│   └── api.py                # routes (below)
├── ui/                       # static SPA, built output served at /
├── tests/
│   ├── test_guardrails.py
│   ├── test_faults.py
│   └── test_integration.py   # against pymodbus simulated server
├── sim/
│   └── fake_pump.py          # pymodbus server simulating a MAHRW030ZA: registers 2003, 2050-2052, 2063/2088, 2111-2117, with fault-injection knobs
└── deploy/
    ├── heatpump-bridge.service   # systemd unit (Restart=always)
    └── cloudflared-notes.md
```

### 6.3 API surface

```
GET  /api/pumps                       → list pumps + connection health
GET  /api/pumps/{id}/status           → latest snapshot: temps, setpoint, power, active faults, comms stats
GET  /api/pumps/{id}/history?hours=24 → time-series samples
GET  /api/pumps/{id}/events?days=7    → fault onset/clear + setpoint-change audit log
POST /api/pumps/{id}/setpoint {value} → guarded write (see below), returns verified read-back
GET  /api/health                      → service self-check
```

### 6.4 Write guardrails (non-negotiable, implement before any write path is exposed)

1. **Clamp:** setpoint accepted only within configured bounds (e.g., 30–65°C — confirm sane range for this system; hardware max outlet is 85°C but the operating range should be far tighter). Reject out-of-range with 422, never silently clamp without reporting.
2. **Read-back verification:** after writing register 2003, read it back; success only if it matches. Mismatch → error response + event log entry.
3. **Rate limiting:** minimum interval between setpoint writes per pump (e.g., 60s). Protects the board's EEPROM and prevents oscillating control loops later.
4. **Watchdog:** if a pump is unreachable for N consecutive polls, mark it offline in the UI and alert — never queue stale writes for replay.
5. **Audit log:** every write attempt (accepted or rejected) recorded with timestamp, old value, new value, source.
6. **Comm error-rate tracking:** CRC errors, timeouts, reconnects per pump — exposed in `/status`. This validates the unshielded-wire decision; a rising error rate is the signal to revisit cabling.

### 6.5 Polling design

- Poll each pump every 15–30s (configurable). At 2400 baud a multi-register read takes real time — keep reads batched (one read for 2050–2052, one for fault block 2111–2117, etc.) rather than register-by-register.
- The two pumps are on separate sockets/buses — poll concurrently, no shared-bus coordination needed (this is a payoff of the isolation architecture).
- Cache the latest snapshot in memory; API reads never trigger synchronous Modbus traffic.

---

## 7. UI Requirements

**Primary screen (per pump, both visible at once):**
- Current setpoint with +/- adjust and confirm (write → spinner → verified read-back → success state)
- Inlet / outlet / ambient temps, prominently
- Power draw
- Status chip: Heating / Idle / Offline / FAULT
- Active faults as plain-English cards (severity color, raw code, time active)

**Secondary:**
- History charts (24h/7d): temps, setpoint, power
- Event log (faults + setpoint changes)
- Comms health (error rate, last successful poll) — small, tucked away, but visible
- Both pumps side-by-side comparison is valuable (they serve the same buffer tank; divergence between them is itself diagnostic)

**Non-goals for v1:** user accounts (Cloudflare Access handles auth), schedules, predictive logic, HBX integration, notifications beyond in-UI (push/email alerts are a fine v1.1).

---

## 8. Build Phases

**Phase 0 — Simulator-first development (start immediately, no hardware needed):**
Build `sim/fake_pump.py`, the full bridge service, guardrails, fault decoding, and the UI against two simulated pumps. Exit criteria: change a setpoint from the UI on a phone, inject fault bits in the simulator, watch a plain-English alert appear and clear.

**Phase 1 — First real connection (after Winnie confirms port/pinout):**
One pump, read-only config (write path disabled by flag). Verify register addressing/scaling against reality, watch error rates for 48h.

**Phase 2 — Guarded writes on pump 1:** enable setpoint writes, verify wall controller reflects the change (proves the write is real and visible on the existing chain).

**Phase 3 — Second pump + Cloudflare Tunnel + systemd hardening.**

**Phase 4 (future) — control logic:** weather-predictive / price-optimized setpoint scheduling, HBX awareness. Design the API so this is a new consumer of existing endpoints, not a rewrite.

---

## 9. Files to Upload to This Project

1. **This document**
2. **Winnie's Modbus protocol document** (authoritative register map — the tables in §4 are a summary from memory of prior conversations; the doc wins on any conflict)
3. **Installation manual PDF** (`Manual_for_High_Temp_Heat_Pump__v3_Final.pdf` / `MAHRW030ZA_BEH2_--60HZ.pdf`) — fault tables, controller behavior, specs
4. Winnie's reply re: CN22/pinout/activation, once received
5. Photos of the on/off board around CN22/CN23, once the panel is open

## 10. Suggested First Prompt for the New Session

> "Read heatpump-bridge-handoff.md fully. We are starting Phase 0. Scaffold the repository exactly as §6.2 describes, then implement sim/fake_pump.py and the modbus_client + registers + faults modules with tests. Do not redesign the hardware architecture or propose alternative stacks — the design decisions in this document are settled. Ask me only about things the document leaves genuinely open."

