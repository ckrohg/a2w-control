# A2W Analytics Mirror (Vercel)

A **read-only** cloud dashboard for A2W Control. The Raspberry Pi bridge pushes a state
snapshot here every ~60s; this stores the time series in Vercel Postgres and renders a
hosted dashboard (history charts + status).

**This is NOT in the control path.** It only receives outbound pushes from the Pi and never
sends anything back — setpoint control stays on the Pi's own API (reached via Tailscale
Funnel). If this app or its database is down, control and the local dashboard are unaffected;
you just lose the hosted history view. That separation is deliberate (fusion architecture
audit): the value-critical path is direct-to-Pi; this is a convenience mirror on your free
Vercel plan.

## Deploy (one-time, ~10 min)

1. **Push this repo to GitHub** (already done if it's part of `a2w-control`).
2. In Vercel: **New Project** → import the repo → set **Root Directory** to
   `analytics-mirror`. Framework auto-detects as Next.js.
3. **Add storage:** project → Storage → create a **Postgres** database (Neon; free tier).
   Vercel injects `POSTGRES_URL` (and friends) automatically — nothing to copy.
4. **Set Environment Variables** (Project → Settings → Environment Variables), from
   `.env.example`:
   - `INGEST_TOKEN` — a long random string (`openssl rand -hex 24`).
   - `VIEW_PASSWORD` — your dashboard login password.
   - `VIEW_SESSION_SECRET` — a *different* long random string.
5. **Deploy.** You get `https://<project>.vercel.app`.

## Wire the Pi

In `~/bridge-data/config.yaml` on the Pi:

```yaml
analytics:
  endpoint_url: "https://<project>.vercel.app/api/ingest"
  token: "<the same INGEST_TOKEN>"
  interval_s: 60
```
`sudo systemctl restart heatpump-bridge`. Snapshots appear within a minute; open the site,
log in with `VIEW_PASSWORD`.

## What it stores

One row per pump per push: timestamp, online/state/mode, setpoint, inlet/outlet/outdoor
temps, total power, active-fault count, comm error rate. 90-day retention (free-tier
friendly). No control-relevant secrets ever leave the Pi.

## Cost

Free: Vercel Hobby + the Vercel Postgres (Neon) free tier are plenty for one home at a
1-per-minute write rate.
