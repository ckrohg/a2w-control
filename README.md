# a2w-control

Control, monitoring and planning for one house's hydronic heating plant:

- **2× Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water heat pumps** — Modbus RTU over
  USR-W610 WiFi gateways (RTU framing over TCP, not Modbus TCP), read and written by the Pi bridge.
- **HBX ECO-0600** buffer-tank controller — read through `api.sensorlinx.co`; its reset curve is
  written by exactly one guarded code path in the planner.
- **SPAN panel** — circuit power for the heat pumps and the backup element via the panel's local
  API on the Pi, plus the cloud API from the planner; guarded breaker control for the pump circuits.

Personal infrastructure, not a product. Settled design and hardware decisions live in
`knowledge/reference/heatpump-bridge-handoff.md`; do not redesign them.

## Components

| Directory | Runs on | What it is |
|---|---|---|
| `heatpump-bridge/` | Raspberry Pi (systemd) | Python/FastAPI Modbus bridge: setpoint writes with guardrails, fault alerts, SQLite history, local UI. Dials OUT to the hub over WebSocket; pushes snapshots to the mirror; polls the SPAN local API. |
| `hub/` | Railway | Node/TypeScript relay between the Pi (WebSocket) and the planner/dashboard (HTTP). Buffers the latest Pi state, relays setpoint and breaker commands, awaits acks. |
| `planner/` | Railway | Node/TypeScript SensorLinx reader and planner: polls the HBX, versions config drift, runs the shadow/winter solvers, drives pump setpoints on leases (Phase B), and is the **sole writer** of the HBX curve. |
| `analytics-mirror/` | Vercel | Next.js read-only dashboard and time-series store. **Not in the control path** — it only receives pushes from the Pi and reads the hub/planner APIs. |

Shared state is a Railway Postgres (migrated off Neon 2026-08-23) used by the planner and the
mirror. Each component has its own README with API, env vars and deploy notes.

**Single-writer invariant.** The deployed Railway planner is the only thing allowed to PATCH the
HBX. Everything else that wants to move the target calls the planner's bearer-gated API. Read
`planner/README.md` §Single-writer invariant before touching anything that writes.

## Running the tests locally

```bash
cd heatpump-bridge && uv sync && uv run pytest -q     # bridge: pytest (unit + in-process sim)
cd hub && npm ci && npm test                          # hub: node:assert scripts under tsx
cd analytics-mirror && npm ci && npm test             # mirror: node:assert scripts under tsx
cd planner && npm ci && npm test                      # planner: node:assert scripts under tsx
```

The three Node suites share one shape: `npm test` loops over `*.test.ts` files and runs each with
`npx tsx`, failing on the first red file. CI (`.github/workflows/ci.yml`) runs the same four
commands plus `npm run build` for hub, planner and mirror. The planner's `npm test` resolves
`tsx` through `npx` (it is not a planner devDependency).

Planner-only local proofs that need a local Postgres (never production) are listed in
`planner/README.md` (the `scripts/*-local-check.ts` files and `scripts/rehearsal/`).

## Operational scripts (`scripts/`)

All of these are read-only against the live system unless stated. None can reach the Pi.

| Script | Purpose |
|---|---|
| `deploy-gate.sh` | Brackets every deploying merge with a health snapshot: refuses to merge from an unhealthy baseline, runs `gh pr merge`, waits for the Railway deploy, re-verifies. `status` / `merge <pr>` / `watch`. |
| `drift-check.sh` | Asserts DECLARED-vs-LIVE state against the planner and hub `/health` endpoints (leases, lagT, SPAN-local age, …). Exit 1 = drift. Also runs daily from `drift-check.yml`; acknowledged drift lives in `drift-ack.txt`. |
| `backup-db.sh` | Encrypted (gpg AES256) `pg_dump` of the live Railway Postgres; refuses a stale database. Run weekly by `db-backup.yml`, committed to the orphan `db-backups` branch. |
| `analyze-local.sh` | Restores the newest encrypted backup into a **local** Postgres so analysis never touches production. Use this instead of querying the live DB. |

Other scripts (`storm-watch.sh`, `storm-precharge.sh`, `identification-mode.sh`, `eval-*.sh`,
`*-local-check.ts`) are documented in their own `@purpose` headers.

## Deploy and release flow

- **planner, hub** — Railway services, git-linked: a push to `main` touching `planner/**` or
  `hub/**` redeploys that service. These control live heating, so merge deploying PRs **one at a
  time** through `scripts/deploy-gate.sh merge <pr>`. Docs, CI and `knowledge/` changes are inert.
- **analytics-mirror** — Vercel, rebuilds when `analytics-mirror/` changes.
- **heatpump-bridge (Pi)** — deploys **only from `release-*` tags**, never from `main`. The Pi's
  `heatpump-bridge-update.timer` checks every 15 min, pulls the newest tag that is ahead of the
  running commit, reinstalls, restarts, health-checks and rolls back on failure
  (`heatpump-bridge/deploy/pi-update.sh`). CI runs on `release-*` tag pushes as the gate.
  Cutting a tag is a deliberate human step: `git tag release-YYYYMMDD-N && git push --tags`.
  Never cut one on the owner's behalf.

The Pi's live config and SQLite DB are in `~/bridge-data` on the Pi, outside the repo; no merge,
tag or deploy changes them.

## Where to read next

- `CLAUDE.md` — working rules, current stage, open safety items. Trust `/health` and
  `scripts/drift-check.sh` over any doc.
- `knowledge/reference/` — the handoff spec, Modbus register map, HBX write API, incident
  write-ups, runbooks, eval reports and design notes.
- `knowledge/PRODUCT_SPEC.md`, `knowledge/ROADMAP.md` — working summaries.
- `specs/` and `eval/` — build specs and eval definitions for past waves.
