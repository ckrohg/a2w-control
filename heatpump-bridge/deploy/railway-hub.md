# Railway hub — remote control without a public port on the Pi

This is the **self-owned** remote-control path: a persistent Railway service (the "hub") that
the Pi dials OUT to over a WebSocket, and that the cloud optimizer + the Vercel dashboard talk
to over a small HTTP API. It replaces the Cloudflare-Tunnel plan in
`knowledge/reference/remote-api-architecture.md` with an equivalent posture that has **no
Cloudflare, no domain, and no Tailscale dependency** — you own both ends.

Tailscale Funnel remains the documented **fallback** (see
[§7](#7-fallback-tailscale-funnel-direct-to-pi) and `tailscale-notes.md`): direct-to-Pi human/LAN
control that coexists with the hub and takes over if the hub is down.

## 1. What it is (and why it's safe)

- **The Pi dials OUT.** The bridge opens a WebSocket to `wss://<hub-host>/pi` and holds it open
  (auto-reconnect, exponential backoff ~1s..30s). **No inbound port is ever opened on the Pi** —
  same "no listening endpoint at the house" security posture as the Cloudflare/relay designs,
  but the long-lived server is a container you redeploy, not the Pi.
- **The optimizer and the Vercel dashboard never touch the Pi directly.** They call the hub's
  HTTP API (`/api/state`, `/api/command`). The hub relays a `setpoint` command down the Pi's
  existing WebSocket and waits for the Pi's `ack`.
- **Setpoint-only, by design.** The ONLY action the hub relays is `setpoint`. Power, mode, and
  parameter changes stay **human-only** on the direct LAN / Funnel path — the hub can't express
  them and the Pi's hub client refuses to apply them.
- **The lease keeps stale commands safe.** A relayed setpoint still goes through the Pi's
  existing guarded write path with `unattended=True` and a `lease_minutes`. If the optimizer (or
  the hub, or the link) goes silent, the lease lapses and the Pi reverts to its warm
  `baseline_setpoint_c` on its own — the house is never stranded at a stale optimizer value. A
  nack (clamp / rate-limit / offline / floor / `write_enabled=false`) is a **normal** outcome,
  not an error: every guardrail that applies to a human tap applies here.
- **Best-effort / additive.** If the hub is down the Pi just keeps retrying; local LAN control
  and the optional Funnel path are completely unaffected.

## 2. Data flow

```
                    ┌──────────────────────── the house (Pi, no inbound port) ─────────────┐
                    │                                                                       │
                    │   heat pumps ⇄ Modbus ⇄  bridge (poller + guarded write path)         │
                    │                              │        ▲                               │
                    │                     hub_client dials  │ ack {ok, setpoint_c}          │
                    │                        OUT (wss)       │                              │
                    └──────────────────────────────┼────────┼───────────────────────────────┘
                                                    │        │
                          state (every ~15s) ───────▼        │  command {setpoint, lease}
                                            wss://<hub>/pi    │  (setpoint ONLY)
                                                    │        │
                    ┌───────────────── Railway (persistent hub, hub/) ──────────────────────┐
                    │   holds AT MOST ONE Pi WS · buffers latest state · pings every ~30s    │
                    │   correlates acks↔commands by command_id · 10s ack timeout            │
                    │        GET /health (open) · GET /api/state · POST /api/command         │
                    └───────────────▲──────────────────────────────────▲────────────────────┘
                                    │ Bearer HUB_CLIENT_TOKEN           │ Bearer HUB_CLIENT_TOKEN
                                    │                                   │
                   ┌────────────────┴─────────────┐        ┌────────────┴───────────────────┐
                   │  cloud optimizer              │        │  Vercel dashboard              │
                   │  reads /api/state,            │        │  reads /api/state, may         │
                   │  POSTs /api/command (lease)   │        │  POST /api/command             │
                   └───────────────────────────────┘        └────────────────────────────────┘

   FALLBACK (coexists, always available): phone/laptop ─ Tailscale Funnel / LAN ─▶ Pi's own /api
                                          human-only power/mode + full setpoint control
```

Two message directions on the Pi WebSocket:

- **Pi → hub:** `state` (on connect + every ~15s), `ack` (reply to a command, correlated by
  `command_id`), `pong`.
- **Hub → Pi:** `command` (`action:"setpoint"` only), `ping`.

The exact JSON contract is documented in `hub/README.md` — that is the source of truth for the
frame shapes; this runbook only covers deployment and wiring.

## 3. Generate the two tokens

The hub holds two independent secrets. Generate both up front:

```bash
openssl rand -hex 24     # → HUB_PI_TOKEN     (the Pi authenticates the WS with this)
openssl rand -hex 24     # → HUB_CLIENT_TOKEN (optimizer + Vercel authenticate HTTP with this)
```

Keep them distinct. The Pi never needs `HUB_CLIENT_TOKEN`; the optimizer/dashboard never need
`HUB_PI_TOKEN`. Both are compared constant-time on the hub.

## 4. Deploy the hub to Railway

The hub source lives in `hub/`. See `hub/README.md` for the build/run detail; the deploy is:

1. In Railway: **New Project → Deploy from GitHub repo**, import `a2w-control`, set the service
   **Root Directory** to `hub`.
2. **Set environment variables** (Service → Variables):
   - `HUB_PI_TOKEN` — the first token from §3.
   - `HUB_CLIENT_TOKEN` — the second token from §3.
   - `PORT` — Railway injects this; the hub must bind it. Nothing to set unless overriding.
3. **Deploy.** Railway gives you a public URL, e.g. `https://a2w-hub-production.up.railway.app`.
   The WebSocket endpoint is that host with `wss://` and the `/pi` path; the HTTP API is the same
   host over `https://`.
4. **Smoke-test the open health probe** (no auth):

   ```bash
   curl https://<hub-host>/health
   # → {"ok":true,"pi_connected":false,"last_state_ts":null}   (before the Pi connects)
   ```

## 5. Wire the Pi

The hub client is enabled **only when both `url` and `token` are set** — omit either and the
Pi ignores the hub entirely. The live config lives at `~/bridge-data/config.yaml`, OUTSIDE the
repo, so auto-updates never touch it. Two ways to wire it:

**Easiest — at bootstrap (recommended).** Pass the token (and optionally the URL) to
`pi-bootstrap.sh` and it writes the `hub:` block for you; the token stays out of the repo. The
URL defaults to the live production hub, so usually just:

```bash
A2W_HUB_TOKEN="<HUB_PI_TOKEN>" bash -c "$(curl -fsSL https://raw.githubusercontent.com/ckrohg/a2w-control/main/heatpump-bridge/deploy/pi-bootstrap.sh)"
# override the host if the hub ever moves:  A2W_HUB_URL="wss://<hub-host>/pi" A2W_HUB_TOKEN=… bash …
```

Re-running bootstrap with `A2W_HUB_TOKEN` is also how you add the hub to an already-provisioned
Pi — it patches the existing config in place.

**Manual — edit the config.** Add the block to `~/bridge-data/config.yaml` by hand:

```yaml
hub:
  url: "wss://<hub-host>/pi"        # the Railway host, wss:// scheme, /pi path
  token: "<HUB_PI_TOKEN>"           # the FIRST token from §3 (the PI token, not the client one)
  state_interval_s: 15              # how often the Pi pushes a state frame (default 15)
```

Either way, `sudo systemctl restart heatpump-bridge` (bootstrap does this for you). Within a
second or two the Pi dials out; re-run the health probe from §4 and it should flip to
`"pi_connected":true` with a recent `last_state_ts`.

The hub client uses the **existing guarded write path** for every command it receives — it does
not add a second write route. A relayed setpoint is exactly:

```
await poller.write_setpoint(value_c, source="hub:"+source, unattended=True, lease_minutes=...)
```

so `write_enabled`, the clamp, the rate limit, the unattended floor, and the lease all still
apply. Until you flip `write_enabled: true` on a pump (Phase 2), every relayed command nacks
with a clear detail — that is expected and safe.

## 6. Wire the Vercel dashboard (and the optimizer)

Both the dashboard and the optimizer are plain HTTP clients of the hub. Set two env vars on
each:

- **Vercel** (Project → Settings → Environment Variables):
  - `HUB_URL` — the hub's `https://` base, e.g. `https://<hub-host>`.
  - `HUB_CLIENT_TOKEN` — the SECOND token from §3.
- **Optimizer** (wherever it runs): the same `HUB_URL` + `HUB_CLIENT_TOKEN`.

Then they call:

```
GET  /health                      # open, no auth — liveness + pi_connected + last_state_ts
GET  /api/state                   # Bearer HUB_CLIENT_TOKEN — latest state the Pi pushed
POST /api/command                 # Bearer HUB_CLIENT_TOKEN — relay a setpoint
     body: {"pump_id":"pump1","value_c":45,"lease_minutes":90,"source":"optimizer"}
     → 200 {"ok":true,"setpoint_c":45}   on ack ok
     → 502 {"ok":false,"detail":...}     on nack (guardrail rejected — normal, act on detail)
     → 504                               ack timeout (10s — Pi got it but didn't reply in time)
     → 503                               no Pi connected
```

The optimizer MUST treat this as a **lease** and re-assert every ~15–20 min even when its math
says "hold" (same value, fresh `lease_minutes`). If it stops calling, the lease lapses and the
Pi reverts to `baseline_setpoint_c` on its own. This is the same lease contract as the
direct-API path in `api-integration.md` §5b — the hub just carries it. `502`/`504`/`503` are all
"the write didn't land"; never queue a command for replay, just re-read `/api/state` and decide
again on the next tick.

## 7. Fallback: Tailscale Funnel (direct to Pi)

The hub is **additive**. The bridge still serves its own local HTTP API on the LAN and,
optionally, over Tailscale Funnel — and both can run at the same time as the hub. Use the
direct path when:

- the hub is down (Railway outage / redeploy), or
- you want direct human control from a browser (the hub carries setpoint-only; the direct API
  carries the full human surface: power, mode, parameters), or
- you're on the house LAN and want the lowest-latency path.

Nothing about the hub disables the Funnel path, and nothing about the Funnel path disables the
hub — the Pi dials out to the hub regardless of whether Funnel is up. See `tailscale-notes.md`
for the Funnel setup and `api-integration.md` for the direct API. If you run both, the direct
API's own `auth.protect` / token config gates the Funnel URL independently of the hub tokens.

Precedence at the pump is by lease/authority, not by transport: a human setpoint from the direct
UI is attended and takes effect immediately; an optimizer lease via the hub reverts to baseline
on silence. The two never fight for a port because they share the one guarded write path inside
the bridge.

## 8. Related docs

- `hub/README.md` — the hub service itself: the exact WS/HTTP JSON contract, build, and run.
- `analytics-mirror/README.md` — the **read-only** Vercel history mirror (a separate outbound
  push; NOT the control path). The dashboard may use both: the mirror for history, the hub for
  live state + control.
- `api-integration.md` — the Pi's direct API (the fallback path and the lease contract).
- `tailscale-notes.md` — the Funnel fallback transport.
- `knowledge/reference/remote-api-architecture.md` — the architecture decision this variant
  implements.
