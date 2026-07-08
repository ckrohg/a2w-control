# A2W Control — API integration guide

For a machine consumer (e.g. **TempIQ**) that reads pump state and/or adjusts setpoints.
The bridge is a plain JSON REST API; this is everything needed to drive it remotely.

## 1. Reachability

The bridge runs on the Pi inside the house. A cloud caller (TempIQ on Railway) reaches it
one of three ways — pick per your tunnel (see `cloudflared-notes.md` / `tailscale-notes.md`):

- **Cloudflare Tunnel, public API path**: `https://heat.<domain>/api/...` (put Cloudflare
  Access in front of `/` for the human UI, leave `/api` public, gate it with the bridge
  token below).
- **Tailscale Funnel**: `https://heatpump-pi.<tailnet>.ts.net/api/...` (free public HTTPS,
  bridge token is the gate).
- **Tailscale private**: TempIQ's container joins the tailnet, calls the Pi's `100.x` address.

## 2. Authentication

Mint a token and add it to `~/bridge-data/config.yaml`:

```yaml
auth:
  protect: writes        # require a credential for control; reads stay open
  ui_password: "a-long-passphrase"   # YOUR browser login (once per device, 30-day session)
  tokens:
    - token: "<openssl rand -hex 24>"
      source: tempiq      # appears in the audit log for every write this token makes
      can_write: true     # false = read-only (observe & recommend); true = full control
```

`ui_password` is for the human browser; `tokens` are for machines. Under `protect`, loading
the dashboard no longer grants control for free — you (browser) log in once with the
password, TempIQ (machine) presents its bearer token. Neither can act without its credential.

`sudo systemctl restart heatpump-bridge`. Send the token as a bearer header:

```
Authorization: Bearer <token>
```

Verify it: `GET /api/whoami` →
```json
{ "authenticated": true, "source": "tempiq", "can_write": true }
```

**The token's `source` is the audit identity** — it cannot be spoofed via the request body,
so every change TempIQ makes is attributable in the event log and history.

## 3. Endpoints

Reads (open unless `protect: all`):
```
GET  /api/pumps                        list + health of every pump
GET  /api/pumps/{id}/status            full snapshot: temps, mode, setpoint bounds,
                                       power, running/defrost, per-stage detail, faults
GET  /api/pumps/{id}/history?hours=24  time-series samples (max 2160h)
GET  /api/pumps/{id}/events?days=7     faults, writes, runtime transitions, heat calls
GET  /api/health                       always open; reports auth_mode
GET  /api/whoami                       always open; reports your token's identity/scope
```

Writes for a machine token are **setpoint-only** by default (cold-latch safety —
`restrict_unattended_writes`). Power, mode, and parameter changes are human-only (403 for
tokens); express a "setback" as a lower setpoint, never an off.
```
POST /api/pumps/{id}/setpoint  {"value": 45}   whole °C only; mode-aware target  ← token OK
POST /api/pumps/{id}/mode      ...             403 for tokens (human UI only)
POST /api/pumps/{id}/power     ...             403 for tokens (human UI only)
POST /api/pumps/{id}/parameter ...             403 for tokens (human UI only)
```

Interactive schema: `GET /docs` (OpenAPI).

## 4. What TempIQ MUST handle (the guardrails are non-negotiable)

Every write passes through the same guardrails as a human tap. A `can_write` token is
necessary but never sufficient — expect and handle these responses:

| Status | Meaning | TempIQ should |
|---|---|---|
| 200 | accepted + read-back verified | trust the returned value |
| 422 | out of allowed bounds (mode-aware clamp / non-integer / unit reg 2027) | clamp its own request; don't retry unchanged |
| 429 | rate limited (min 60 s between writes per pump) | back off; this protects the pump's EEPROM |
| 409 | mode mismatch (e.g. writing a heating value while unit is cooling) or W610 identity mismatch | re-read `/status`, reconcile |
| 503 | pump offline | do not queue for replay; re-read later |
| 403 | your token is read-only | — |
| 401 | missing/invalid token | fix credentials |

Read `setpoint_bounds_c` from `/status` before writing — it already reflects the live
mode and the unit's own max-water-temp limit, so a well-behaved caller never hits 422.

## 5. Example (Node / TypeScript — TempIQ's stack)

```ts
const BASE = "https://heat.example.com/api";
const H = { "Authorization": `Bearer ${process.env.A2W_TOKEN}`,
            "Content-Type": "application/json" };

const status = await (await fetch(`${BASE}/pumps/pump1/status`, { headers: H })).json();
const [lo, hi] = status.setpoint_bounds_c;                 // respect the live clamp
const target = Math.min(Math.max(desiredC, lo), hi);

const res = await fetch(`${BASE}/pumps/pump1/setpoint`, {
  method: "POST", headers: H, body: JSON.stringify({ value: Math.round(target) }),
});
if (res.status === 429) { /* back off 60s */ }
else if (!res.ok) { /* log res.status + (await res.json()).detail */ }
```

## 5b. Setpoint LEASES (required for a continuous optimizer)

A remote optimizer must send each setpoint as a **renewable lease**, not a permanent value:

```
POST /api/pumps/pump1/setpoint  {"value": 45, "lease_minutes": 90}
```

Then **re-assert every ~15–20 min even when your math says "hold"** (same value, fresh
lease). If the bridge stops hearing from you (Railway redeploy, tunnel blip, optimizer
crash), the lease lapses and the Pi reverts to its warm `baseline_setpoint_c` on its own —
the house is never stranded at a stale, possibly-low, optimizer value. The Pi validates the
lease against its own clock, so a late/retried command can't fire after its window
(idempotency for free). `/status` reports `remote_lease_until` / `remote_lease_source` so
you can confirm your writes are actually holding authority.

Design your optimizer around this: it's a *stateless caller holding a lease*, and the Pi
owns "what's still valid" — which is why no cloud command-queue is needed.

**Renewals are free.** If the value you send already matches the pump's current setpoint, the
bridge refreshes the lease **without** touching the register (no Modbus write, no EEPROM wear,
no rate-limit slot consumed, no audit-log entry) — the response includes `"unchanged": true`.
So re-asserting every ~15 min to hold your lease costs nothing; only a real change writes.

## 6. Integration posture

Recommended first step: a **read-only token** (`can_write: false`). Let TempIQ *observe*
and log what it *would* set, verify the logic against real data for a few weeks, then flip
to `can_write: true`. This matches the roadmap's "TempIQ feeds signals / A2W decides" →
"TempIQ sets targets" progression, and the token scope encodes exactly which stage you're in.
