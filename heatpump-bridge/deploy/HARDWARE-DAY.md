# Hardware day — the one ordered runbook

Everything else in `deploy/` is reference detail. This is the single sequence, in order,
with the safety gates called out. Do the desk-work phases (A) before the boxes even arrive;
they remove all the fiddly account/network steps from the day you're actually wiring.

Legend: 🖥 = at your desk · 🔧 = at the enclosure/panel · ⛔ = a hard gate, don't proceed past it

---

## Phase A — Desk work (do NOW, before hardware; no Pi/gateways needed)

- [ ] 🖥 **Accounts & secrets** (5 min each, all free):
  - Tailscale: create account, generate an **auth key** (Settings → Keys). Save it.
  - Pick a **dashboard password** (8+ chars) for the browser login.
  - ntfy: pick a **hard-to-guess topic** name, subscribe to it in the ntfy phone app.
  - (Optional) healthchecks.io: create a check, copy its **ping URL** (the dead-man).
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
  - Run the bootstrap **with your secrets** so it comes up remote-ready (add `A2W_HUB_TOKEN`
    to wire the Railway hub and `A2W_ANALYTICS_TOKEN` to wire the history push, same step):
    `A2W_UI_PASSWORD=… A2W_TAILSCALE_AUTHKEY=… A2W_HUB_TOKEN=… A2W_ANALYTICS_TOKEN=… bash -c "$(curl -fsSL …/pi-bootstrap.sh)"`
  - Run the **simulator on the Pi** (`uv run python sim/fake_pump.py`) and point config at
    localhost — then open the dashboard from your phone over Tailscale. This exercises the
    entire production stack (bootstrap, systemd, auto-update, remote access, login, alerts)
    with zero hardware risk. Everything you'd hit on the real day, you hit here first.
- [ ] 🖥 **BOM check** — confirm all of `handoff §3` is ordered: 2× W610, 2× isolated RS-485
      repeaters, Mean Well RS-15-12 PSU, Gratury enclosure, JST pigtails, 18/3 or Cat5e,
      MC cable + connectors, Wago 221s.

## Phase B — Bench (gateways, before touching the heat pumps) 🔧

- [ ] Power each W610 on the bench; do them **one at a time**, label each PUMP 1 / PUMP 2.
- [ ] WiFi + serial config per `w610-setup.md`: join your SSID, set **2400 8N1, transparent,
      TCP server :8899**. Easiest path: dashboard → Setup → Scan → **Auto-configure serial**.
- [ ] Give each a **DHCP reservation**; record its **MAC** into `~/bridge-data/config.yaml`.
- [ ] Move both gateways onto the **isolated segment** from Phase A.

## Phase C — Pi in place 🔧

- [ ] Mount the Pi; confirm it's on the network and the dashboard loads (LAN + Tailscale).
- [ ] In the dashboard **Setup** tab, Scan and assign each gateway to its pump (MAC-matched).
      Pumps still show OFFLINE until wired — expected.

## Phase D — Wire ONE pump, read-only 🔧 (Phase 1)

- [ ] Panel off. Wire pump 1: board BMS header (**CN22 — pending Winnie**) → JST pigtail →
      isolated repeater → run → W610 A/B. A→A, B→B.
- [ ] Leave `write_enabled: false`. Watch the dashboard: pump 1 goes online, live temps.
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
