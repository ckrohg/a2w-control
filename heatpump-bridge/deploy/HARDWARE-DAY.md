# Hardware day — the one ordered runbook

Everything else in `deploy/` is reference detail. This is the single sequence, in order,
with the safety gates called out. Do the desk-work phases (A) before the boxes even arrive;
they remove all the fiddly account/network steps from the day you're actually wiring.

Legend: 🖥 = at your desk · 🔧 = at the enclosure/panel · ⛔ = a hard gate, don't proceed past it

> ⚡ **Electrical safety (read once).** The enclosure is fed by a **120 V AC** tap from the
> adjacent Taco zone box via MC cable. Before touching that AC side, **kill the breaker feeding
> it and verify dead.** If you're not comfortable with line-voltage AC, have an electrician do
> the 120 V tap — everything downstream (RS-15-12 PSU → W610s → Pi) is 12 V/5 V and safe. The
> heat-pump BMS wiring (CN22) is low-voltage, but still do it with the pump panel powered off.

---

## Phase A — Desk work (do NOW, before hardware; no Pi/gateways needed)

- [ ] 🖥 **Accounts & secrets** (all free):
  - ntfy: pick a **hard-to-guess topic**, subscribe in the phone app. One topic for BOTH the
    Pi (faults/offline) and the hub's dead-man — use the same value for `A2W_NTFY_TOPIC` (Pi)
    and `NTFY_TOPIC` (hub).
  - Pick a **Pi dashboard password** for the local/LAN UI. Optional if you only control via the
    hub + Vercel and don't expose the Pi's own UI.
  - **Tailscale — OPTIONAL (fallback only).** The hub + Vercel are the primary remote path;
    Funnel is just the direct-to-Pi backup (full power/mode from away, or if the hub is down).
    One command to add later — not a bench-day item.
  - ~~healthchecks.io~~ **not needed** — the Railway hub is the dead-man: it already sees the
    Pi's ~15 s check-ins and pushes an ntfy alert if the Pi goes silent (set `NTFY_TOPIC` on the hub).
  - **Railway hub — DONE (deployed 2026-07-06):** live at
    `https://a2w-hub-production.up.railway.app`. The Pi token is on Railway
    (project `a2w-hub` → Variables → **`HUB_PI_TOKEN`**). Pass it to the bootstrap as
    `A2W_HUB_TOKEN=…` (below) and the Pi dials the hub on boot — nothing to hand-edit.
  - **Vercel dashboard + history DB — DONE (deployed 2026-07-07):** live at
    `https://a2w-analytics-mirror.vercel.app` with Neon Postgres attached. Pass
    `A2W_ANALYTICS_TOKEN=<INGEST_TOKEN>` (Vercel → Project → Settings → Environment Variables
    → **`INGEST_TOKEN`**) to the bootstrap and the Pi starts pushing history on boot.
- [ ] 🖥 **Restrict gateway access** — the #1 safety item. This install: gateways join the
      existing **shared IoT network (100+ devices)** on an AmpliFi Alien (no VLAN/firewall),
      so the defense is device-level, not isolation (see `w610-setup.md` §Restrict):
  - Confirm a **2.4 GHz-capable SSID** (W610s are 2.4 GHz only). DHCP reservations for all.
  - Baseline: W610 **max clients = 1** (the Pi's held connection refuses the other 100+) +
    admin password + disable cloud. Detection (rogue power/mode alert) already on.
  - End-state (Phase 1 bench): **W610 TCP-Client mode** — no listening port at all, so the
    shared network can't reach it. Needs a Pi-side accept-transport built after confirming
    the real device's connect behavior (registration/heartbeat bytes).
- [ ] 🖥 **Pi dress rehearsal** (once the CanaKit Pi is on hand — the single best de-risk):
  - Flash the SD card (`pi-setup.md` §1) and boot.
  - Run the bootstrap **with your secrets** so it comes up remote-ready. Every secret wires
    from one command — hub, history push, and alerts included:
    `A2W_UI_PASSWORD=… A2W_HUB_TOKEN=… A2W_ANALYTICS_TOKEN=… A2W_NTFY_TOPIC=… A2W_RESEND_API_KEY=… A2W_RESEND_TO=… bash -c "$(curl -fsSL …/pi-bootstrap.sh)"`
    (Each is optional/independent — omit any you're not using; the bridge just skips it. Add
    `A2W_TAILSCALE_AUTHKEY=…` too if you want the direct-to-Pi fallback.)
  - Run the **simulator on the Pi** (`uv run python sim/fake_pump.py`) and point config at
    localhost — then open the dashboard from your phone **over the LAN**
    (`http://heatpump-pi.local:8000`, or the Pi's IP if `.local` doesn't resolve — see
    `pi-setup.md`). This exercises the entire production stack (bootstrap, systemd, auto-update,
    hub link, dashboard, login, alerts) with zero hardware risk. If you set up Tailscale, test
    the remote path too. Everything you'd hit on the real day, you hit here first.
- [ ] 🖥 **BOM + tools check** — confirm `handoff §3` is ordered: 2× W610, 2× isolated RS-485
      repeaters, Mean Well RS-15-12 PSU, Gratury enclosure, 18/3 or Cat5e, MC cable + connectors,
      Wago 221s. **Plus these, easy to forget:**
  - **CN22-mating pigtail** — Winnie's "order from a photo": confirm the 4-pin connector actually
    mates CN22 (not a generic JST). This is the long-lead item that gates wiring pump 1.
  - **USB-RS485 dongle** (Phase B framing de-risk) — CH340-chip ones may need a macOS driver;
    FTDI/CP210x are plug-and-play.
  - **Multimeter/continuity tester** (CN22↔CN23 continuity check, Phase D) + a **clamp meter**
    (verify the 2063/2088 power-register units at commissioning).

## Phase B — Bench (gateways, before touching the heat pumps) 🔧

- [ ] Power each W610 on the bench; do them **one at a time**, label each PUMP 1 / PUMP 2.
- [ ] WiFi + serial config per `w610-setup.md`: join your SSID, set **2400 8N1, transparent,
      TCP server :8899**. Try dashboard → Setup → Scan → **Auto-configure serial**, but note it's
      **unproven on real hardware and this is your first unit** — plan to fall back to the W610's
      own web console (manual steps in `w610-setup.md`), which always works.
- [ ] Give each a **DHCP reservation**; record its **MAC** into `~/bridge-data/config.yaml`.
- [ ] **(Best pre-pump de-risk — kit on hand: USB-RS485 dongle ordered ✓)** End-to-end
      framing check through a **real W610**: wire the dongle A/B to a configured gateway, run
      the simulator behind it (`w610-setup.md` §Bench validation), and confirm the bridge
      polls at **0% error**. This proves the RTU-over-TCP framing (the #1 first-connection
      trap) on real gateway hardware before any heat pump is touched.
- [ ] Move both gateways onto the **isolated segment** from Phase A.

## Phase C — Pi in place 🔧

- [ ] ⛔ Mount the Pi + PSU/W610s in the enclosure. If wiring the **120 V AC** tap, breaker OFF
      first (safety note up top) — or have an electrician do it.
- [ ] Confirm the Pi is on the network and the dashboard loads at `http://heatpump-pi.local:8000`.
      If `.local` doesn't resolve (common on a busy consumer network), find the Pi's IP in your
      router's DHCP lease list and use that — see `pi-setup.md`.
- [ ] In the dashboard **Setup** tab, Scan and assign each gateway to its pump (MAC-matched).
      Pumps still show OFFLINE until wired — expected.

## Phase D — Wire ONE pump, read-only 🔧 (Phase 1)

- [ ] Panel off. Wire pump 1: board BMS header **CN22** → JST pigtail → isolated repeater →
      run → W610 A/B. A→A, B→B. **CN22 pins (confirmed by Winnie): 1=12V, 2=GND, 3=A(+),
      4=B(−) — land pins 2/3/4 only; ⛔ do NOT connect pin 1 (12V).**
- [ ] ⛔ **Leave the CN23 wall controller connected** — Winnie: the unit malfunctions without
      it. CN22 is a separate bus, so your tap doesn't touch it. Slave address = **1**.
- [ ] Leave `write_enabled: false`. Watch the dashboard: pump 1 goes online, live temps.
- [ ] **If it does NOT come online — the first-hour triage table.** The comm footer on the
      pump card shows a failure breakdown (`connect / timeout / io / nak`); read the symptom,
      not the tea leaves:

  | Symptom (comm footer / journalctl) | Likely cause, in order |
  |---|---|
  | `connect` failures | wrong IP/port · W610 off WiFi · its single client slot already taken (another tool connected? stale socket — see TCP-timeout setting) · W610 accidentally in a Modbus-TCP mode (listening on 502, not 8899) |
  | `timeout` (silence) | **RS-485 not selected on the W610 (check first!)** · repeater doesn't do 2400 baud · A/B swapped · wrong baud on the W610 · wrong slave address · CN22 not seated · CRC-polynomial quirk (run `deploy/crc-probe.py` — it splits CRC-vs-wiring in one shot; stop the bridge first) |
  | `nak` (exception responses) | the pump is ALIVE but refusing a register — almost certainly the reserved-hole read: flip `SPLIT_RESERVED_HOLE = True` in `bridge/registers.py` (prepared fallback; poll + write paths both follow it) |
  | `io` (mismatched/garbage frames) | noise on the bus (bias/termination on the repeater) · WiFi stalls (the bridge discards stale frames and reconnects on its own — watch whether it recovers) |
  | polls fine, temps look ×10 too big/small | scaling — set `TEMP_SCALE = 0.1` in `bridge/registers.py` (commissioning item, verify vs the wall controller) |

  **Field lessons from the 2026-07-12/13 commissioning (both real gateways + pumps):**
  - **Wrong baud = pure SILENCE, not garbage.** Both W610s shipped at 57600; read back +
    fix in one shot with `bridge.w610_config.configure_w610(host)` (vendor UDP :48899).
  - **The RS-485/232 selector is WEB-UI-ONLY** — `AT+UART` cannot see or set it, so remote
    config verification misses it. Re-check "485 mode: Enable" in the web console **after
    every Apply**: the UI loads stale forms with default dropdowns (300 baud / 5 data bits)
    and an Apply then writes those defaults.
  - **3-wire or silence: signal GND is required.** A/B-only hookups read as a dead pump.
    The W610 has **no GND terminal** — land CN22 pin 2 on the **Mean Well V−** that powers
    the W610 (or the isolated repeater's GND once installed).
  - **A parallel stub silences everything.** A shorted spare run left landed on the CN22
    pigtail flattens the pair and perfectly impersonates a dead pump port. For any "direct"
    test, physically disconnect EVERY other wire from the pins. (Symptom: healthy port
    reads ~3 V bias bare on the driving side, collapses to 0 V when the stub connects.)
  - **The pump answers only while POWERED** (obvious, but it cost hours) — and its first
    1–2 polls after power-on return boot garbage (all temps 0, then all −39). The bridge
    now skips those frames automatically (`is_boot_frame`).
  - **The definitive pump-side splitter:** `deploy/cn22-direct-probe.py` — FTDI dongle
    straight on CN22 pins 2/3/4, sweeps every dialect with zero intermediaries. A healthy
    pump streams at 2400 8N1 · addr 1 · standard CRC (confirmed on real hardware).

- [ ] Run the **commissioning checklist** in `reference/modbus-register-map.md`: verify
      addressing offset, temp scaling/signedness, power-register units, CRC, slave address.
      Cross-check temps against the wall controller. Watch the error rate for 48 h.

## Phase E — ⛔ HARD GATE before any writes (Phase 2)

Do not set `write_enabled: true` on any pump until ALL of these are done and recorded:

- [ ] ⛔ **Isolation VERIFIED**: run `deploy/verify-isolation.sh <gw1> <gw2>` **from a laptop
      (not the Pi)** — every port must be unreachable. Software cannot enforce this; this is
      the proof. Re-run after any router/firmware change.
- [ ] ⛔ **HBX-override bench test**: confirm whether a raw Modbus "off"/low-setpoint can
      override the HBX dry-contact heat call. Understand the answer before enabling writes.
- [ ] ⛔ **Winter-safe floor set**: `unattended_min_setpoint_c` (+ setback) from the house's
      design-day heat requirement, not the round default.

## Phase F — Guarded writes, one pump, then the second 🔧

- [ ] Flip `write_enabled: true` on **pump 1 only**. From the phone, change the setpoint →
      confirm the **wall controller reflects it** (proves the write is real and visible on
      the existing chain). This is the Phase 2 exit criterion.
- [ ] After a stable stretch, repeat wiring + gates for **pump 2**.
- [ ] Optional: turn on TempIQ later as a **read-only token** first (observe), then setpoint
      control (`api-integration.md`).

---

**If the whole custom stack dies at any point, heating runs exactly as before** — wall
controllers + HBX are untouched. That's the founding guarantee; nothing on this list puts
it at risk.
