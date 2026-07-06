# Tailscale — remote access (recommended default)

Free, no domain, 10 minutes. Gives you the dashboard from anywhere and (optionally) a
public HTTPS URL for a machine consumer like TempIQ. This is the primary remote-access
path; `cloudflared-notes.md` is the alternative if you want a branded URL + email-OTP.

## Your phone/laptop → the dashboard (private mesh)

On the Pi:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # opens a login URL; authenticate once
```
Install the Tailscale app on your phone/laptop, sign in with the same account. The Pi now
has a stable `100.x.y.z` address (and a name like `heatpump-pi`) that works from any
network. Open `http://heatpump-pi:8000` from your phone, anywhere. The Pi's LAN IP can
change freely — Tailscale doesn't care.

Bonus: this also solves the "what's the Pi's IP" problem for good — the tailnet name is
stable regardless of DHCP.

## TempIQ (or any cloud service) → the API

Two options:

**A. Tailscale Funnel — public HTTPS URL, free, no domain.**
```bash
sudo tailscale funnel 8000     # exposes https://heatpump-pi.<tailnet>.ts.net publicly
```
Then set the bridge to `auth.protect: writes` with a token (see `api-integration.md`) so
the public URL is gated at the application layer. TempIQ calls
`https://heatpump-pi.<tailnet>.ts.net/api/...` with its bearer token.

**B. Private — TempIQ's container joins the tailnet.**
Railway/containers can run Tailscale with an ephemeral auth key; TempIQ then reaches the
Pi's `100.x` address directly, no public exposure. More setup, maximally private. Still set
a bridge token so TempIQ is identified in the audit log.

## Locking the service to the tunnel

Once Tailscale is the access path, bind uvicorn to the tailnet + localhost only (drop
`0.0.0.0`) if you don't want the LAN-open dashboard:
- keep `--host 0.0.0.0` to also allow same-house LAN browsers (simplest), or
- use `--host 100.x.y.z` to require Tailscale even at home.

Leave `auth.protect: writes` on whenever the API is reachable off-LAN, so control always
needs a token even if the tunnel is misconfigured.
