# I8 hygiene cadence — go-live runbook (PR #53 / issue #51)

Operational steps to take the configurable, demand-driven I8 pasteurization cadence from "merged
code" to "live," and to verify + roll it back. Written 2026-07-19. Context: DHW is coil-in-buffer;
the daily 140 °F soak is over-conservative once autopilot cools the tank in summer. See `shadow.ts`,
`index.ts` `checkI8`, and `hygiene.ts`.

## The one thing to understand first: the interlock makes ordering safe

Today's live soak is delivered by the **shadow-plan calendar boost → autopilot** (`autopilot.ts`
writes the 140 °F target, I1-safe against the as-found ~150 °F pump setpoints). `checkI8`'s
auto-sanitize actuator is **OFF** (`AUTO_SANITIZE_ENABLED` unset) — today it only *alerts*.

PR #53 does **not** delete the shadow boost. It gates it on `AUTO_SANITIZE_ENABLED`:

| `AUTO_SANITIZE_ENABLED` | Soak actuator | Notes |
|---|---|---|
| off (today / default) | shadow boost → autopilot | `checkI8` alert-only. **Merging #53 changes nothing.** |
| on (go-live) | `checkI8` demand-driven boost | shadow boost stands down next shadow run |

**There is always exactly one actuator — never two, never a gap** — so the deploy and the env flag
do **not** have to land in the same push. Worst case right after arming: one redundant soak (harmless)
if a stale plan still carries the boost for a few minutes. Only a real ≥134 °F / ≥30-min **thermal**
dwell resets the hygiene clock; draws never do (they dilute, they don't kill biofilm).

## Deploy mechanics (how a change goes live)

- **Code:** git-linked. A push to `main` touching `planner/**` **auto-deploys** the planner service
  on Railway (`planner/railway.toml`: nixpacks, `npm install && npm run build`, `npm start`). Merging
  PR #53 is the deploy.
- **Env / flags:** Railway **service variables** on the planner service (Railway dashboard → planner
  service → Variables). `AUTO_SANITIZE_ENABLED` is read **once at process boot**
  (`const … = process.env.AUTO_SANITIZE_ENABLED === "1"`), so it only takes effect on restart — but
  **setting/changing a Railway variable triggers an automatic redeploy+restart**, so no manual bounce.

## Go-live sequence

### Step 0 — Merge PR #53
Railway auto-deploys the planner. **Behavior unchanged** (flag still off ⇒ shadow boost active).

### Step 1 — Confirm the release landed
`__version__` is static (0.1.0) — don't use it. Use the new `/health.hygiene` block (added in #53):

```bash
curl -s https://<planner-service>.up.railway.app/health | jq .hygiene
# expect: { "auto_sanitize": false, "base_interval_h": 26, "summer_interval_h": 26,
#           "effective_interval_h": 26, "last_dwell_min": <n>, "last_satisfied": true, ... }
```
The planner service domain is in the Railway dashboard (the service whose root dir is `planner/`;
its `/health` has keys `ok,lastPollAt,lastShadowAt,phase_b,winter_solver,storm,hygiene`). If `/health`
is private, confirm via DB instead: the latest `shadow_plans` row still contains a block whose reason
mentions `sanitize` (interlock code present, standing by).

### Step 2 — Arm the actuator (the first automated pump write)
Set the planner Railway variable:
```
AUTO_SANITIZE_ENABLED = 1
```
Railway redeploys automatically. This hands the soak to `checkI8` and stands the shadow boost down.

### Step 3 — Verify armed + interlock engaged
- `/health.hygiene.auto_sanitize` → **true**.
- The next `shadow_plans` row (written every `SHADOW_EVERY_MIN`) has **no** `sanitize`/≥140 °F block —
  boost stood down.
- Hygiene still met, one of:
  - tank naturally held ≥134 °F/30 min in the window ⇒ `/health.hygiene.last_satisfied=true`, no soak
    needed; **or**
  - within one interval an **"Auto-sanitize"** ntfy fires, a row lands in `boosts`, `hbx_writes` shows
    `source='auto-sanitize'`, and then an **"I8 hygiene satisfied"** ntfy clears it.
- **No "I1 violation" page** (the boost must pass setpoint ≥ target+margin — safe vs the as-found
  ~150 °F setpoints; if pump setpoints have since dropped below ~145 °F the boost is *rejected*, not
  forced, and you'll get the "no … soak in Nh" overdue page instead — see failure modes).

### Step 4 — Relax the summer cadence (the actual optimization; optional)
Only after watching Step 3 succeed:
```
HYGIENE_SUMMER_INTERVAL_H = 60      # ~2.5-day cadence when outdoor ≥ 55 °F
```
`/health.hygiene` → `summer_interval_h:60`, and `effective_interval_h:60` while it's warm. Hard-capped
at 72 h in `hygiene.ts` regardless of value. Leave unset ⇒ stays 26 h (demand-driven trigger only, no
cadence change).

## Rollback (zero-gap, any time)
Set `AUTO_SANITIZE_ENABLED = 0` (or delete it) on the planner service → Railway redeploys → the shadow
boost re-engages (`autoSanitize` false) and autopilot resumes the daily soak; `checkI8` reverts to
alert-only. Unset `HYGIENE_SUMMER_INTERVAL_H` to return the cadence to 26 h. No code revert needed.

## Verification surfaces (reference)

| Signal | Where | Means |
|---|---|---|
| `/health.hygiene` | planner `/health` | armed?, effective interval, last dwell + satisfied |
| ntfy **"Auto-sanitize"** | ntfy topic (Pi/hub topic) | `checkI8` fired a demand-driven soak |
| ntfy **"I8 hygiene satisfied"** | ntfy | a pasteurizing dwell was met (edge clear) |
| ntfy **"I8 hygiene: no …-min ≥134 °F soak in Nh"** | ntfy (high) | overdue — no soak actuated/reached temp |
| `boosts` table | Neon | active/next-restore boost row from the soak |
| `hbx_writes` `source='auto-sanitize'` | Neon | the guarded write the soak issued |
| `shadow_plans` latest `plan` | Neon | boost present (flag off) / absent (flag on) |
| `autopilot_log` | Neon / dashboard | target decisions (should stop showing the 140 sanitize hour once armed) |
| dashboard | `a2w-analytics-mirror.vercel.app` | Plan/Control cards read runtime, not hardcoded copy |

## Failure modes

- **Overdue pages after arming, no soak:** the boost is being *rejected*, most likely I1 (a pump
  setpoint fell below target+margin, i.e. < ~145 °F). Fail-safe by design — nothing is forced; the
  page is the tell. Fix: raise pump setpoints (or let Phase B lead them) so a 140 °F target passes I1,
  or roll back per above.
- **Tank never reaches 134 °F:** `SANITIZE_VERIFY_F` is 134; if the pumps can't push the tank there
  (reg-2027 55 °C/131 °F cap in force, capacity shortfall), the soak can't satisfy. Confirm setpoints
  can exceed 134 during the soak hour; the element (SPAN breaker) is the last resort.
- **Set the var but nothing changed:** confirm Railway actually redeployed after the variable edit
  (boot-time read); check the deploy log / that `/health.hygiene.auto_sanitize` flipped.

## State as of 2026-07-19
PR #53 open (`feat/i8-configurable-hygiene-cadence`), not merged. `AUTO_SANITIZE_ENABLED` off in prod.
Autopilot live (target lever); Phase B shadow. Merging #53 alone = no behavior change.
