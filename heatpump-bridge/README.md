# heatpump-bridge

Custom IoT control bridge for 2× Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water
heat pumps: remote setpoint control with guardrails, live monitoring, plain-English fault
alerts, and run history. Modbus RTU at 2400 8N1 over USR-W610 WiFi gateways in transparent
mode → **RTU framing over TCP** (not Modbus TCP).

Full context and settled design decisions: `../knowledge/reference/heatpump-bridge-handoff.md`.
Register map: `../knowledge/reference/modbus-register-map.md`.

## Quickstart (Phase 0 — simulator, no hardware)

```bash
uv sync

# terminal 1 — two fake heat pumps (modbus :15020/:15021, control API :8090)
uv run python sim/fake_pump.py

# terminal 2 — the bridge (config.yaml already points at the sim)
uv run uvicorn bridge.main:app --port 8000
```

Open http://localhost:8000 (or `http://<mac-ip>:8000 --host 0.0.0.0` from a phone).

Inject and clear faults while watching the UI:

```bash
curl -X POST localhost:8090/pumps/1/fault/P01              # critical: water flow
curl -X POST 'localhost:8090/pumps/1/fault/P01?on=false'   # clear it
curl -X POST localhost:8090/pumps/2/fault/P17              # info: anti-freeze (never red)
curl -X POST 'localhost:8090/pumps/1/register/2052?value=65516'  # ambient → −20°C
```

Tests: `uv run pytest`

## Layout

```
bridge/          service: config, modbus client, registers, faults, guardrails,
                 poller, sqlite store, api, app factory
sim/fake_pump.py simulated MAHRW030ZA pumps + fault-injection HTTP API
ui/              static mobile-first SPA (no build step), served at /
tests/           unit + integration (integration runs a real in-process sim pump)
deploy/          Pi systemd unit, production config template, W610 + cloudflared guides
```

## Write guardrails (always on)

Setpoint writes are clamped (422 outside 30–55 °C), rate-limited (60 s/pump), refused
offline (503), read-back verified (502 on mismatch), and audited to the event log with
their source. Per-pump `write_enabled: false` disables the write path entirely (Phase 1
default for real hardware).

## Phases

- **Phase 0 (this)**: everything against `sim/fake_pump.py` ✓
- **Phase 1**: one real pump, read-only — verify addressing/scaling/CRC, watch error
  rates 48 h (commissioning checklist in the register map doc)
- **Phase 2**: enable writes on pump 1, confirm wall controller reflects changes
- **Phase 3**: second pump, Cloudflare Tunnel, systemd hardening
- **Phase 4**: control logic (weather/price), HBX coordination — new API consumers
