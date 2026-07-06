# Tailscale — remote access (recommended default)

Free, no domain, ~10 minutes. Two flavors; pick by whether you want a public URL.

## Quickest: Funnel (public URL, no app for viewers)

```bash
# 1. set auth.protect: all + ui_password in ~/bridge-data/config.yaml, restart the service
# 2. then:
bash ~/a2w-control/heatpump-bridge/deploy/setup-remote.sh
```
That scripts the whole thing: installs Tailscale, joins your tailnet (one login link),
and exposes `https://heatpump-pi.<tailnet>.ts.net` publicly over HTTPS. You open that URL
from any browser on any network — no app — and the bridge's login gates it. The rest of
this doc is the manual/private alternatives.

---

Gives you the dashboard from anywhere and (optionally) a public HTTPS URL for a machine
consumer like TempIQ. `cloudflared-notes.md` is the alternative if you want a branded URL.

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
