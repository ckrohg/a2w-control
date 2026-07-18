# Dependency graph — W2 wave (autonomy control + savings clarity + activity log + durable retention)

> **Build status (2026-07-18, worktree `feat/w2-autonomy-savings-activity`):** A, B, C, D, E all
> BUILT + green (`tsc --noEmit` + `next build` + planner `tsc` + existing planner test pass).
> **Nothing deployed.** W2-A is the only node that touches live control — its go-live to Railway is
> gated on owner approval (see the arm-couples-Phase-B checkpoint in Safety rails). F, G not started
> (owner-gated fast-follow). Deploy order when approved: A (planner) → then B/C/D/E (dashboard+infra).

Owner review 2026-07-18 (5 dashboard notes). Decisions captured:
1. **Savings unclear** — no picture of *actual saved-to-date* vs the **HBX-default curve + 75 °C
   setpoints** baseline. Owner wants "a clear chart."
2. **"Auto-pilot on but autonomy Off"** — the `Off/Set&forget/Request/Armed` switch is a
   preview mockup (`setMode` re-renders copy, actuates nothing); the LIVE badges are ground
   truth from the planner heartbeat. Owner decision: **wire the switch to actually drive
   autonomy.**
3. **COP receipt "bumpy"** — explained, not a bug: the blue line is per-outdoor-°F binned
   measurements (n≥3), plain `M`/`L` segments, zero smoothing → honest sampling noise. No code
   change unless owner wants a smoothed trend overlay (out of this wave's scope).
4. **Keep data indefinitely + easier to look back** — retention already holds (grep: nothing in
   `planner/` or `hub/` deletes/truncates/prunes/expires rows; every table just accumulates in
   Neon). Gap is a *durable backup* (Neon free-tier PITR ≈ 7 days) + a *look-back surface*.
5. **Running log of every autopilot/autonomous change, with rationale** — the data already
   exists (`autopilot_log.reason`, `phase_b_log`, `hbx_writes.detail`, dedup'd on change); it is
   just not surfaced beyond "latest 1" on home + "last 8 writes" on savings.

All app changes in `analytics-mirror/`; planner changes in `planner/src/`. House idioms hold:
pages export `runtime="nodejs"`/`dynamic="force-dynamic"`/`fetchCache="force-no-store"`;
parameterized `sql` tagged templates; try/catch degraded states; °F display; Eastern time via
`@/lib/tz`. Planner idioms: env-seeded flags, bearer-auth HTTP routes, `store` accessors,
`ntfy` on state changes.

## Executive calls (owner may redirect)

- **Autonomy scope (note 2):** ship **Off ↔ Armed as real control now** — they map cleanly onto
  the two dry-run flags that already exist (`AUTOPILOT_DRY_RUN`, `PHASE_B_DRY_RUN`). **Set &
  forget** (hold one reset curve) and **Request** (per-hour approval queue) are NEW planner
  *behaviors* that don't exist yet — they become **honest fast-follow** nodes (F, G). The switch
  shows them disabled/"coming" until their behavior lands. We do NOT fake a mode the planner
  can't execute. Rationale: minimal reversible change that resolves the confusion (the switch
  stops lying), right-sized, no over-build.
- **Savings re-slice (note 1 vs W1-K #29):** W1-K bundled `savings + advanced`. W2-D **absorbs
  the savings half** (does W1-K's header-removal AND adds the chart in one owned edit). W1-K
  shrinks to **advanced/page.tsx only**. No two live nodes touch `savings/page.tsx`.
- **Backup destination (note 4):** default to a **nightly GitHub Actions `pg_dump` → gzip →
  committed to an orphan `db-backups` branch** in this repo. Free, versioned, indefinite, no new
  cloud account (owner rejects over-engineering). Changeable to S3/Backblaze if owner prefers.

## Why this wave is sliced by FILE

Same rule as W1-UI: **no two nodes in the same wave touch the same file.** The autonomy write
path is the one interlocking cluster (planner `index.ts`/`store.ts`/`autopilot.ts`/`phaseb.ts`
change together) → it is a **single-owner node (A)**, not fanned out. Everything else is a
disjoint new file or a single owned page.

## Graph

```
A  w2-a-autonomy-flags   planner: controller_flags table + flags.ts (runtime store,       [no deps]
                         env-seeded) + index.ts (per-cycle effective-flag read → pass to
                         controllers, heartbeat reflects RUNTIME not static env, new
                         POST /api/autonomy bearer route) + autopilot.ts/phaseb.ts
                         (effective dryRun per-tick). Ships OFF↔ARMED as live control.
   └─ B w2-b-switch      analytics-mirror: app/api/planner/autonomy/route.ts (NEW proxy) + [A]
                         optimize-client.tsx (switch onClick → POST; off/arm actuate;
                         set/req render as preview-disabled "coming") + optimize/page.tsx
                         (seed current mode from heartbeat)
C  w2-c-activity         analytics-mirror: app/activity/page.tsx (NEW) — merged, timestamped [no deps]
                         change log of autopilot_log + phase_b_log + hbx_writes, each with
                         its rationale + accepted/refused result + dry-run tag; window seg.
                         (+ 1 nav entry — see nav.tsx coordination note)
D  w2-d-savings-chart    analytics-mirror: app/savings/page.tsx — cumulative "$ saved to date  [absorbs
                         vs HBX-default+75°C baseline" area chart (bespoke SVG, curve-page      W1-K
                         non-scaling-stroke idiom) + W1-K header-removal. Keep all cards/copy.  savings]
E  w2-e-backup           scripts/backup-db.sh (NEW) + .github/workflows/db-backup.yml (NEW) —  [no deps]
                         nightly pg_dump → gzip → orphan db-backups branch. Retention note in
                         knowledge/.

── fast-follow (owner-gated after Off↔Armed proven live) ─────────────────────────────
F  w2-f-set-forget       planner: Set&forget behavior = autopilot holds ONE optimized reset   [A]
                         curve (writes curve, ignores hourly plan). Enables the "set" mode.
G  w2-g-request-queue    planner + dashboard: per-hour approval queue; planner honors          [A,B]
                         approved setpoints only. Enables the "req" mode.
```

## nav.tsx coordination

`app/nav.tsx` is a NEW file owned by **W1-D** (W1-UI wave), not yet built. W2-C needs one nav
entry ("Activity"). Rule: **W2-C owns `app/activity/page.tsx` exclusively**; the nav link is a
one-line edit applied by whoever lands nav.tsx last (if W1-D lands first, W2-C adds the `<a>`;
if W2-C lands first, the Activity route exists and W1-D's nav includes it). Until nav exists,
the page is reachable by URL — it degrades gracefully.

## Value scores (V impact 1–5 × U unlocks ÷ C cost in rounds)

| Node | V | U | C | V·U/C | Notes |
|---|---|---|---|---|---|
| C activity      | 4 | 0 | 1 | leaf | pure surfacing of existing data; owner's "first"; zero live-system risk |
| A autonomy-flags| 5 | 5 | 3 | 8.3  | load-bearing; resolves the switch-lies confusion; touches LIVE control |
| B switch        | 4 | 0 | 2 | leaf | makes the switch real; needs A |
| E backup        | 3 | 0 | 1 | leaf | durability net; fully independent infra |
| D savings-chart | 4 | 0 | 2 | leaf | the headline "what did I actually save" picture |
| F set-forget    | 3 | 0 | 3 | leaf | new mode; fast-follow |
| G request-queue | 2 | 0 | 4 | leaf | new mode; heaviest; later |

## Execution order

```
Wave 1 (disjoint files, parallel-safe):  C, D, E, and A
                                          — A=planner/*, C=app/activity/*, D=app/savings/*,
                                            E=scripts+.github → NO file overlap
Wave 2:                                   B            (consumes A's /api/autonomy)
Fast-follow (owner-gated):                F, then G
```

A is single-owner + built carefully (LIVE control path). C/D/E fan out. Report at each boundary.

## The autonomy write-path contract (A lays down; B consumes)

- **`controller_flags`** — single-row table `{ id=1, mode text, autopilot_dry_run bool,
  phaseb_dry_run bool, updated_at, updated_by text }`. Seeded from env on first boot; the DB row
  is the **runtime override**, env is only the initial default.
- Planner reads effective flags at the **top of every `pollOnce`** and passes an effective
  `dryRun` into `autopilot.applyLatestPlan(dryRun)` / `phaseB.runOnce(dryRun)` (controllers are
  always instantiated; actuation is gated per-tick, not at boot).
- **Mode → effective flags:** `off` → both dry-run (shadow/advisory). `arm` → both live.
  `set`/`req` → `501 not-yet` from the endpoint until F/G land.
- **`POST /api/autonomy {mode}`** — bearer-auth (same `PLANNER_TOKEN` gate as
  `/api/hbx/*`). Validates mode ∈ {off,arm}; upserts `controller_flags`; `ntfy` on change.
- **Heartbeat** (`upsertControllerStatus`) writes the **effective runtime flags**, so the
  dashboard "Running now" panel keeps reading ground truth (unchanged read path).

## Safety rails carried by EVERY spec

- **Guardrails untouched.** A changes only WHICH flag value is in force, never the I4/I1
  envelope, the single-writer invariant (#36), the HBX-override-Modbus-wins behavior, or the
  rate-limit. A human write / Boost still preempts (memory: HBX-override-Modbus-wins — never
  relax; autopilot-flag-ownership — one writer, all curve writes through the planner).
- **`off` is the safe default & reversible.** Switching to `off` puts both controllers back into
  shadow within one poll cycle; nothing is lost, no restart needed.
- **No secrets to the browser.** The planner token stays server-side in the `app/api/planner/*`
  proxy (same pattern as boost/target/restore).
- **Degraded states preserved.** Every page keeps its `dbError`/empty branch; copy may be humane,
  logic stays.
- **Retention is not touched.** E only READS (pg_dump); no prune is added anywhere.
- Shared checkout: all work in the `feat/w2-autonomy-savings-activity` worktree; stage only this
  wave's files; never `reset --hard` the shared checkout.

## Eval gradient (per node)

- Compile gate: `npx -p typescript tsc --noEmit` in `planner/` (A,F) / `analytics-mirror/`
  (B,C,D); `npm run build` in `analytics-mirror/` for UI nodes.
- Structural greps: A → `controller_flags` table created + `/api/autonomy` route present +
  heartbeat sources runtime flags (not the module-const). B → `optimize-client` switch has an
  `onClick` that `fetch`es `/api/planner/autonomy` for off/arm; set/req `disabled`. C →
  `app/activity/page.tsx` selects from all three log tables; no `preserveAspectRatio="none"`.
  D → savings still contains the cards/copy AND a new `<svg>` cumulative series; no local
  `<header>`/`action="/api/logout"`. E → workflow file present + script `pg_dump`s and pushes
  the orphan branch.
- Behavioral proof for A (LIVE node): on the running planner, POST `off` → next heartbeat shows
  both controllers shadow → POST `arm` → next heartbeat shows both live; `autopilot_log` records
  the transitions. Verify against the Pi/Railway ground truth, not just the sim.
```
