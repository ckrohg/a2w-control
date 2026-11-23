# A2W Analytics Mirror (Vercel)

The hosted dashboard for A2W Control. The Raspberry Pi bridge pushes a state snapshot here
every ~60s; this stores the time series in **Railway Postgres** (the same database the
planner uses) and renders history charts, status, the control page and the optimizer page.

## Where it sits in the control path

The **telemetry path is non-critical**, but the two things that can fail here are not alike:

- **This Vercel app is down.** The Pi's pushes to `/api/ingest` fail and the bridge keeps the
  last backup-arm value it stored; the Pi, the hub and the planner keep running. You lose the
  hosted view and the dashboard's buttons, and nothing else.
- **The Railway Postgres is down.** That is not a mirror-only outage: the planner stores every
  poll in the same database (`DATABASE_URL`, required) and its single-writer lease
  (`hbx_writer_lease`) lives there. The planner process stays up — at boot it retries the schema
  check forever instead of crashing, the lesson of the 2026-08-19 outage recorded in
  `planner/src/store.ts` — but each poll fails at the reading insert, before Phase B, the
  auto-pilot and the backup-element gate run (`planner/src/index.ts`, `pollOnce`). So the planner
  stops optimizing, `/health` turns 503 and it pages "SensorLinx reader offline" after 5 failed
  polls (that alert fires for any poll failure, the reader is not the cause). With
  `WRITER_LEASE_ENABLED=1` the fresh-lease check that precedes every device write fails too, so
  boost/target/restore requests die before they reach the HBX. The pumps lapse to the Pi's
  `baseline_setpoint_c` when their 90-minute leases expire and the HBX keeps heating on its own
  curve; the Pi's guardrails and the hub are untouched. Here, history pages and ingest fail while
  the session cookie (not database-backed) and the hub proxies keep working. See
  `planner/README.md` (§Single-writer invariant, §Phase B).

Nothing here writes on its own schedule — the only cron is the weekly digest email. Every control
request a person can make starts from a logged-in session; the one automatic feedback is the
ingest echo described below.

Two things do flow back, and an operator should know about both:

- **The dashboard pages (chiefly `/control` and `/optimize`) proxy the hub and planner APIs.**
  Server routes under `app/api/hub/*` and `app/api/planner/*` forward requests to the Railway
  hub (`HUB_URL`) and planner (`PLANNER_URL`) with server-held bearer tokens; the browser never
  sees a token. Every proxy route requires the **view session cookie**. The two double-gated
  hub actions (write-enable arm/disarm and SPAN breaker actions) additionally require the
  short-lived **arm cookie**, issued by `POST /api/hub/arm` only after a fresh password
  re-entry (5 minutes), and are sent with the separate `HUB_ARM_TOKEN`. A setpoint relayed
  through the hub lands on the Pi's guarded write path (clamp, rate limit, floor,
  write-enable); see `hub/README.md` for what the hub relays. The planner routes (boost,
  target, restore, storm, autonomy, sanitize, identification) are the planner's own API: it
  authorizes and applies them itself under its own rules (see `planner/README.md`); the Pi's
  guardrails cover only what reaches the Pi.
- **Ingest echoes the owner's backup-arm intent.** The reply to each Pi push carries
  `span_arm_desired` — the arm/disarm toggle for the SPAN backup element ("Buffer Tank"), set
  with `POST /api/span-arm` (view session cookie only, no arm cookie). The bridge
  (`heatpump-bridge/bridge/exporter.py`) writes it to `span-arm.json` whenever the echoed
  boolean differs from the file, so the dashboard's value replaces a value set on the Pi at the
  next successful push; `null` (never set) changes nothing, and with the mirror unreachable the
  bridge keeps the last value. It is not a setpoint or power command, but it is not harmless
  in either direction:
  - `true` (ARMED) makes the bridge close the element's relay when it finds it open — only
    with `span.arm_live` on; the default is shadow, which logs `would_arm` and switches
    nothing. That path never opens a relay.
  - `false` (not ARMED) removes one of the guards on switching the element **off**. With
    `span.backup_reopen` on (default off), the bridge allows an OPEN of the backup element
    while it is idle and the intent is not ARMED
    (`heatpump-bridge/bridge/span_control.py`, `_backup_open_refusal`). So a wrong `false`
    can let the failsafe be made unavailable; with `span.backup_reopen` off the element stays
    close-only whatever the intent says.

## Deploy (one-time, ~10 min)

1. **Push this repo to GitHub** (already done if it's part of `a2w-control`).
2. In Vercel: **New Project** → import the repo → set **Root Directory** to
   `analytics-mirror`. Framework auto-detects as Next.js.
3. **Point it at Railway Postgres.** Set `A2W_DATABASE_URL` to the Railway Postgres TCP-proxy
   URL (Railway → a2w-hub project → Postgres → Variables → build it from
   `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT` and the database credentials listed
   there). `lib/sql.ts` uses `A2W_DATABASE_URL` first and deliberately so: the dashboard must
   not depend on variables a marketplace integration can delete. The legacy Neon integration
   variables (`DATABASE_URL`, `POSTGRES_URL`) remain as fallbacks for local dev only.
4. **Set the remaining Environment Variables** (Project → Settings → Environment Variables)
   from `.env.example`, using the table below. The minimum for a read-only history view is
   `INGEST_TOKEN`, `VIEW_PASSWORD`, `VIEW_SESSION_SECRET` and `A2W_DATABASE_URL`; each
   further feature switches on when its group is filled in.
5. **Deploy.** You get `https://<project>.vercel.app`. If you use a custom or preview domain,
   set `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` to match or passkeys will not verify.

## Environment variables

All of these are read on the server (none is `NEXT_PUBLIC_*`, so none reaches the browser
bundle). Rows marked **secret** must stay that way — never rename one to `NEXT_PUBLIC_*`.

| Group | Var | Required for | Purpose |
| ----- | --- | ------------ | ------- |
| Ingest & storage | `INGEST_TOKEN` | ingest | **secret.** Bearer the Pi sends to `/api/ingest`; must equal `analytics.token` in the Pi's `config.yaml`. |
| Ingest & storage | `A2W_DATABASE_URL` | everything | **secret.** Railway Postgres TCP-proxy URL. Read first by `lib/sql.ts`. |
| Ingest & storage | `DATABASE_URL`, `POSTGRES_URL` | — | Fallbacks only (legacy marketplace integration / local dev). Do not rely on them in prod. |
| Login / passkey | `VIEW_PASSWORD` | login, arm | **secret.** Dashboard password; re-entered to obtain the 5-minute arm cookie. |
| Login / passkey | `VIEW_SESSION_SECRET` | login, arm | **secret.** The value of the session cookie itself (a different random string from the password); together with `VIEW_PASSWORD` it keys the arm cookie's signature. |
| Login / passkey | `WEBAUTHN_RP_ID` | passkeys | Relying-party ID = the host you serve on (default `a2w-analytics-mirror.vercel.app`). |
| Login / passkey | `WEBAUTHN_ORIGIN` | passkeys | Full origin for WebAuthn verification (default `https://<WEBAUTHN_RP_ID>`). |
| Hub control | `HUB_URL` | `/control`, digest Pi tile | Base URL of the Railway hub, no trailing slash. |
| Hub control | `HUB_CLIENT_TOKEN` | `/control` | **secret.** Must equal the hub's `HUB_CLIENT_TOKEN`; sent as the bearer on `/api/hub/*` proxies. |
| Hub control | `HUB_ARM_TOKEN` | write-enable, breaker | **secret.** Must equal the hub's `HUB_ARM_TOKEN`; sent as `X-Arm-Token` only when a valid arm cookie is present. Unset = those two actions return 503. |
| Planner | `PLANNER_URL` | `/optimize`, storm banner, savings, digest Pi tile | Base URL of the Railway planner, no trailing slash. |
| Planner | `PLANNER_API_TOKEN` | `/optimize`, storm banner, savings | **secret.** Bearer for the planner's authenticated `/api/*` routes; used by the `/api/planner/*` proxies and server components. The planner's `/health` is open, but the mirror's readers send this token there too and answer "planner not configured" without it (the digest reads `/health` with no token). |
| Weekly digest | `CRON_SECRET` | digest cron | **secret.** Vercel's cron sends it as the bearer to `/api/digest` (Mondays 12:00 UTC per `vercel.json`), which makes the route send; also accepted as `?key=`. Without it the cron's call gets 401; a logged-in browser still gets the preview, and sends with `?send=1`. |
| Weekly digest | `RESEND_API_KEY` | digest send | **secret.** Resend API key. Missing → the route answers `skipped`, never errors. |
| Weekly digest | `DIGEST_TO` | digest send | Recipient address. Missing → `skipped`, as above. |
| Weekly digest | `DIGEST_FROM` | — | Sender (default `A2W Control <onboarding@resend.dev>`; a verified domain is needed for anything else). |
| Weekly digest | `DIGEST_RATE_USD_KWH` | — | $/kWh used for the digest's backup-element cost line (default `0.31`). |
| Display | `DISPLAY_TZ` | — | IANA zone for server-rendered timestamps (default `America/New_York`). |
| Display | `ELECTRIC_RATE_USD_KWH` | — | $/kWh for the Savings and Optimize pages (default `0.30`). |
| Display | `DAILY_KWH_BASELINE` | — | Baseline daily kWh for the savings estimate (default `11.8`). |

## Wire the Pi

In `~/bridge-data/config.yaml` on the Pi:

```yaml
analytics:
  endpoint_url: "https://<project>.vercel.app/api/ingest"
  token: "<the same INGEST_TOKEN>"
  interval_s: 60
```
`sudo systemctl restart heatpump-bridge`. Snapshots appear within a minute; open the site,
log in with `VIEW_PASSWORD` (or register a passkey once logged in).

## What it stores

One row per pump per push: timestamp, online/state/mode, setpoint, inlet/outlet/outdoor
temps, total power, active-fault count, comm error rate — plus the event, SPAN circuit,
backup-arm and system tables the later pages read. 90-day retention on the readings, SPAN
circuit, backup-arm event and system tables (pruned on ingest). No control-relevant secrets
ever leave the Pi.

## Cost

Vercel Hobby is free at a 1-per-minute write rate. The database is the Railway Postgres
service shared with the planner, billed by container time with no compute-hour cliff (the
reason it moved off the previous free-tier provider — see the header of `lib/sql.ts`).
