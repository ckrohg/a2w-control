# Cloudflare Tunnel + Access — remote UI

> Alternative to Tailscale (`tailscale-notes.md`). Choose this if you want a branded URL
> and email-OTP for humans. For machine access (TempIQ), see `api-integration.md` — put
> Cloudflare Access on `/` for humans and leave `/api` public, gated by a bridge token.

Goal: `https://heat.<your-domain>` → Pi's localhost:8000, with email-OTP auth in front.
No open router ports, no custom human auth (handoff §6.1 — settled).

## Prereqs

- A domain on Cloudflare (free plan is fine)
- Zero Trust dashboard access (free tier ≤ 50 users)

## Tunnel (on the Pi)

```bash
# install cloudflared (arm64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o cloudflared && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/

cloudflared tunnel login                       # browser auth on another machine
cloudflared tunnel create heatpump
cloudflared tunnel route dns heatpump heat.<your-domain>
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: heatpump
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: heat.<your-domain>
    service: http://localhost:8000
  - service: http_status:404
```

```bash
sudo cloudflared service install               # systemd unit, starts on boot
```

## Access policy (Zero Trust dashboard)

1. Zero Trust → Access → Applications → Add self-hosted app
2. Domain: `heat.<your-domain>`
3. Policy: Allow → Include → Emails → the owner's email(s)
4. Auth method: One-time PIN (email OTP) — no identity provider setup needed
5. Session duration: 1 week is a sane phone-friendly default

## Verify

- Incognito browser → `https://heat.<your-domain>` → OTP challenge → UI loads
- `curl https://heat.<your-domain>/api/health` unauthenticated → Access block page (not JSON)
