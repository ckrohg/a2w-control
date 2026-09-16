<!--
@purpose Ground-truth snapshot of the LIVE A2W system, captured 2026-09-16 from the running
services — not from any doc. Everything downstream (CLAUDE.md, ROADMAP, the drift checker)
must assert only what is recorded here. Captured because CLAUDE.md (2026-07-07) and
ROADMAP.md (2026-07-14) had both drifted ~2 months behind the running system.
Env var NAMES only — no values were read into any transcript except HUB_CLIENT_TOKEN, which
was piped directly into a curl header and never printed.
-->

# Live state — 2026-09-16 (W2-C ground truth)

## Services

| Surface | URL | State |
|---|---|---|
| planner | `a2w-planner-production.up.railway.app` | ok, 0 consecutive failures, writer lease held |
| hub | `a2w-hub-production.up.railway.app` | ok, `pi_connected: true` |
| mirror | `a2w-analytics-mirror.vercel.app` | deployed (Vercel cron `/api/digest` Mon 12:00) |
| Railway project | `a2w-hub` / production | services `a2w-planner`, `a2w-hub` |
| DB | Railway Postgres | migrated off Neon 2026-08-23 (#79) |

## Pumps (hub `/api/state`)

Both pumps: `online: true`, `setpoint_c: 52`, `write_enabled: true`.
Error rates: pump1 0.0257, pump2 0.0320.
**`remote_lease_until: null` on both** — see FINDING-1.

## Planner subsystems (`/health`)

- `phase_b`: **active**, both pumps, reports `ok 52°C (lease 90m)`
- `winter_solver`: shadow, healthy, 18 zones
- `winter_dp`: `applied: false`, dp 14.25 kWh vs floor 14.31 kWh, `cop_anchored: true`
- `demand_forecast`: `mode: idle`, `fetch_enabled: false`, `preheat_enabled: false`
- `tempiq_push` / `tempiq_read`: both enabled and succeeding (18 zones, 38 spatial edges)
- `storm`: idle, enabled · `hygiene`: auto-sanitize on, 60h effective interval, not blind

## Deploy topology (verified)

- **Pi**: `release-*` tags ONLY, forward-only (`pi-update.sh`, `TAG_GLOB`, guard at line 58).
  Commits to `main` CANNOT reach the hardware.
- **Railway (planner + hub)**: GitHub-connected, **no `watchPatterns`** → every push to `main`
  redeploys, including docs-only commits. CI's `paths-ignore` does NOT apply to Railway.
- **CI**: skips `knowledge/**`, `.tenet/**`, `**.md`.

## Env vars present on the planner (names only)

`FORECAST_FETCH_ENABLED` and `FORECAST_PREHEAT_ENABLED` are **absent** → both default false,
consistent with `/health`. The winter-DP shadow sequence has not been started.

---

## FINDING-1 (HIGH) — the revert-to-baseline failsafe is NOT armed in production

**Claim in the docs** (`railway-hub.md:28`, `api-integration.md:121`, `planner/README.md:158`,
`phaseb.ts:8`, `tempiq-integration-sketch.md:51`): if the planner dies, the setpoint lease
lapses and the Pi reverts to a warm `baseline_setpoint_c` (48 °C) on its own.

**Measured**: `remote_lease_until: null` on both pumps while Phase B is actively writing.

**Mechanism** — no innocent explanation survives:
- `poller.py:195` — `remote_lease_until` is a direct read of `self._lease`; null ⇒ no lease held.
- `phaseb.ts:121` + `hub.ts:57` — the planner IS sending `lease_minutes: 90` on every write.
- `poller.py:600` — `if lease_minutes and g.baseline_setpoint_c is not None:` — with
  `lease_minutes` truthy, the only way `self._lease` stays None is `baseline_setpoint_c is None`.
- `config.py:65` — `baseline_setpoint_c` defaults to `None`, "dormant until set".
- `config.production.yaml:60` — the line is **commented out** in the template.

**Therefore**: `baseline_setpoint_c` is unset on the live Pi. `check_lease()` (`poller.py:762`)
returns early every tick. The revert, the "⚠ optimizer stale — reverted to baseline" alert, and
the 15-minute `lease_warn_minutes` warning **can never fire**.

**Actual exposure** (stated soberly): this is NOT an imminent freeze hazard. If the planner dies
now, both pumps hold 52 °C — a warm value — and the house keeps heating. The real exposure is
(a) no automatic recovery from a stale optimizer value, (b) a dead planner is silent on this
alert channel, and (c) if Phase B's last write before dying were at its 45 °C floor during a
cold snap, the house is stranded low with nothing to correct it. Severity rises sharply in winter.

**FINDING-1b (false assurance)**: `phaseb.ts:123` renders `ok 52°C (lease 90m)` from its own
`LEASE_MINUTES` constant regardless of whether the Pi armed anything. `/health` therefore
reports a lease that does not exist — the same class as fusion-audit Risk 3b ("stale data shown
as live"). The planner should report the Pi's actual `remote_lease_until`.

**Fix split**: arming `baseline_setpoint_c` is a Pi-side config change (owner's value judgement,
48 °C was the documented intent) and is explicitly OUT of scope for any agent — it needs a
`release-*` tag or a Pi-side edit. Making it *observable* (FINDING-1b + a drift assertion) is
in scope and safe.

## FINDING-2 (MEDIUM) — #78's obvious fix is the dangerous one

`deploy/config.production.yaml` is a **template for a fresh Pi**, not a mirror of runtime.
Reconciling it to `write_enabled: true` (the naive reading of #78) would arm writes on any new
Pi *before* the isolation-verification and HBX-override commissioning gates ran on that
hardware — the gate the fusion audit deliberately made a recorded human step. Correct fix:
keep `write_enabled: false`, correct only the dead legacy IPs, and add a header stating the
file is a template, not runtime truth.
