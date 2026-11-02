# heatpump-bridge

Custom IoT control bridge for 2× Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water
heat pumps: remote setpoint control with guardrails, live monitoring, plain-English fault
alerts, and run history. Modbus RTU at 2400 8N1 over USR-W610 WiFi gateways in transparent
mode → **RTU framing over TCP** (not Modbus TCP).

It runs on the house Pi as a systemd service (`deploy/heatpump-bridge.service`) against both
real pumps. Beyond Modbus it now also holds the LAN link to the SPAN panel (circuit power,
guarded breaker control, fault-triggered power cycles) and dials out to the Railway hub so
the planner and dashboard can reach it without any inbound port.

Full context and settled design decisions: `../knowledge/reference/heatpump-bridge-handoff.md`.
Register map: `../knowledge/reference/modbus-register-map.md`.

## Quickstart (simulator, no hardware)

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

The repo `config.yaml` is the simulator config (no `span:`, `hub:` or `self_heal:` sections,
so those subsystems stay off). The Pi runs from its own copy, templated by
`deploy/config.production.yaml`.

Tests: `uv run pytest`

## Layout

```
bridge/
  main.py           FastAPI app factory; lifespan opens the store and starts the pollers,
                    scheduler, exporter, hub client, SPAN poller, breaker controller, self-healer
  config.py         typed config from config.yaml (BRIDGE_CONFIG env); pump / guardrail / auth /
                    notifications / analytics / hub / span / self_heal sections + bridge-owned
                    state (gateway overrides, UI-added pumps)
  registers.py      single source of truth for the MAHRW030ZA register map, read blocks, scaling
  modbus_client.py  async RTU-over-TCP client per pump (W610 transparent mode), reconnects,
                    comm error counters
  poller.py         per-pump poll loop → snapshot cache + SQLite samples + fault edge detection;
                    owns the guarded setpoint write path
  faults.py         fault/protection bitfields (2111–2117) → plain-English alerts with severity
                    (P17 anti-freeze is INFO, never pages)
  guardrails.py     write-path guardrails: clamp with explicit rejection, per-pump rate limit,
                    offline checks
  store.py          SQLite persistence (WAL): samples, event log, comm stats
  api.py            JSON API; reads only from in-memory snapshots, never triggers Modbus traffic
  auth.py           Bearer tokens for machines (audit `source`) + signed UI session cookie
  scheduler.py      daily on/off timers per pump through the same guarded write path
  notify.py         best-effort ntfy push, Resend email for the intervention tier, dead-man
                    heartbeat; never raises into the caller
  exporter.py       read-only analytics mirror push to Vercel; out of the control loop
  hub_client.py     outbound WebSocket to the Railway hub: state frames out, `setpoint`,
                    `write_enable` and `breaker` actions in, through the existing guarded paths
  span_local.py     SPAN panel LOCAL-API poller (circuit instantPowerW), headless token re-mint,
                    CLOSE-ONLY relay writes unless an OpenPermit is held
  span_control.py   guarded breaker controller: allowlist, power_cycle / close / open, global
                    lock, mints the single-use OpenPermit
  self_heal.py      #189 fault-triggered power cycle of a pump's SPAN circuit via span_control;
                    shadow by default
  sysstat.py        stdlib-only Pi health sampler (CPU, load, RAM, disk, SoC temp, uptime)
  discovery.py      LAN discovery of W610 gateways (USR UDP broadcast + TCP sweep); MAC helpers
                    for the poller's identity check
  w610_config.py    EXPERIMENTAL remote W610 serial-side configuration over the vendor UDP channel
sim/fake_pump.py    simulated MAHRW030ZA pumps + fault-injection HTTP API (also a bench mode
                    over a real USB-RS485 dongle)
sim/fake_span.py    in-process fake of the SPAN local API for tests; relay writes validated
                    against the panel's own OpenAPI schema (sim/span_set_circuit_state.openapi.json)
ui/                 static mobile-first SPA (no build step), served at /
tests/              unit + integration (integration runs a real in-process sim pump; SPAN tests
                    run against sim/fake_span.py)
deploy/             Pi systemd units (bridge, auto-update timer, watchdog timer), production
                    config template, bootstrap/update scripts, W610 / Tailscale / cloudflared /
                    Railway-hub guides
```

## Write guardrails (always on)

Setpoint writes are clamped (422 outside the configured heating clamp), rate-limited
(60 s/pump), refused offline (503), read-back verified (502 on mismatch), and audited to the
event log with their source. Per-pump `write_enabled: false` disables the write path entirely
(the default for a freshly configured real pump). Unattended writers (scheduler, machine
tokens, hub commands) are setpoint-only under `guardrails.restrict_unattended_writes` and
floored by `unattended_min_setpoint_c`; a remote setpoint is a lease that reverts to
`baseline_setpoint_c` when the optimizer goes silent. The lease is dormant until
`baseline_setpoint_c` is set (`deploy/config.production.yaml` sets it).

## SPAN local

`bridge/span_local.py`. A LAN-only poller of the SPAN panel's local API for instant circuit
power on the backup element ("Buffer Tank") and the two heat-pump circuits. It is the
high-resolution half of a hybrid: spanwatch's hourly cloud record (planner side) is the
always-there backbone, this series is best-effort and a SPAN outage gaps only it. Control
and the bridge are unaffected.

- **Token re-mint.** The client mints its own bearer token from the panel's On-premise
  home-owner passphrase and auto-re-registers on any auth failure (401/403/412), rate-limited
  so a bad passphrase cannot spam the panel's client list. The token is persisted next to the
  DB so restarts almost never re-register. This removes the manual re-login that made the old
  On-premise link fragile.
- **Addressing.** mDNS hostname first, `ip_fallback` second, so a DHCP change does not break
  polling.
- **Close-only invariant.** `SpanClient` refuses to send OPEN unless the caller holds an
  `OpenPermit`, which only `span_control.BreakerController` mints. The backup-element ARM
  path (`arm_circuit`, close-only, DISARMED by default, shadow unless `arm_live`) never holds
  a permit, so nothing on that path can disable the failsafe.

Config keys (`span:`): `host`, `ip_fallback`, `passphrase`, `circuits`, `poll_interval_s`,
`down_alert_after_s`, `arm_circuit`, `arm`, `arm_live`, `arm_cooldown_s`. The poller is
enabled only when both `host` and `passphrase` are set. Inject the passphrase via the
bootstrap environment like the hub/analytics tokens; never commit it.

## Breaker control

`bridge/span_control.py`. The SPAN app's cloud path cannot switch circuits at this house, so
the dashboard reaches the panel through hub → Pi → LAN. Three actions on a config allowlist:

- `close` — turn a circuit ON. Every allowlisted circuit.
- `power_cycle` — OPEN, hold ≥ `min_off_s`, CLOSE in a `finally` with retries. Only circuits
  with `allow_cycle` (Air-Water 1/2 by default). A failed CLOSE pages urgent with the manual
  instruction and keeps re-closing in the background.
- `open` — turn a circuit OFF and leave it off. Only circuits with `allow_open`. Config
  refuses it on a heat-pump circuit, so nothing here can leave a heat pump off indefinitely.

Guards, all re-checked on a fresh panel read immediately before the OPEN: allowlist,
`isUserControllable`, an unambiguous panel name, **one action at a time** (a global lock that
includes background re-closes), **never two heat-pump circuits off at once**, and a read-back
of `relayState` after every write. The backup element is never power-cycled and is close-only
by name regardless of the allowlist, unless `span.backup_reopen` is set (default off, owner OK
required): then an OPEN is allowed only while the element draws under `backup_open_max_w` and
the owner's arm intent is not ARMED. `min_off_s` has a hard floor of 60 s and `max_off_s` caps a single hold. Before any
OPEN a cycle record is fsync'd next to the DB (or the cycle is refused); a restart that
interrupted a cycle finds it and finishes the CLOSE after the rest of the hold, the full hold
when the OPEN's timing is unknown. Cancellation never shortens a hold. Every attempt, accepted
or refused, is an audit event mirrored to the cloud plus a push/email line.

Config keys (`span:`): `breakers` (list of `name`, `allow_cycle`, `allow_open`, `heat_pump`),
`min_off_s`, `max_off_s`, `close_attempts`, `close_retry_delay_s`, `reclose_interval_s`,
`backup_reopen`, `backup_open_max_w`.

## Self-heal

`bridge/self_heal.py` (#189). When a pump sits in an equipment fault that a breaker power
cycle is known to clear (E21 by default) for at least `grace_min`, power-cycle its SPAN circuit
through the breaker controller, then verify recovery within `verify_min`. It runs on the Pi,
so it works with the cloud down.

- **Trigger = fault code only.** The "stage called but pump not heating" trigger needs the HBX
  stage call, which the Pi cannot see today; that stays planner-side (#185).
- **Guards.** Never during defrost, never while the pump is heating, never if the other pump
  is also down (page instead), never on a pump whose gateway identity check failed, one breaker
  action at a time, and every guard is re-checked on the fresh panel read right before the OPEN.
- **Budget.** At most `max_attempts` per pump per `window_h`, then escalate to a human. The
  budget is persisted with wall time + boot id + monotonic time so a clock step cannot expire
  it early; unreadable history counts as a spent budget.
- **Shadow by default.** `self_heal.live` defaults to `false`: the healer logs and pages what
  it *would* do and switches nothing. Flipping it live also requires `circuits_verified: true`,
  the owner's confirmation that the `circuits` pump→SPAN-circuit map was checked on the house
  (a swapped map would cycle the healthy pump). Until then `live: true` is reported
  "unavailable" in `/api/health.self_heal` and pages; shadow keeps running either way. That
  is the code default; the Pi's own config may differ, so check `/api/health.self_heal` for
  the mode actually running before assuming shadow.
- **Never a boot failure.** A pump whose circuit is not an `allow_cycle` heat-pump breaker, or
  an `off_s` outside the span limits, is reported unavailable, not fatal: the bridge also runs
  the setpoint path and must always start.

Config keys (`self_heal:`): `enabled`, `live`, `fault_codes`, `grace_min`, `max_attempts`,
`window_h`, `verify_min`, `off_s`, `running_power_w`, `circuits`, `circuits_verified`.

## Hub link

`bridge/hub_client.py`. The Pi dials OUT to the Railway hub over WebSocket and holds the
connection; no inbound port is opened. It pushes a state frame every `hub.state_interval_s`
and accepts exactly three relayed actions:

- `setpoint` — routed through `poller.write_setpoint`, so a nack from clamp, rate limit,
  offline, floor or `write_enabled` is a normal outcome.
- `write_enable` — the armed-dashboard remote arm/disarm toggle (the hub gates it behind a
  separate arm token). Same set + persist + audit path as the local `/write-enable` API route,
  with a high-priority push on enable; acked so the dashboard shows the outcome.
- `breaker` — routed through the breaker controller's guards, in its own task so a 60 s power
  cycle never stalls setpoints.

Power, mode and parameter writes are never relayed: any other action is logged and dropped
without an ack, and those stay human-only on the direct path. If the hub is down, local LAN and
Tailscale Funnel control are unaffected. Enabled only when both `hub.url` and `hub.token` are
set. See `deploy/railway-hub.md`.

## Phases

- **Phase 0** ✓ — everything against `sim/fake_pump.py`; still the dev loop (Quickstart above).
- **Phase 1** ✓ — one real pump, read-only; addressing/scaling/CRC verified, error rates
  watched (commissioning checklist in the register map doc).
- **Phase 2** ✓ — writes enabled on pump 1, wall controller confirmed to reflect changes.
- **Phase 3** ✓ — second pump, remote access (Tailscale, with cloudflared as the alternative),
  systemd hardening. The Pi runs both pumps under `deploy/heatpump-bridge.service`, with the
  auto-update timer and the watchdog timer alongside.
- **Phase 4** (current) — the hub/planner link: the planner on Railway drives setpoints as
  leases through the hub, the dashboard mirrors state, and the Pi carries the SPAN local
  link, breaker control and self-heal so the house can act with the cloud down. Weather/price
  control logic and HBX coordination live planner-side; the bridge stays the guarded executor.
