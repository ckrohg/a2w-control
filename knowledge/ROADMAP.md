# ROADMAP — A2W Control

> Phases are settled (handoff §8). Phase 0 needs no hardware and can start immediately.

## Done — Phase 0: simulator-first build ✅ (2026-07-04)

- [x] Scaffold `heatpump-bridge/` repo per handoff §6.2
- [x] `sim/fake_pump.py` — RTU-over-TCP pymodbus servers w/ toy physics + HTTP fault-injection API
- [x] `registers.py` + `faults.py` + `modbus_client.py` + guardrails + poller + SQLite store + API — 27 tests passing
- [x] Mobile UI (no build step) against two simulated pumps
- [x] **Exit verified:** setpoint changed from phone-sized UI with verified read-back; P01/P17/E18 injected → plain-English alerts appeared with correct severities and cleared

## Multi-model fusion audit (2026-07-05, judge signal DIVERGENT, 3/4 legs — Gemini failed)

Architecture/safety audit by Claude Opus+Sonnet, GPT-5.5, judged cross-vendor. Findings:
- [x] **Risk 1 — W610s = unguarded 2nd Modbus master on flat LAN** (the panel's #1). Fixed
      in docs: REQUIRED network-isolation step in `w610-setup.md` (VLAN/ACL/client-isolation
      + change W610 admin pw + disable cloud). Software guardrails are wire-bypassable without it.
- [x] **Risk 3b — stale data shown as live** (false assurance). Fixed: UI stale banner +
      dimmed values when offline / last poll >90s (commit 65f22c2).
- [x] **Risk 2 — cold-latch.** FIXED (58320b0): `restrict_unattended_writes` (default on) —
      machine tokens setpoint-only; scheduler "off" → setback setpoint, never power-off;
      human UI keeps full control.
- [x] **Risk 3 — alerting.** FIXED (58320b0): ntfy push on high/critical faults, offline,
      identity-mismatch, recovery (P17 never pages) + healthchecks.io dead-man heartbeat.
      Owner must set `notifications.ntfy_topic` (+ optional `heartbeat_url`) to activate.
- [x] **Risk 4 — mutable-main auto-deploy.** FIXED (58320b0): `pi-update.sh` deploys only
      owner-promoted `release-*` tags. First tag: `release-20260705-1`. **New workflow:
      cut `git tag release-YYYYMMDD-N && git push --tags` to ship to the Pi.**
      (Deferred sub-item: health check proving both pump sockets poll — needs hardware.)

## Fusion RE-AUDIT of the fixes (2026-07-05, CONVERGENT — high confidence)

Verdict: fixes sound; **read-only Phase 1 OK once isolation is actually verified**;
write-enabled Phase 1 needed 3 edge-fixes — all now done (release-20260705-2):
- [x] Blind-deploy: `/api/health` → 503 when a write_enabled pump has no fresh poll (90s).
- [x] Unattended setpoint FLOOR (`unattended_min_setpoint_c`) — setpoint-only was still heat-removing.
- [x] Level-based alerting: heartbeat → healthchecks.io `/fail` on active fault/offline.
- [x] Forward-only tag deploy (no backward deploy from a stray old tag).
- [x] `verify-isolation.sh` + hard write-enable commissioning gate; unexpected power/mode alert.

**Still the #1 real risk (by design, needs the human at commissioning):** W610 isolation
must be *verified from a non-Pi host* and the HBX-override bench test run BEFORE any pump's
`write_enabled: true`. Software can't enforce network isolation; the gate + script make it
a recorded step. Read-only Phase 1 does not need it live but should verify it early.

## Pre-hardware checklist (everything doable before the W610s arrive)

- [ ] **Pi dress rehearsal** (if the CanaKit Pi is on hand): flash the SD card, boot,
      run the one-command bootstrap. Optionally run the simulator ON the Pi
      (`uv run python sim/fake_pump.py` + point config at localhost) — full dashboard
      from a phone, exercising the exact production stack end-to-end.
- [x] **Remote access decided (2026-07-05): Tailscale Funnel** — free, no domain, public
      HTTPS URL gated by the bridge login. One-command `deploy/setup-remote.sh` on the Pi.
      Custom domain (Cloudflare, ~$10/yr) is a non-breaking later upgrade for a pretty URL.
      (Full data-platform / Supabase mirror explicitly deferred — not wanted yet.)
- [ ] **Router prep**: confirm a 2.4 GHz-capable SSID with no client isolation; plan
      three DHCP reservations (Pi, W610 ×2).
- [ ] **Bench kit for W610 day**: any 12 V DC adapter for bench config, labels.
- [ ] **Decide alert notifications** (v1.1): critical faults (P01 water flow) currently
      show only in the UI — nobody gets paged. Options: ntfy.sh (free, no account),
      Pushover (~$5 once), or email. Fully buildable + testable against the sim now.
- [x] Winnie: BMS port/pinout **ANSWERED 2026-07-07** — CN22, pins 2/3/4=GND/A/B, separate
      bus, slave addr 1, no activation (`reference/winnie-bms-port-reply.md`).
      **THREAD CLOSED 2026-07-14 (owner):** serial number was sent, everything needed is
      answered, CN22 in active production use — nothing further owed either direction.

## Next — W610 prep + Phases 1–2

- [ ] When W610s arrive: bench-configure per `heatpump-bridge/deploy/w610-setup.md` (transparent mode, 2400 8N1, TCP server 8899, DHCP reservations)
- [ ] Pi provisioning per `heatpump-bridge/deploy/pi-setup.md` (can be done before the heat pump connection exists — bridge will just show pumps offline)
- [ ] Phase 1 (**ungated 2026-07-07** — Winnie confirmed CN22/pinout/bus/addr): one pump, read-only (write_enabled: false). Wire CN22 pins 2/3/4 (GND/A/B) — **not** pin 1 (12V); leave CN23 wall controller connected. Run the commissioning checklist in `reference/modbus-register-map.md` (addressing offset, temp scaling/signedness, CRC, power units — cross-check vs SPAN). Watch error rates 48h.
- [ ] Phase 1 bench: **W610 TCP-Client mode investigation** (topology: gateways on shared 100+ device IoT network, AmpliFi = no isolation). Confirm the W610 can dial the Pi with no listening port + whether it sends a registration/heartbeat packet on connect. If clean, BUILD the Pi-side accept-transport (identical RTU data plane, just accept-vs-connect + strip any registration bytes) as the airtight defense. Baseline until then = max-clients=1 + detection.
- [ ] Phase 2 **code refinements to land BEFORE flipping write_enabled** (from the 2026-07-11
      hardware-readiness review; deliberately not churned the night before install since Phase 1
      is read-only): (a) read-back verify gets ONE retry after ~1-2 s before declaring
      verify_mismatch (pump may commit async; measure actual commit latency at the bench first);
      (b) `note_local_change` registers the pending value BEFORE the physical write so an
      in-flight poll can't misreport our own write as "changed at the unit"; (c) a timed-out
      write re-reads the target register once after reconnect — audit `accepted_after_timeout`
      if it landed, `unconfirmed` if unknowable, never a bare `failed` for a write that may
      have applied.
- [x] Phase 2: flip write_enabled on pump 1; confirm wall controller reflects the change. **DONE 2026-07-13.**
- [x] **A-4 charge-dynamics test DONE 2026-07-14** → `reference/a4-results.md`: LWT follows setpoint (with min-modulation tail overshoot), HBX terminated at +3.1°F margin (I1 margin now 5°F), Modbus-off overrides an active HBX call, reg 2088 = inverter-only confirmed live.

## Later — Phases 3–4

- [ ] **Phase 4 design WRITTEN (2026-07-13): `reference/cross-system-optimization-plan.md`** —
      full A2W × TempIQ × HBX coordination/optimization architecture (grounded in the
      ECO-0600 manual + TempIQ internals research). Settles the deferred "TempIQ integration
      shape": **A2W owns the planner** (new `planner` service on the Pi); TempIQ stays a
      generic insights provider via its surface-token API; HBX keeps demand/staging/backup
      and later receives bounded tank targets. Key insight: the HP setpoint sets charge-time
      water temp (→ COP); the HBX tank target only terminates calls — Phase B (HP1 setpoint
      tracks HBX target + margin, no HBX writes needed) captures most savings and fixes the
      tank-target-above-HP-setpoint failure mode. Supersedes `tempiq-integration-sketch.md`
      §3 framing; lease mechanics carry over.
- [ ] Phase 3: second pump + Cloudflare Tunnel + systemd hardening (`Restart=always`)
- [ ] Phase 4 (future): weather-predictive / price-optimized setpoint scheduling — as a new consumer of existing API endpoints
- [ ] Phase 4 platform (architecture DECIDED 2026-07-06, `reference/remote-api-architecture.md`): **Cloudflare Tunnel + Access** for the remote optimizer API (direct tunnel, not a cloud relay). Setpoint **lease** primitive already built (release-20260706-1). Defer: cloudflared/DNS/Access wiring, the optimizer itself (start read-only → setpoint-only), any hosted dashboard (pure outbound push, later). Never let the optimizer hold authority without a lease.
- [ ] Phase 4 (future): **coordinated HP + HBX control** — hard requirement (2026-07-04): A2W must write HBX setpoints so buffer tank and heat pumps work in conjunction. Write path discovery: Proxyman capture of the SensorLinx app changing a setpoint (owner already built the read side this way). Same guardrail discipline as heat pump writes.

## Decisions deferred

- Notifications beyond in-UI (push/email) — v1.1, after alert quality is proven
- Predictive control design — after months of run history exist
- Shielded cabling — only if logged comm error rates say so
- **TempIQ integration shape** (decided 2026-07-04 to defer): either TempIQ writes the target temp via our guarded setpoint API, or TempIQ feeds signals and A2W's own logic decides. Both are just API consumers — nothing in Phases 0–3 changes. Leaning toward A2W owning the decision logic (guardrails and pump protection live here) — and the HP+HBX coordination requirement strengthens that lean, since the coordinator must command both devices and A2W is the only thing that will speak to both.
- HBX read patterns — borrow from TempIQv2's SensorLinx connector (reference only, NEVER edit that repo); HBX *write* must be discovered, see Phase 4 above and `reference/tempiq-borrowables.md`

## External dependencies

- Winnie @ Guangdong Macon — **THREAD CLOSED 2026-07-14 (owner):** serial number sent,
  everything needed answered (CN22 = BMS port, pinout, separate bus, no activation, slave
  addr 1 → `reference/winnie-bms-port-reply.md`), CN22 in active production use. Any
  remaining register curiosities (2092 meaning, forced-defrost) resolve at commissioning
  by observation, not by email.
- TempIQ insights API — **FILED 2026-07-14 as [ckrohg-org/TempIQv2#1470](https://github.com/ckrohg-org/TempIQv2/issues/1470)**
  (generic token-scoped read-only learned-metrics/COP API; a TempIQ agent builds it).
  **Circle back before heating season** — the winter shadow planner consumes it
  (optimization plan §7 A-7).
