# Remote-API architecture decision (fusion audit, 2026-07-06)

> Multi-model fusion panel (Opus/Sonnet/GPT-5.5, cross-vendor judged), **CONVERGENT** —
> high confidence. The question: now that remote API access becomes VALUE-CRITICAL (a cloud
> optimizer adjusting setpoints for savings), what's the right long-term architecture?

## Decision: direct tunnel to the Pi's API — **Cloudflare Tunnel + Cloudflare Access** — with the optimizer as a stateless caller holding a renewable setpoint **lease**.

Reject the cloud relay and the hybrid.

**Driving principle:** keep everything stateful/long-lived OFF the side that redeploys or
whose correctness you'd own for years.
- **Relay rejected:** a Supabase commands-table is a replay queue you'd own forever (TTL,
  idempotency, clock-skew) on the exact path that moves the home's heat — re-introduces the
  late-fire risk the guardrails forbid.
- **Tailscale-for-the-machine-path rejected:** the Railway container would need a tailscaled
  client / node key that redeploys every push with keys that expire ≤90 days and lapse
  silently — rot on the most volatile side.
- **Cloudflare Tunnel chosen:** one `cloudflared` systemd daemon on the Pi (never redeploys,
  auto-reconnects, survives IP changes, outbound-only QUIC — no port-forward); the optimizer
  is a plain `fetch()` with two headers. Cloudflare Access enforces auth at the edge (email
  OTP on `/` for humans, a service token on `/api` for the optimizer, bearer token
  underneath) — gives the relay's "no inbound endpoint" security posture without the queue.
- **Self-hosted WireGuard/VPS rejected:** makes the homeowner run a public Linux box for
  years — adds the fragile infra the owner refuses, to buy control not needed here.

**Honest cost:** single-vendor (Cloudflare) dependency — acceptable ONLY because a value-path
outage is safe by design (savings pause; house stays warm on the on-Pi baseline). Transport
stays fully decoupled from the app, so Tailscale is a drop-in fallback if needed.

## Biggest weakness of each candidate (unattended, years, one homeowner)
- **Direct tunnel (Cloudflare):** silent daemon/edge death, no store-and-forward — while down,
  zero setpoints land, and `cloudflared` can hang while the Pi looks healthy. Mitigate with an
  external reachability ping against the tunnel.
- **Cloud relay:** the bespoke command-queue mis-fires (stale/dup/late setpoint) — the one bug
  class that maps straight onto the home's heat.
- **Hybrid:** two systems to keep alive; read/write split-brain (dashboard says "updated" while
  the write path is silently down).

## Sequencing
- **Build NOW (done 2026-07-06):** the setpoint **lease** + on-Pi baseline reversion + `/status`
  lease fields. Pure on-Pi logic, sim-testable, and it MUST exist before the write path is ever
  remotely reachable (else a dead optimizer strands the house). Transport stays decoupled.
- **Defer to platform phase:** `cloudflared` + DNS + Access wiring (a reversible day of work);
  the optimizer itself (start read-only, then setpoint-only writes); any Supabase/hosted
  dashboard (add later as a pure outbound state-push — structure SQLite so a snapshot-exporter
  is a clean add-on; wire nothing now).
- **Corner not to paint into:** never let the optimizer hold authority without a lease.

## Degradation (built): the authority stack
1. Live, unexpired optimizer lease (within the winter-safe band).
2. On-Pi **baseline** (`baseline_setpoint_c`, a warm winter default; future: outdoor-reset
   curve floored at the min-safe setpoint) — applied when the lease lapses.
3. Untouched manual wall-controller + HBX chain (the real safety net if the whole Pi dies).

Two-stage anti-flap: warn at `lease_warn_minutes` before expiry (independent ntfy), revert at
expiry via the normal guarded write path, alert on revert AND recovery. Lease is in-memory so
a reboot discards a stale override rather than trusting it against an unsynced clock. This
catches optimizer-death-while-the-Pi-is-alive — the gap the dead-man heartbeat can't see.
