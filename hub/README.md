# a2w-hub

Persistent Node/TypeScript relay between the **Pi bridge** (WebSocket, dials out)
and the **optimizer + Vercel dashboard** (HTTP). It buffers the latest pump state
the Pi pushes and forwards setpoint commands to the Pi, awaiting an ack.

Setpoint is the **only** relayed action by design. Power/mode/parameter changes
stay human-only on the direct LAN/Funnel path and are never relayed by the hub.

## Architecture

```
  Pi bridge  --(wss://<hub>/pi, dials OUT, Bearer HUB_PI_TOKEN)-->  a2w-hub
                                                                      |
  optimizer / Vercel dashboard  --(HTTPS, Bearer HUB_CLIENT_TOKEN)--> a2w-hub
```

- The Pi opens an outbound WebSocket to `/pi` and holds it (auto-reconnect with
  exponential backoff). **No inbound port is ever opened on the Pi.**
- The hub holds **at most one** Pi socket (a new connection replaces the old),
  buffers only the latest `state`, pings the Pi every ~30s and drops it on a
  missed pong.

## HTTP API

| Method | Path           | Auth                    | Purpose |
| ------ | -------------- | ----------------------- | ------- |
| GET    | `/health`      | open                    | `{ok, pi_connected, last_state_ts}` |
| GET    | `/api/state`   | Bearer `HUB_CLIENT_TOKEN` | latest state the Pi pushed |
| POST   | `/api/command` | Bearer `HUB_CLIENT_TOKEN` | relay a setpoint to the Pi, await ack |

`POST /api/command` body:

```json
{ "pump_id": "pump1", "value_c": 45, "lease_minutes": 30, "source": "optimizer" }
```

Responses:

- `200 {"ok":true,"setpoint_c":<number>}` — Pi acked ok
- `502 {"ok":false,"detail":"<string>"}` — Pi nacked (guardrail: clamp/rate-limit/floor/offline/write_enabled)
- `504` — ack timeout (10s)
- `503` — no Pi connected

A nack is a **normal** outcome (guardrails still apply on the Pi).

## Environment variables (set ON THE HUB)

| Var                | Purpose |
| ------------------ | ------- |
| `HUB_PI_TOKEN`     | Bearer token the Pi presents on its WS handshake. Wrong/absent → WS close `4401`. |
| `HUB_CLIENT_TOKEN` | Bearer token the optimizer + dashboard present on HTTP. |
| `PORT`             | HTTP + WS port. Railway injects this automatically; defaults to `8080`. |

Tokens are compared constant-time. Generate them with e.g. `openssl rand -hex 32`.

## Local development

```bash
npm install
HUB_PI_TOKEN=dev-pi HUB_CLIENT_TOKEN=dev-client PORT=8080 npm run build && npm start
# or typecheck only:
npm run typecheck
```

## Deploy to Railway

1. **New service from the `/hub` subdirectory.** In the Railway project, add a
   service pointing at this repo and set the **root directory** to `hub`
   (Settings → Root Directory = `hub`). `railway.toml` here builds with
   `npm install && npm run build` and starts with `npm start`.
2. **Set the two tokens** as service variables:
   - `HUB_PI_TOKEN` = a long random secret (share with the Pi)
   - `HUB_CLIENT_TOKEN` = a different long random secret (share with the optimizer + dashboard)
   - `PORT` is provided by Railway automatically — do not hardcode it.
3. **Generate a public domain** (Settings → Networking → Generate Domain). This
   gives you the public host, e.g. `a2w-hub-production.up.railway.app`.
   - HTTP base URL: `https://a2w-hub-production.up.railway.app`
   - Pi WS URL: `wss://a2w-hub-production.up.railway.app/pi`
4. Verify: `curl https://<host>/health` → `{"ok":true,"pi_connected":false,"last_state_ts":null}`.

> Public URL: fill in after generating the Railway domain, then paste it into the
> Pi config and the Vercel dashboard env below.

## Wiring the Pi

In the Pi bridge config, set the hub URL and token. The hub client is enabled
only when **both** `hub.url` and `hub.token` are configured:

```yaml
hub:
  url: wss://a2w-hub-production.up.railway.app/pi
  token: <HUB_PI_TOKEN>          # must match the hub's HUB_PI_TOKEN
```

The Pi dials out, reconnects with backoff, pushes a `state` every
`state_interval_s`, replies `pong` to `ping`, and on a `command` with
`action:"setpoint"` calls the existing guarded write path
(`poller.write_setpoint(value_c, source="hub:"+source, unattended=True, lease_minutes=lease_minutes)`),
then acks. It never bypasses a guardrail and never applies power/mode/parameter
changes. If the hub is down it keeps retrying — LAN + Funnel control are unaffected.

## Wiring the Vercel dashboard

Set env vars on the Vercel project:

```
A2W_HUB_URL=https://a2w-hub-production.up.railway.app
A2W_HUB_CLIENT_TOKEN=<HUB_CLIENT_TOKEN>   # must match the hub's HUB_CLIENT_TOKEN
```

The dashboard reads `GET /api/state` and posts setpoints to `POST /api/command`
with the `Authorization: Bearer <A2W_HUB_CLIENT_TOKEN>` header. The optimizer
uses the same base URL + client token.
