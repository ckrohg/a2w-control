# Cross-system optimization & coordination plan — A2W × TempIQ × HBX

> **Status: PROPOSED (2026-07-13) — for owner review.** Goals: (1) run the buffer tank and
> heat pumps at the cheapest temperatures that still serve every load, using warm hours to
> advantage via a day-plan; (2) get there fully autonomously.
>
> Grounded in: the HBX ECO-0600 manual v2.0.3 + bulletins (researched 2026-07-13, sources at
> bottom), a deep-dive of TempIQv2 internals, the A2W register map / guardrail stack, and
> owner-confirmed facts (rates, DHW topology, comfort flexibility). Partially supersedes
> `tempiq-integration-sketch.md` §3 (the "TempIQ computes the buffer target" framing);
> the lease-loop mechanics in that sketch carry over unchanged.

---

## 0. TL;DR

1. **The flat COP is explained, and the biggest lever needs no HBX write path.** TempIQ
   measures hydronic COP ≈ 2.69, flat vs outdoor. Cause: the HPs run at max setpoint, so
   every tank charge condenses at ~55 °C water no matter what tank target HBX has reset down
   to. The HBX tank target only decides *when the call ends* — the HP setpoint decides *how
   hot the water is while charging*, and that's what COP follows. Making the HP setpoint
   **track the HBX tank target + a small margin** (readable today via SensorLinx) captures
   most of the mild-day savings using only the write path we already built and proved.
2. **Division of labor:** TempIQ stays the generic *insight engine* (zone loads, COP data,
   forecasts, thermal mass) exposed through its existing token-authed external API seam —
   zero house-specific HP logic lands there. **A2W owns the planner/coordinator** — a new,
   small `planner` service on Railway next to the hub, state in Neon; the Pi stays a thin
   gateway and all actuation stays behind its guarded API. **HBX keeps its jobs** — demand
   authority, staging/rotation, 16.5 kW backup, freeze backstop — and is never bypassed;
   later we feed it bounded tank targets instead of letting its static curve decide alone.
3. **Coordination invariant (the "never fight" rule):** HP internal setpoint ≥ HBX tank
   target + ½·differential + margin, so the *tank sensor* — never the HP's own aquastat —
   terminates every call. Your observed failure mode (tank target above HP setpoint → target
   never reached, HBX calls forever) is exactly the unguarded violation of this invariant;
   the ECO-0600 has no unreachable-target detection at all.
4. **The day plan** shifts charging into warm afternoon hours (COP timing is the only
   timing lever — flat rate + 1:1 net metering makes price/solar timing a non-factor),
   holds a DHW comfort floor around draw windows (coil-in-buffer means tank temp *is*
   shower temp, pre-mixing-valve), and lets rooms float ±1–2 °F via TempIQ's existing
   thermostat chokepoint. Legionella turns out to be a non-constraint: a coil-in-buffer
   stores **no potable water**, so there is nothing for legionella to colonize (verify
   topology at commissioning; conservative fallback documented in §6.5).
5. **Autonomy arrives in four phases** — Observe → Track → Command → Autonomous — each with
   exit criteria, and each extending the same guardrail discipline (clamp, verify, rate
   limit, audit, lease/watchdog) that already protects reg 2003.

---

## 1. Goals, restated precisely

1. **Cost:** minimize $ per delivered comfort by (a) lowering water temperatures to the
   minimum each load actually needs (baseboards are the binding emitter; DHW needs comfort,
   not sanitation — see §6.5), and (b) timing tank charges into the warmest hours of each
   day, since COP rises with ambient and with lower water temp, and electricity price is
   flat (net metering 1:1 → solar timing irrelevant to the bill).
2. **Autonomy:** the whole loop — forecast → plan → setpoints → verify → learn — runs
   unattended, with the existing safety ladder underneath (baseline revert → HBX + wall
   controllers untouched as the final fallback) and alerts only when something is genuinely
   wrong.

---

## 2. System reality — the facts this plan is built on

### 2.1 What the HBX ECO-0600 actually is (manual v2.0.3, researched 2026-07-13)

- **A tank thermostat with outdoor reset driving dry contacts.** Heating requires a Heat
  Demand closure (pins 7–8, from the zone thermostats) or `Permanent HD` = ON. Tank target
  is either a **fixed** `Tank Temp` (default 115 °F) or a **linear outdoor-reset curve**
  through four parameters: `Outdoor Reset (Design)` outdoor temp ↦ `Max Tank Temp`
  (default 115 °F), `WWSD` outdoor temp (default 65 °F) ↦ `Min Tank Temp` (default 80 °F).
  Your "SensorLinx automatically tunes down the target" = this curve.
- **Differential is centered on target** (default 6 °F): calls begin ≈ target − 3 °F and
  **end ≈ target + 3 °F** — the +½·diff matters for our margin math.
- **HP staging:** 1–4 stages with `Stage ON/OFF Lagtime` timers and lead-lag rotation by
  run-hours or cycles. The 16.5 kW element rides the **Backup** triggers: `Backup Time`
  (min after all HP stages), `Backup Diff` (tank ≥ that far below target), `Backup Temp` /
  `Backup Only Outdoor` (outdoor-gated; the latter locks HPs out entirely), `Backup Only
  Tank` (HPs capped at a tank temp; backup finishes the lift).
- **WWSD** shuts off HPs *and* backup above its outdoor temp (with an optional 0–240 h hold
  timer). Since heat calls happen here year-round via DHW draws, the installed config
  must have WWSD OFF or an equivalent — **snapshot the real config in Phase A before
  trusting any assumption** (§7, A-1).
- **DHW:** a separate DHW-tank mode exists (priority over heating) but with coil-in-buffer
  DHW it is presumably OFF here — again, confirm in the config snapshot.
- **SensorLinx app can change effectively everything remotely** — targets, curve, diffs,
  staging, backup — and every write is a **persistent settings edit** (no
  temporary-override concept). This is both the write path we need and a hazard: a stale
  optimizer write stays wrong until actively rewritten.
- **No local fieldbus.** No RS-485/Modbus/BACnet anywhere in manual or submittal. The
  advertised SensorLinx server API has no public docs and (per an Aug 2025 HA-community
  thread) still isn't released — so the **Proxyman capture of the app remains the settled
  discovery path** for writes (decided 2026-07-04, reaffirmed).
- **No unreachable-target handling.** If the target can't be reached, the ECO-0600 holds
  the call contacts closed indefinitely; the only escalations are the Backup triggers. The
  manual's own troubleshooting note ("make sure [tank setpoints] do not exceed recommended
  heat pump limits") is the entire extent of its awareness of this failure mode.

### 2.2 What TempIQ has (verified in the repo, read-only)

- **COP measurements are already tank-temp-aware:** every stored COP point carries
  `sinkTempF` (tank temp) and outdoor temp (`cop_measurements`;
  `hydronic-cop-calculator.ts`), binned by 10 °F outdoor bands. A Carnot-style
  buffer-mismatch penalty model exists (`zone-cop-calculator.ts:788-905`). → The data to
  fit the **COP(outdoor, water temp) surface** the planner needs already exists; answering
  your open question: TempIQ *records* tank temp per COP point but does not yet *publish*
  a COP-vs-water-temp curve — that's a small, generic derivation.
- **Forecasts:** OpenMeteo hourly, archived with vintage tracking (`weather_forecasts`,
  `getForecastAsOf` for hindcasting). Free API — the Pi can also fetch it directly.
- **Per-zone physics:** learned UA per zone, thermal mass C (BTU/°F), zone loads, emitter
  delivery types — the inputs for "what water temp does the binding zone need at X °F out."
- **Experimental preheat logic exists but is not wired in** (`comfort-matched-schedule.ts`
  grid-searches preheat start against the warmest in-window outdoor sample) — prior art to
  borrow *patterns* from, not a live system to depend on.
- **The consumption seam already exists:** a token-authed external surface gateway
  (`/api/surfaces`, `propertyApiTokens`, fail-closed, built for Home Assistant / Google
  Home) plus a thermostat-control chokepoint (`applySetpoints`, leases, rate limits,
  provenance). A2W can be "just another surface" — reading insights and (Phase D) nudging
  room setpoints — with **no house-specific code in TempIQ**.
- **SensorLinx connector is strictly read-only** (login POSTs only) — 5-min polling of tank
  temp/target, outdoor, 16 relays, `stgRun` zone calls, `demandSignals`.

### 2.3 What A2W has (this repo, today)

- Guarded HP writes **proven on real hardware** (Phase 2 exit: dashboard setpoint change
  verified on the wall controller, 2026-07-13). Guardrails: clamp, read-back verify, rate
  limit, audit with `source`, watchdog, `unattended_min_setpoint_c` = 45 °C floor,
  `baseline_setpoint_c` = 48 °C, lease primitive with baseline revert, renew-without-rewrite.
- Reg 2027 (unit max-water param) ships at 55 °C and caps reg 2003/2004.
- Railway hub (Pi dials out over WS) + Vercel dashboard; Tailscale Funnel fallback.
- ⚠️ HP2's CN22 BMS port was called non-functional after a controlled A/B comparison
  (2026-07-13) — **owner correction 2026-07-14: CN22 is in active use and nothing is
  dead; treat that verdict as superseded** (HP2 also had a failure-to-start issue in the
  same period, since fixed, which muddied diagnosis). Verify HP2 polls on the bridge at
  the next check; §5.4 stands only as the phantom-slot note until then.

### 2.4 Owner-confirmed facts (2026-07-13)

| Fact | Consequence for the plan |
|---|---|
| Flat rate + 1:1 net metering | Timing optimizes **COP only** (warm hours); price/solar windows are non-factors. HBX's `ECO Clock` peak lockout stays unused. |
| DHW = coil **inside** the buffer tank | Buffer temp directly drives DHW delivery (minus coil approach). DHW imposes a **buffer floor around draw windows**, not a legionella cycle (§6.4). |
| Thermostatic mixing valve, tank runs hot | Delivery is tempered; the tank may run above 120 °F safely and may float lower when draws aren't expected. |
| Rooms may float ±1–2 °F | House thermal mass becomes usable storage — the pre-heat/coast lever (via TempIQ's chokepoint, Phase D). |

---

## 3. The key insight: two levers, one termination authority

During a charge, the heat pump drives its **leaving-water temp toward its own setpoint** —
so with the setpoint parked at max, every charge condenses at ~55 °C water and COP is
pinned low **regardless of the HBX curve**. The HBX tank target (+½ diff) only decides when
the call ends. That is exactly what TempIQ's flat 2.69 shows, and it means:

- **Lever 1 — HP setpoint (reg 2003):** sets water temp *during* charging → sets COP.
  We control it today (HP1).
- **Lever 2 — HBX tank target:** sets how much energy each charge stores and when calls
  start/stop → sets standby losses and charge timing. We can read it today; writing it
  needs the Proxyman-discovered path (Phase C).
- **Termination authority — the tank sensor.** The robust, non-fighting design keeps the
  HP setpoint far enough above the tank target that HBX always ends the call:

> **Invariant I1 (never fight):**
> `HP_setpoint ≥ HBX_target + ½·differential + margin` — **MEASURED at A-4 (2026-07-14):**
> a full deep-drawdown charge at setpoint = target + 3.1 °F still terminated on the HBX
> tank sensor (pump's return-cutoff never fired; the 10–15 °F mid-charge stratification
> offset converges to ≈0 at charge end, so only the convergence gap needs covering).
> Margin set to **target + 5 °F (≈ 3 °C)** = ½·diff (+2) + convergence (~1) + cushion (~2);
> one summer data point — revisit as charges accumulate. Alert whenever the live HBX
> target violates it against the current HP setpoint or the reg 2027 cap.

Optimization = **moving both levers together, downward and in time** — never letting them
cross. Your tank-target-above-HP-setpoint problem is the crossed state; Phase B makes it
structurally impossible.

---

## 4. What lives where — and why

| System | Owns | Never owns |
|---|---|---|
| **TempIQ** (multi-user product) | Insight: learned zone loads/UA, thermal mass, COP measurement surface, forecast archive, cost analytics, savings attribution. Executes generic room-setpoint commands through its existing surface chokepoint. | Anything Arctic/HBX/house-specific. No knowledge that heat pumps or an ECO-0600 exist. |
| **A2W planner** (NEW — small `planner` service on Railway, this repo; learned state in Neon) | The decision: the joint solve of §6.2 — demand forecast × COP surface × tank-target schedule, DHW windows, HP-setpoint tracking, HBX target commands. | Direct hardware access. HP writes go planner → hub → Pi's guarded/leased API (the path that already exists); HBX writes go cloud-to-cloud to SensorLinx, never touching the Pi. |
| **A2W bridge** (Pi, exists) | Actuation + safety: guarded Modbus writes, leases, floor, baseline revert, audit. Gains one sibling module: the **HBX write adapter** with identical guardrail discipline (§5.2). | Optimization logic. Stays dumb and correct. |
| **HBX ECO-0600** | Demand authority (zone thermostats → HD), HP staging + lead/lag, 16.5 kW backup escalation, freeze backstop. | Being bypassed. We feed it bounded targets; we never fake its inputs or race its relays. |

**Why A2W owns the brain (settles the 2026-07-04 deferred decision):** you said it —
TempIQ serves many people; the MAHRW030ZA registers, ECO-0600 quirks, coil-DHW floors and
CN22 repair state are one house's business. The coordinator must command both the HPs and
HBX, and A2W is the only system that will ever speak to both. Guardrails and pump
protection already live here. TempIQ participates through two *generic* seams it already
has (insights out via surface tokens, room-setpoint commands in via the chokepoint) — both
useful to any TempIQ user with an external optimizer, so nothing house-specific leaks in.

**Why Railway, not the Pi (revised 2026-07-13, owner direction):** the Pi's job stays
exactly what it was built to be — a thin gateway to the two W610s that feeds the hub +
Vercel and stores telemetry, plus the guarded/leased write path. Three reasons the planner
belongs in the cloud instead: (a) **every planner input and its second actuator are cloud
endpoints** — SensorLinx (read *and* write), TempIQ's API, OpenMeteo. An internet outage
disables the planner wherever it runs, so Pi-hosting buys zero resilience; (b) safety
never depended on planner placement — the lease + baseline revert on the Pi handles a
dead planner identically either way, and the fusion audit's real rule ("keep stateful,
long-lived things off the side that redeploys") is satisfied by keeping the *safety* state
(lease, floor, baseline) on the Pi while the planner stays a **stateless-per-tick caller**
(any tick can be recomputed from scratch; learned state — DHW patterns, COP fits, the HBX
baseline snapshot — lives in Neon, which is already deployed); (c) no store-and-forward:
the planner never queues commands — the hub relays a live setpoint command and awaits the
ack, exactly the pattern already built. To be honest about compute: the planner is
computationally trivial (a search over 24 hourly blocks — milliseconds), so this was never
about CPU load; it's about keeping the Pi's role clean, and that's the right call anyway.

**Degradation ladder (extends the existing one):**
1. Live planner: day plan drives HBX target (Phase C+) and HP setpoint under lease.
2. Planner dead / Railway redeploying / lease lapsed: Pi reverts HP setpoint to
   `baseline_setpoint_c` on its own; HBX stays at its last **bounded** target — safe by
   the I7 fail-safe ordering (§5.1), which guarantees the baseline setpoint still
   terminates every call. Dead-man alert fires (I5); the planner restores the baseline
   curve when it comes back.
3. Bridge/Pi dead: HBX curve + wall controllers — exactly today's system, untouched.

### 4.1 Platform inventory — auth, data, secrets

Nothing new to buy, and only one new account-less API (OpenMeteo). Everything below
except the planner rows already exists and is deployed.

**Human access (you):**
- **Vercel dashboard** — existing `VIEW_PASSWORD` login + session cookie. The Planner
  page's control buttons (pause/hold/boost) run through the dashboard's *server-side*
  API routes, which proxy to the planner's API with a bearer token — no control token
  ever reaches the browser; your password session is the human gate. (Single shared
  password is deliberate right-sizing for one owner; passkey/OTP is a later upgrade,
  not a blocker.)
- **Pi dashboard via LAN / Tailscale Funnel** — full direct control (incl. power/mode,
  which the hub never relays), bridge's own session auth. The break-glass path.
- **SensorLinx app + wall controllers** — untouched, always work, always win.

**Machine auth (each hop, one secret, all existing patterns):**
| Hop | Mechanism |
|---|---|
| Pi → hub (WS out) | `HUB_PI_TOKEN` bearer on the handshake (exists) |
| Planner/dashboard → hub HTTP | `HUB_CLIENT_TOKEN` bearer (exists; planner reuses it) |
| Hub → Pi write | relayed through the Pi's guarded API — lease, floor, `source` audit (exists) |
| Pi → Vercel mirror | `INGEST_TOKEN` on outbound push (exists) |
| Planner → TempIQ | property API token (TempIQ's `propertyApiTokens`, exists; needs the small generic read-exposure for insights routes) |
| Planner → SensorLinx | the SensorLinx account login → short-lived JWT, re-login ~50 min (same dance TempIQ already does) |
| Planner → OpenMeteo | none needed (keyless, free) |

Secrets live where they run: Railway service variables (hub, planner), Vercel env vars
(mirror), `~/bridge-data/config.yaml` on the Pi. No secret crosses layers.

**Where data lives:**
| Store | What | Retention |
|---|---|---|
| Pi SQLite (`~/bridge-data`) | full-rate pump telemetry (15–30 s), fault events, **the write audit log**, comm stats | unbounded (small) — ⚠️ no off-Pi backup today. **Design (2026-07-14, rides the next bridge tag):** nightly push of the *irreplaceable* tables only (events + audit, KBs — the time series is already mirrored at 60 s) to a mirror ingest sibling → Neon latest-only |
| Neon Postgres (the mirror's DB, shared) | 1-min state mirror (90-day); **new planner schema**: plans + per-block "why", SensorLinx readings, HBX curve versions, COP fits, DHW patterns, baseline model, savings ledger (planner tables are tiny — exempt from the 90-day trim) | mixed, as noted |
| TempIQ's database | ~1 year of SensorLinx history (the A-0 goldmine), SPAN energy, weather archive with vintages, learned metrics, cost analytics | TempIQ-owned; consumed via API only |

---

## 5. Control design

### 5.1 Invariants

- **I1 — margin:** HP setpoint ≥ HBX target + ½ diff + margin (§3). Enforced continuously
  by the planner; violation (e.g. someone edits the HBX curve in the app) → alert +
  auto-raise HP setpoint within clamps.
- **I2 — winter floor:** `unattended_min_setpoint_c` = 45 °C stands (winter-safe-floor
  analysis, unchanged). All planner writes live in [floor, min(config clamp, reg 2027)].
- **I3 — DHW floor:** buffer ≥ DHW-comfort floor during learned/declared draw windows
  (initial: 120 °F / 49 °C during 06:00–09:00 and 17:00–22:00; §6.3 makes it learned).
- **I4 — bounded HBX band (REVISED 2026-07-14, owner direction: outdoor-relative, not
  seasonal):** the adapter clamps tank targets to an **envelope between two
  outdoor-indexed lines**, not a static range:
  - *Upper line* = the as-found HBX curve + 3 °F — never command hotter than the
    behavior the hardware has tolerated for years; only cooler. Rises with cold
    automatically.
  - *Lower line* = the binding-zone minimum: 95 °F tank at ≥55 °F outdoor, rising
    linearly to 135 °F at 5 °F outdoor (Dining baseboard design-day need, TempIQ zone
    model). Endpoints tighten as A-4/winter data land.
  - *Strict cap 135 °F until Phase B is live* — a stale winter write above that against
    a lease-lapsed baseline pump recreates the deadlock (I7). The cap lifts when Phase B
    actively holds HP setpoints above the commanded target.
  - **Heating demand lives in the planner, not the clamp**: zone calls / solar-gain /
    float inform the *choice* within the envelope; the clamp stays a pure function of
    outdoor temp — dumb, auditable, reconstructible from one number.
  The adapter still refuses every parameter it wasn't explicitly scoped to.
- **I5 — lease/watchdog symmetry:** HP writes keep the existing lease. HBX writes are
  persistent, so the equivalents are: a dead-man heartbeat (healthchecks.io — the existing
  pattern) that pages when the planner goes quiet; baseline-curve restore on planner
  restart and on explicit stand-down; and I7, which makes even an un-restored last write
  safe — bounded, and still terminated by the lapsed baseline setpoint. Merely suboptimal,
  never stuck.
- **I6 — hands off staging:** never bias HBX rotation/staging dynamically. One deliberate,
  static exception while HP2's port is dead: §5.4.
- **I8 — thermal hygiene (added 2026-07-14; owner concern, and it corrects §6.5):**
  within every rolling 24 h the tank spends **≥60 min at ≥131 °F (55 °C)** — the daily
  sanitize boost, scheduled in the warmest feasible hour (hygiene at the day's best COP).
  Why: the potable water *inside the DHW coil and first hot piping* sits at tank
  temperature between draws; a low-idle optimized tank (~110 °F) would park that slug at
  the legionella growth *optimum* — a regime the as-found 150 °F+ operation never
  entered. Monitored from `slx_readings`; alert if 26 h passes without a qualifying
  excursion; the mixing valve keeps delivery tempered regardless.
- **I7 — fail-safe ordering (checked at planner startup):**
  `I4 band top + ½·diff + margin ≤ baseline_setpoint_c ≤ min(clamp, reg 2027)`.
  Guarantees that if the planner dies the instant after its highest allowed HBX write and
  the HP lease lapses, the baseline setpoint still satisfies I1 — the tank sensor still
  ends every call, no deadlock. Concrete consequence: a 120 °F DHW-window boost ceiling
  requires `baseline_setpoint_c` ≈ 53–54 °C (up from 48), still under the 55 °C reg-2027
  cap. One config-coherence inequality instead of a distributed failure mode.

### 5.2 The HBX write adapter (Phase C gate)

Discovery: **Proxyman capture of the SensorLinx app** changing (a) fixed tank target,
(b) curve Min/Max, (c) reading settings — same workflow you used for the read side.
Then the adapter gets the reg-2003 treatment, mapped to a cloud API's realities:

| Guardrail | reg 2003 form | HBX form |
|---|---|---|
| Clamp | 422 outside bounds | I4 band + parameter allowlist |
| Read-back verify | immediate re-read | poll the telemetry endpoint until the target reflects (≤1 poll cycle), else alert + retry once |
| Rate limit | 60 s/pump | ≥15 min between HBX writes (it's a settings EEPROM + a consumer cloud) |
| Audit | events table, `source` | same table, `source=planner`, old→new values |
| Lease | in-memory lease, baseline revert | baseline-config snapshot + watchdog restore (I5) |
| Failure posture | never queue stale writes | never retry a stale plan hour; recompute or skip |

Also record — once, in Phase A — the **complete HBX settings snapshot** as the canonical
baseline (the thing watchdog-restore restores, and the reference for drift detection).

### 5.3 What we deliberately do NOT do

- No faking the HD demand input, no relay interposers, no `Permanent HD` changes — the
  zone thermostats remain the demand truth.
- No HBX staging/backup parameter tuning in v1 (snapshot, monitor, leave alone).
- No Modbus writes to HP mode/power from the planner (setpoint-only, exactly like the
  existing unattended-writes restriction).
- No dependency of any safety property on TempIQ, SensorLinx cloud, or the internet.

### 5.4 The HP2 constraint

HP2's CN22 is dead at the board, so HP2's internal setpoint is wall-controller-static.
Mitigation that preserves most of the savings:

- Set HP2's setpoint (wall controller, once) to clear the worst-case winter HBX target —
  it becomes the always-safe, less-efficient unit.
- In the HBX config, prefer **HP1 as fixed lead** (disable or lengthen rotation): mild-day
  single-stage charges then always run on the pump whose water temp we can track downward.
  HP2 joins as stage 2 mainly in cold weather, when high water temps are needed anyway and
  the COP penalty of its static setpoint is smallest. Trade-off to accept knowingly:
  asymmetric compressor run-hours.
- **Winnie thread CLOSED (owner, 2026-07-14):** the serial number was already sent, she
  answered everything needed, and CN22 comms are in active production use — nothing is
  owed and no repair thread is open. Standing check: confirm HP2 polls on the bridge
  dashboard at the next hardware session; once it does, this section's constraint is void
  and rotation-off remains purely the phantom-slot mitigation (§5.5).

### 5.5 The 16.5 kW element — rules of engagement (added 2026-07-13 after A-1)

**The finding (corrected 2026-07-13 against SPAN — owner flagged the HBX counters):**
the element shows **969 hours on HBX's `bkRun` counter**, but that counter records
*call-time, not delivery*. SPAN (the metered truth, §6.4) shows the element actually
consumed only **582 kWh ≈ ~$175 this record** (69 Nov / 0 Dec / 405 Jan / 108 Feb / 0
since March) — because the owner has kept the element's circuit **OFF at SPAN**, honoring
calls only briefly midwinter. Peak draw 16.5–16.8 kW confirms the "Buffer Tank" SPAN
circuit is the element. Two consequences replace the naive money story:

1. **The deadlock generates chronic backup *demand*** — its only live trigger is
   `bkLag` = 230 min after all stages pin on (`bkDif`/`bkTemp`/`bkOd`/`bkTk` are all
   effectively disabled), and the unreachable 164 °F target keeps stages pinned on cold
   days. Had those 969 call-hours been honored at 16.5 kW, it would have been ~$5k of
   resistive heat; the SPAN-off mitigation avoided the cost…
2. **…at the price of running with NO freeze backstop.** The winter-safe-floor analysis
   counts the 16.5 kW element as an independent freeze backstop — with it off at SPAN
   (and HP2 also impaired much of the record, §8.1), that backstop did not exist. The
   plan's end-state: **fix the deadlock (Phase B), then re-enable the element at SPAN**
   as a true emergency backstop that should ~never fire — with R1–R3 below making any
   firing a logged, alerted, explainable event instead of a silent $5/hour.

**Data-quality rule this establishes:** every HBX run-hour counter (`stgRun`, `bkRun`)
means "hours called", not "hours running" — HP2's stage counter kept incrementing through
months when the unit wasn't actually starting. SPAN circuits and Modbus telemetry are the
operational truth; HBX counters are only useful for call-pattern analysis.

**Planner rules (owner's requirement: never falsely trigger the backup):**
- **R1 — reachability:** never schedule a tank target the pumps can't reach well inside
  `bkLag` at forecast ambient (capacity-aware charge sizing; I1 already removes the
  chronic unreachable case).
- **R2 — live abort:** the reader watches `backup.activated`, stage saturation, and tank
  slope. If all real stages are on and the projected time-to-target approaches
  `bkLag − 30 min`, the planner steps the target down (ends the call cleanly) rather than
  letting the timer expire.
- **R3 — element accounting:** every element-minute is logged with plan context (SPAN
  circuit + `bkRun` counter + relay state) and alerts while the planner is active —
  element runtime on a genuinely design-cold day is legitimate; any other firing is a
  planner bug to post-mortem.
- **R4 — HBX triggers stay exactly as-found (owner decision 2026-07-14).** `bkTemp`
  stays 90 °F deliberately: the element must remain a true year-round backup — (a) rescue
  if both HPs fail, and (b) surge capacity when demand outruns the compressors (the
  huge-bathtub case: a lot of piping-hot water needed fast). False-trigger protection is
  the planner's job via R1–R3 — reachable targets keep the 230-min lag timer from ever
  expiring falsely — not the HBX gates' job.

**The phantom slot 3 (damaged HBX, replacement in a few months):**
- **Keep `numStg`=3 until the new HBX** — dropping to 2 would relocate the backup onto
  the *damaged* slot 3 (the manual puts backup on the relay after the last HP stage),
  which is exactly why the phantom exists.
- **But turn rotation OFF** (`rotTi` 1 → 0): today the phantom rotates into the lead
  ~⅓ of the time (run-hours 3170/3169/3172 are near-equal), and when it leads, the house
  waits `lagT` = 60 min for the first *real* heat pump to start. Fixed order also
  implements §5.4's fixed-lead HP1 — verify at the panel which physical pump is wired to
  stage 1 and swap the two stage wires if needed. One app write, reversible, and it makes
  the phantom harmless (it only ever "runs" as the last stage, adding one more lagT of
  buffer before the backup timer).
- **Adapter/monitor config knobs** (so the HBX swap is a config edit, not code):
  `hbx.num_stages`, `hbx.backup_stage_slot` (now 4, later 3), `hbx.phantom_stage_slots`
  (now [3], later []). The planner only *monitors* these; it never writes staging params.

---

## 6. The day plan

### 6.1 Physics reality check (sets expectations)

The buffer tank is a **minutes-scale** battery: ~50 effective gallons (TempIQ's estimate —
confirm real volume, §10) × a 10 °F usable swing ≈ 1.2 kWh thermal ≈ 10–20 minutes of
design-day load. The real storage is (a) the **house fabric** via the ±1–2 °F float
(hours-scale, Phase D) and (b) **timing** — choosing *when* the inevitable charges happen.
So the day plan's wins come from: charging at 2 pm instead of 2 am (diurnal swings of
10–15 °F ≈ 15–25 % COP difference at these lifts), lower water temps whenever the binding
load allows, and not holding 130 °F all night for a 7 am shower that needs one boost.

### 6.2 The planner loop — the joint solve (Railway service)

Tank target, COP-based cost, and estimated demand are **one problem, solved together**,
not three features. Formally, once per hour over a rolling 24 h horizon:

- **Demand model (from TempIQ signals + learned DHW):** for each hour *h*,
  `spaceLoad_h = Σ_zones UA_z × (roomTarget_z − outdoorForecast_h) − gains_z` (TempIQ's
  learned per-zone physics) and `dhwLoad_h` from the draw-window profile (fixed at first,
  learned in Phase D). Demand also sets a **feasibility constraint**, not just a quantity:
  during hours when zones call, the tank must sit at or above the binding zone's required
  supply temp (emitter curve — baseboard binds, radiant never does).
- **COP model:** the measured surface `COP(outdoor, water)` — seeded from TempIQ's
  `cop_measurements` (each point already carries outdoor temp and `sinkTempF`, §2.2),
  refined by the planner's own charge logs (§6.3). This is where "COP is a curve vs
  exterior temp" lives: at any given water temp it *is* that exterior-temp curve; the
  second axis (water temp) is what the setpoint-lowering lever moves along.
- **State:** one number evolves hour to hour — tank temp:
  `tank_{h+1} = tank_h + (charge_h − spaceLoad_h − dhwLoad_h − standbyLoss(tank_h)) / C_tank`.
- **Decision variables:** the hourly tank-target schedule `T_h` (which fixes
  `hp1_setpoint_h = T_h + margin` via I1, and determines when charges happen because HBX
  calls whenever tank < T_h − ½ diff and zones demand).
- **Objective:** minimize `Σ_h electricalEnergy_h = Σ_h thermalCharge_h / COP(outdoor_h, waterTemp_h)`
  — flat rate + 1:1 net metering means energy *is* cost; no price term.
- **Constraints:** binding-zone supply temp when calling; DHW floor in draw windows (I3);
  freeze floor (I2); HBX band (I4); fail-safe ordering (I7); tank physics above.
- **Solver:** discretize tank target to ~2 °F steps over 24 blocks and dynamic-program /
  exhaustively search — milliseconds of compute; no ML, no external solver. The
  interweaving is exactly why it's solved as one DP: raising `T_h` in a warm afternoon
  hour costs a little COP *now* (higher water temp) but buys stored heat that avoids
  charging in a cold evening hour (much worse COP) — only a joint solve can price that
  trade correctly.
- **Actuation:** every 15 min, the current block is asserted — HP1 setpoint through
  hub → Pi guarded/leased write (`source=planner`, renew-without-rewrite makes unchanged
  re-asserts free); tank target through the SensorLinx adapter (Phase C+), written only
  when the block's value differs from the last verified write.

Example winter day it should produce: overnight glide at the floor (45 °C) → small 06:00
boost to the DHW floor for showers → late-morning reset tracking the binding zone → main
charge 13:00–16:00 at the day's ambient peak, filling the tank to the top of band →
evening coast through DHW window → back to floor.

### 6.2b Who computes what (the level-by-level answer)

| Quantity | Computed by | Consumed by |
|---|---|---|
| Zone UA, gains, thermal mass, emitter types | **TempIQ** (already learned) | planner demand model |
| Weather forecast (hourly) | OpenMeteo (TempIQ archives it; planner fetches directly) | planner demand + COP lookup |
| Raw COP measurement points (with outdoor + tank temp per point) | **TempIQ** (`cop_measurements`) | planner fits the COP(outdoor, water) surface |
| DHW draw windows | **planner** (learned from tank-temp signatures) | planner constraints |
| Hourly demand forecast, tank-target schedule, HP setpoints | **planner** (the joint solve above) | actuation |
| HP setpoint execution + guardrails + lease | **Pi bridge** (exists) | — |
| Tank-target execution | **SensorLinx adapter** in the planner (Phase C) | HBX |
| Call timing, staging, rotation, backup element | **HBX** (untouched) | — |
| Savings attribution, cost analytics, weather-normalized baseline | **TempIQ** (existing analytics) | you |

TempIQ never sees a heat pump register, an HBX parameter, or a plan. The planner never
re-derives physics TempIQ already learned. The Pi never decides anything.

### 6.3 Learning loops (Phase D)

- **DHW draw patterns:** detected from tank-temp draw signatures (coil draws are sharp) →
  replace the fixed windows with learned ones + a manual "guests" override.
- **COP surface refinement:** planner logs (outdoor, LWT, power, ΔT) per charge; fits the
  house's own COP(ambient, water) surface; TempIQ's measurements are the cross-check.
- **Margin/floor tightening:** commissioning items from the winter-floor analysis feed back
  (buffer→emitter drop, real design-day COP, emitter curves).

### 6.4 Operating-cost data flow (energy → $)

Three layers, each already existing or one config value away:

1. **Metered truth — SPAN panel circuits.** The two HP condenser breakers (and the
   16.5 kW element's circuit) are metered at the panel, and TempIQ already ingests them —
   including the hard-won cumulative-counter power derivation and the `heat_pump_a2w`
   circuit mapping via `equipment_relationships`. This is the kWh source for COP
   measurements, seasonal totals, and $ attribution, because it captures **everything**
   the units draw: both compressor types, fans, the circulator, crankcase heaters.
2. **Real-time/diagnostic — Modbus regs 2063/2088** (per-stage inverter power, 15–30 s
   cadence on the Pi → hub feed). Deliberately *not* the accounting source: it excludes
   the fixed-frequency compressors (estimable via regs 2074/2099 current × 2077 voltage)
   and its units are unverified until commissioning. The planner uses it for live charge
   feedback — "is this charge drawing roughly what the plan predicted" — and for
   per-stage diagnosis SPAN can't see.
3. **$ conversion — TempIQ `utility_config`.** One flat $/kWh from the actual bill
   (TempIQ currently defaults to $0.15; MA retail is roughly double — set the real
   number). With 1:1 net metering, retail is the correct marginal price for every kWh at
   every hour — which means the planner's *decisions* never need the rate at all (it
   purely minimizes kWh; a scalar can't change the argmin). The rate exists only so the
   $ reporting and the Phase C/D savings attribution are honest.

The planner pulls (1) and (3) through TempIQ's API — the same insights seam as the zone
physics; we do not build a second SPAN connector, so TempIQ's derivation fixes stay fixed
in one place — and (2) from the hub's pump-state feed.

### 6.5 DHW & legionella — the honest picture

A coil-in-buffer (reverse-indirect) stores **heating water, not potable water**; potable
passes through the coil on demand, and the mixing valve tempers delivery.

**CORRECTION (2026-07-14, owner pushback — the original conclusion was regime-dependent):**
the potable water *inside the coil and the first hot piping* sits at tank temperature
**between draws**, and a large coil holds real gallons. At the as-found 150 °F+ this is
harmless (no growth above ~122 °F) — but the optimizer's low idle targets (~110 °F) would
park that slug at the legionella growth **optimum** for hours a day. So sanitation IS a
constraint of the optimized regime, handled by **invariant I8**: a daily ≥60-min excursion
to ≥131 °F (55 °C), scheduled at the day's warmest hour (best COP), monitored and alerted.

- The DHW *comfort* constraint stands separately: tank ≥ (desired delivery + coil
  approach ≈ 5–8 °F) during draw windows — invariant I3.
- **Commissioning checks:** confirm no downstream potable storage tank (if one ever
  appears, the excursion becomes weekly 140 °F/60 °C as well); measure the coil volume
  (bigger slug = stricter I8 posture).

### 6.6 Demand anticipation & capacity staging (added 2026-07-14, owner insight during A-4)

The 2026-07-14 tub test exposed the two-lever reality: the tank fell 25 °F+ *with a pump
running*, so pre-stored energy alone cannot cover a big draw — you need **energy**
(pre-boost) *and* **power** (parallel compressors during the draw). They live in
different systems:

- **Anticipation = the planner's job** (it has the forecast, learned draw windows, COP
  curve): pre-boost the tank toward the envelope ceiling in the best-COP hour before a
  learned big-draw window. Synergy: schedule the I8 sanitize boost immediately before the
  evening draw window — hygiene, pre-boost, and COP timing become one charge.
- **Reaction = HBX's job** (only it is fast enough), and it's currently tuned against us:
  `lagT` = 60 min means the second pump joins a tub crisis an hour late. **Proposed
  experiment (owner applies in the app, reversible):** `lagT` 60 → ~15 min. Measure over
  two weeks: draw-recovery time, dual-compressor start counts, and part-load vs full-load
  energy per delivered °F (SPAN per circuit) — two part-load inverters may beat one
  flat-out compressor, or not; the data decides. Short calls (< lagT) stay single-stage.
  The phantom slot 3 stays harmless in fixed order (it "joins" as a no-op after stage 2).
- **Recovery quirk (measured today):** a Modbus power cycle during an active call resumes
  automatically but only after the compressor's anti-short-cycle delay (~minutes). And a
  Modbus "off" DOES override an active HBX call — the Phase-E hard-gate answer; power
  stays human-only.

### 6.7 The tank's behavioral model — TempIQ-first (owner direction 2026-07-14)

Nameplate gallons is the wrong question. The planner's tank node is
`C_eff·dT/dt = P_hp − Q_dhw(t) − Q_zones(t) − UA_tank·(T − T_basement)`, and the
parameters come from behavior, not the label:

- **TempIQ already learns most of this** (hydronic-system-learner): effective thermal
  mass, DHW-vs-standby-loss decomposition of hydronic overhead, per-zone loads. These
  outputs are now in scope for the TempIQv2#1470 insights API — the planner consumes,
  never re-derives.
- **The planner self-learns C_eff continuously** from its own 5-min data: every charge is
  a known-input slope (SPAN kW in ÷ °F/h rise), every idle overnight a decay fit, and
  events like the 2026-07-14 tub (pump off + full draw = pure discharge slope, then a
  clean recovery ramp) are free step-response experiments worth auto-detecting.
- Standby loss falls out of the same fits (idle decay at known tank-vs-basement ΔT), and
  it shrinks quadratically as targets drop — part of the savings, tracked not assumed.

### 6.8 Owner interface — how you control it and check on it

Everything lands on the surfaces you already use: the **Vercel dashboard** (remote,
phone-first) gets a Planner page; the **Pi dashboard** keeps working on the LAN as the
fallback; the wall controllers and the SensorLinx app remain untouched beneath it all.

**See (the Planner page):**
- **Today's plan strip** — 24 hourly blocks showing planned tank target, HP setpoint,
  forecast outdoor temp, and expected COP; current block highlighted; each block labeled
  with *why* (warm-hour charge / DHW window / binding-zone reset / floor). In Phase A
  this is the shadow plan — visible before it's ever allowed to act.
- **The overlay chart (your second ask, directly):** live HBX target vs planner target
  vs HP1/HP2 setpoints vs actual tank temp vs outdoor temp, on one timeline. This is the
  I1 invariant made visible — any crossing of the lines is the failure mode, and it alerts.
- **The HBX curve card:** the as-configured reset line (A-1 snapshot parameters:
  Design-outdoor ↦ Max Tank, WWSD ↦ Min Tank — cross-checked against the A-0 empirical
  line mined from TempIQ's year of history) drawn as target-vs-outdoor, with the
  observed (outdoor, live target) points scattered on top. If someone edits the curve in
  the SensorLinx app, the points depart the line → **drift alert** + automatic I1 re-check
  against the new reality. The snapshot curve is version-controlled; every detected drift
  is recorded as a new version with a timestamp.
- **Savings card** — week and season-to-date vs baseline (§8.1), with the measured COP
  distribution vs the flat 2.69 as the physics-level receipt.

**Control (human-only, always wins):**
- **Pause planner** — one button: HP setpoints revert to baseline, HBX baseline curve
  restored, planner stands down until resumed. The house runs exactly as today.
- **Hold** — freeze current temps for N hours (guests, sick kid, whatever).
- **DHW boost now** — one-shot charge to the DHW ceiling, then back to plan.
- **Phase selector** — shadow / track / command are config toggles, so stepping back a
  phase is one tap, not a rollback.
- **Precedence rule:** a human write (dashboard or wall controller) always preempts the
  planner. The audit log's `source` field already distinguishes `ui` from `planner`; the
  planner watches it and enters a hold-off (default 4 h) after any human write, then
  resumes with a notification — it never fights you for a setpoint.

**Alerts (extends the existing ntfy + healthchecks stack):** invariant violation (I1–I7),
HBX curve drift, unexpected 16.5 kW element runtime, plan-vs-actual divergence beyond
threshold, planner dead-man. Same discipline as ever: P17-class noise never pages.

### 6.9 The winter solver — demand-driven service floors (added 2026-07-15, owner direction)

The I4 lower line is a **permission floor, not a demand model** — and the owner's reading
of the /curve counterfactual is correct: a winter pinned at the 135 °F strict cap serves
the binding baseboard zone with *zero margin* and serves it even when that zone isn't
calling. Each emitter class has its own service temperature; the tank should ride the
**maximum of the floors that are actually active**, not a static curve.

**Service floors (per-zone ground truth, inventoried 2026-07-14 from TempIQ + docs):**

| Constraint | Required water at emitter | Active when |
|---|---|---|
| Fin-tube baseboard — **Xmas Room + Upstairs ONLY** (owner survey 2026-07-14) | `AWT = T_room + (135 − T_room)·f^(1/1.35)`, `f = (65 − T_out)/60` → ≈135 °F @ 5 °F out, ≈115 @ 30, with a ~108–110 °F practical floor (fin-tube convection collapses below it) | zone calling (or predicted within recharge horizon) |
| Radiant floors — **everything else hydronic**: Dining, Kitchen, Mud Rm, Master Bath, Upstairs Bath, AND Living Room (TempIQ's "Living Room Baseboard" name + delivery_type are both wrong) | 95–110 °F — behind tempering hardware that is *assumed but never inspected* (tank has run 150 °F+ into these loops for years) | zone calling; rarely binds |
| DHW comfort (I3) | tank ≥ 120 °F during draw windows (delivery + 5–8 °F coil approach; window learner live) | draw windows |
| Thermal hygiene (I8) | ≥60 min ≥ 131 °F per rolling 24 h | daily, scheduled at best COP |
| Freeze floor (I2) | HP setpoint ≥ 45 °C / 113 °F | always, unattended |

**Solver:** every plan block, `target = clamp( max(active floors) + buffer→emitter margin
(~4–5 °F, measure via reg 2051), I4.lo, I4.hi )`, with pre-charge moved to the best-COP
feasible hour (existing §6.6 anticipation) and coast-to-idle when nothing calls and
nothing is predicted. Demand inputs per zone: calling state + room error (Nest, ~2-min),
learned UA·(T_set − T_out) + recovery term from thermal mass C — all of which TempIQ
already learns (zone_envelope metrics, updated daily). The block's *why* gains the
binding zone: “Dining calling, needs 128 °F” instead of “winter guard”.

**TempIQ-first data plane (§6.7 doctrine), with a hard degraded mode:** the solver
consumes the shipped `/api/insights` seam (#1470/#1480 CLOSED via PRs #1490/#1502 —
`/zones` with UA + thermal mass + deliveryType is live today, and our pusher token
already authenticates). If TempIQ is unreachable or stale >30 min, the solver falls back
to exactly today's behavior (static I4 + winter guard) — A2W never *depends* on TempIQ
to heat the house.

**Contract asks to file on TempIQv2** (the “what's missing from TempIQ” list):
1. **Live demand read:** extend `GET /api/insights/zones` (or add `/calls`) with
   designLoad, zoneType, min/max setpoint, current room temp, current setpoint,
   hvacStatus — today no token-readable endpoint says *which zones are calling*.
2. **Cost surfaces:** `GET /api/insights/cop-surfaces` — fitted hydronic COP(outdoor,
   sink temp) *after the #1503 measurement fixes land*, plus per-cluster mini-split
   copByBand (exists internally at conf 0.95, session-auth only).
3. **Space service map:** expose space → {hydronic zone, mini-split zones} with weights
   (`space_service_weights` exists in schema, 0 rows).
4. **Bug:** SensorLinx `stgRun` parser expects "Zone N"/"Stage N" but this device sends
   numeric codes ("3170:00") → `zone_calls_active` is permanently 0 and
   `hydronic_load_snapshots` (exactly the right table) has never gained a row.
5. **Ship the promised #1470 tank outputs:** effective thermal mass C_eff (BTU/°F) +
   DHW/standby decomposition — recorded internally (`hydronic_distribution`), absent
   from the insights payloads.
6. **Exposure rows** for the hydronic Nest zones on the a2w surface token, and a
   `triggeredBy='a2w-planner'` provenance value on `applySetpoints`.

**Ground truth (owner survey, 2026-07-14 — supersedes both prior sources):** baseboard =
**Xmas Room (Nest) + Upstairs (Nest)**, all other Nest hydronic zones are radiant, Kumos
are mini-splits except **Downstairs = forced air**. Consequences:
- The winter-floor doc's “Dining baseboard = 135 °F design floor” was WRONG (Dining is
  radiant), and TempIQ is wrong twice: “Living Room Baseboard” is radiant (name and
  delivery_type both misleading), and **Xmas Room has no hydronic zone at all** in
  TempIQ — its baseboard loop is invisible to every learner (filed as a TempIQ data
  correction; until fixed the planner carries an emitter-override map so the solver
  can't inherit the errors).
- Mud Room — the largest learned load (UA 232 BTU/hr/°F, 16.7 kBTU/hr design) — is
  RADIANT: the biggest heat consumer is served at 95–110 °F water. The I4 lower line
  (135 °F @ 5 °F) is now known-conservative; only two modest baseboard zones ever need
  hot water (Upstairs design load: 7.7 kBTU/hr; Xmas unknown — zone missing).
- §6.10 unlock, sharpened: **Xmas Room has its own Kumo** — design-day mini-split assist
  there (and possibly for Upstairs' spaces) could drop the whole-tank design floor from
  135 °F toward the radiant/DHW band (~110–120 °F). This is now the single biggest
  quantifiable arbitrage play.
Current accepted UA fits are summer artifacts pinned at optimizer bounds — the solver
must wait for winter re-fits (the early-July rejected fits already echo the real winter
numbers).

**Phasing (the W-track):** W0 now — file the TempIQ asks, consume what's already shipped,
owner walk. W1 first heating weeks — solver runs **winter-shadow** (log-only next to the
as-found curve, scored like A-5). W2 — solver output replaces the winter guard behind a
flag once Phase B is live (strict cap lifts) and winter fits land. Command of the HBX
target itself stays Phase C per §7.

### 6.10 Space-source arbitrage — hydronic vs mini-splits (added 2026-07-15)

Ten Kumo mini-splits cover most spaces the hydronic zones serve, TempIQ already has a
**live, hardened write path** to them (applySetpoints → oracle → 50–85 °F clamp →
per-serial lease + rate limit + audit), and their COP is measured per outdoor band at
0.95 confidence. That enables two distinct optimizations:

- **Direct dispatch:** serve a space with whichever source is cheaper at the margin —
  `$/kBTU = rate / (COP·3.412)` — mini-split COP by outdoor band vs hydronic COP at the
  tank temp *that space's zone would require*. Mild weather favors splits (no hot-tank
  penalty); deep cold favors hydronic (EVI cascade holds capacity; splits defrost).
- **The binding-constraint unlock (usually worth more):** if the binding zone (say
  Dining at 128 °F) is partially served by its mini-split, the *whole tank* drops to the
  next zone's floor (say 112 °F) — every other zone's heat gets cheaper simultaneously.
  The value of relaxing the max() dominates the per-space delta; this is the solve the
  owner described as “dynamically pick the best source per space”.

**Division of authority:** the A2W planner computes the dispatch (it owns the tank-side
COP consequence); **actuation goes only through TempIQ's applySetpoints chokepoint** (it
owns comfort, schedules, leases, and the owner's thermostat trust) — A2W is a surface
token, never a second controller. Phases: recommendations rendered on the dashboard
(winter 1) → owner-approved one-tap nudges → autonomous within owner-set bands
(winter 2). Blocked on: contract items 2 + 3 above, and #1503 (a trustworthy hydronic
COP surface). Nothing else about this plan waits for it.

### 6.11 Storm mode — resilience banking (added 2026-07-15, owner ask)

Bank heat in the tank before power-loss risk or extreme cold. The tank is the house's
only controllable thermal storage today (no battery yet — FranklinWH is planned, Kohler
generator + ATS exist), and ~30 °F of extra tank ≈ 11 kWh thermal ≈ hours of baseboard
delivery with zero compressor load on the generator.

- **Triggers (tiered, any arms it):**
  - *Predictive:* NWS active-alerts point query (`api.weather.gov/alerts/active?point=…`,
    free, no auth — Winter Storm / Ice Storm / Blizzard / High Wind / Extreme Cold
    warnings with onset/expires) — **nothing in the fleet ingests this today**; plus
    OpenMeteo 48 h heuristics (min forecast < 0 °F, freezing-rain hours, gusts) — a
    trivial extension of the planner's existing hourly fetch.
  - *Detective:* OutageWatch `GET /api/status` (public REST, already polling National
    Grid's Kubra feed every 5 min for this address) — in-outage / restored; `/api/stats`
    supplies outage-frequency priors. Unreachable = *no signal*, never = outage.
  - *Manual:* a Storm Mode button on the dashboard (and it always wins).
- **Action ladder:** from T−24 h, ramp the tank to the **storm ceiling** =
  min(as-found curve + 3 °F, HP ceiling − I1 margin) in the best-COP hours; fold the
  day's I8 sanitize into the ramp (one charge, two jobs); stage both pumps early
  (§6.6 lagT experiment); hold through the event window. Pre-Phase-B the 135 °F strict
  cap stands, so storm mode reaches full value only after Phase B — ship the triggers
  and the capped version first.
- **During an outage:** planner freezes writes (leases lapse to the safe baseline —
  I5/I7 already guarantee this is fine); recovery after restore respects the
  anti-short-cycle delay (A-4 measured). The element stays owner-only per §5.5.
- **Rules:** storm mode may only *raise* targets within I4-upper — never lower, never
  touch staging or the element, never bypass I1. Entry/exit logged to Neon
  (`storm_events`), chip on every dashboard page, ntfy on arm/stand-down.
- **Future seam:** the trigger interface stays source-agnostic so a FranklinWH SOC
  signal can join later (charge-battery-vs-heat-tank arbitration is explicitly out of
  scope until the battery exists).

---

## 7. Phased roadmap

### Phase A — Observe & discover (no new writes; start now)
- A-0: ✅ **DONE 2026-07-13 — curve mined from TempIQ's DB** (8 months, 143k samples/series):
  `reference/hbx-curve-asfound.md`. Headlines: outdoor reset ON and never edited —
  `target(°F) = 165.5 − 0.161 × outdoor`, residual σ 0.38 °F; WWSD effectively OFF
  (tank hot through July); curve's cold end (74 °C) sits AT the pumps' 75 °C ceiling and
  the **unreachable-target deadlock is confirmed in the data** (below 10 °F outdoor the
  tank runs median 9.4 °F under target, 91 % of hours >4 °F short); tank held 65–74 °C
  year-round vs loads needing ~120–140 °F — the savings band now looks conservative.
  Side-finding: app target changes appear in polled telemetry ≤5 min (the Phase-C
  read-back verify loop, demonstrated).
- A-1: ✅ **DONE 2026-07-13 — full config captured** (`hbx-config-asfound-20260713.json`,
  every parameter): curve = **Design 5 °F ↦ 165 °F, WWSD 125 °F ↦ 145 °F, diff 4 °F**
  (matches the A-0 fit exactly); WWSD 125 = never (confirmed off); `permHD=1` answers the
  summer-DHW-demand question (permanent heat demand); DHW mode off (owner-confirmed
  unused); `numStg=3` with slot 3 a **phantom** (damaged hardware; backup rides slot 4);
  rotation ON and includes the phantom; backup triggers: only the 230-min lag is real
  (diff/outdoor gates all effectively disabled) — see §5.5.
- A-2: ✅ **BUILT & TESTED 2026-07-13 — `planner/` service** (first planner module;
  TypeScript, mirrors `hub/`'s Railway pattern). Polls `api.sensorlinx.co` (the new host)
  every 5 min → `slx_readings` in Neon (tank/target/outdoor, demand, per-stage calls,
  backup call, relays) + `hbx_config_versions` (append-only drift history with
  old→new per field — the §6.8 curve-version tracker) + ntfy on drift/offline +
  `/health`. End-to-end verified against live SensorLinx and the real Neon DB.
  **Remaining: owner deploys to Railway** (root dir `planner`, 3 env vars —
  `planner/README.md`). The A-3 test nudges were also reverted via the live API with
  read-back (mbt 145, bkLag 230) — the HBX is at its exact as-found baseline.
- A-3: ✅ **DONE 2026-07-13 — write API discovered & verified** (`reference/hbx-write-api.md`):
  `PATCH api.sensorlinx.co/buildings/{id}/devices/{syncCode}` with **per-section partial
  JSON** (no read-modify-write races), response = full updated device object (read-back
  built in), JWT (15-min) + refresh-token auth, plus a minute-resolution field-history
  endpoint and a socket.io push channel — the planner's reader should use the new
  `api.` host, not TempIQ's legacy `mobile.` host.
- A-4: **Charge-dynamics experiment (HP1)** — during a real call, step HP1's setpoint down
  toward the tank target + margin and watch reg 2051/2063: confirms LWT follows setpoint,
  measures the COP delta that funds this whole plan, and calibrates the I1 margin.
- A-5: **Shadow planner** — compute the day plan, write it nowhere, log it, chart
  "planned vs actual" on the dashboard. Summer version (DHW-only loads) needs no TempIQ
  data; the winter version's binding-zone math depends on A-7.
- A-7: **TempIQ insights seam — FILED as [ckrohg-org/TempIQv2#1470](https://github.com/ckrohg-org/TempIQv2/issues/1470)**
  (2026-07-14): generic token-scoped read-only insights API (zone UA/thermal mass, COP
  points with `sinkTempF`, zone-energy, + hydronic-learner outputs per the scope comment).
  Companion write side **[#1480](https://github.com/ckrohg-org/TempIQv2/issues/1480)**:
  external-readings ingest so the planner can push per-pump setpoint/LWT/inlet — measured
  10–15 °F stratification offset (A-4) means TempIQ's COP fits need the pump-side water
  temps, not just the tank probe. Planner-side pusher is a ~20-line add once the endpoint
  exists. A TempIQ agent builds both; **circle back before heating season**.
- A-6: **Freeze the baseline** (gate for Phase B — nothing may change before this):
  record the as-found operating point — HP setpoints (owner: 75 °C at all times; the
  register snapshot confirms, including reg 2027, whose factory default of 55 °C would
  firmware-cap below that) + the as-found HBX curve — and fit the **weather-normalized
  baseline model** from pre-Phase-B history: SPAN HP-circuit kWh/day vs outdoor-temp bins
  (TempIQ has last winter archived), plus the flat-2.69 COP curve. This model is what all
  future savings are measured against (§8.1).
- **Exit:** 2+ weeks of unified telemetry; write API documented; measured COP-vs-LWT delta;
  baseline frozen (A-6); shadow plans that would have violated no invariant.

### Phase B — Track (HP-side only; kills the mismatch problem)
- **BUILT FLAG-OFF 2026-07-14** (`planner/src/phaseb.ts`, dry-run-verified live: would
  send 69 °C vs as-found 75/71 at the current 151.3 °F target — an immediate gain on
  day one). Both pumps enrolled (HP2 is writable; §5.4 void). Leased 90 min, renewed
  every 5-min poll; rollback = unset the flag → baseline. Dry-run caught a real bug:
  a 55 °C factory-default cap would have manufactured the deadlock — planner cap is 75 °C
  with the Pi's live bounds authoritative. **Enable after the ~Jul 27 gate: set
  `PHASE_B_ENABLED=1` on the Railway planner service.**
- Alert rule: HBX target (+½ diff) above the achievable HP setpoint → the exact
  "tank can never hit target" condition, now detected instead of silently burning.
- **Exit:** ≥2 weeks autonomous tracking; zero invariant violations; measured COP
  improvement on mild-day charges vs Phase-A baseline.

### Phase C — Command (tank target joins the plan)
- Build the HBX write adapter (§5.2) with baseline-restore watchdog; day plan now sets
  hourly tank targets (warm-hour charging, DHW windows) with HP1 tracking above.
- **Exit:** ≥4 weeks autonomous; watchdog-restore tested (kill the planner, watch the
  baseline curve come back); savings attribution vs weather-normalized baseline running
  in TempIQ's cost analytics.

### Phase D — Autonomous (close the loop)
- Room-setpoint float ±1–2 °F via TempIQ's surface-command chokepoint (A2W planner acts as
  a registered surface; TempIQ stays generic). Pre-heat rooms during the afternoon charge,
  coast evenings.
- Learned DHW windows, self-fitting COP surface, seasonal switchover handling; weekly
  plan-vs-actual + savings report (ntfy/email); alert-only-on-anomaly posture.
- **Exit:** a month with zero required human interventions and a defensible $ savings
  number.

---

## 8. What it's worth (honest ranges — verify against TempIQ actuals)

TempIQ's own numbers: ~340 W/°F house UA (low confidence), COP 2.69 flat, theoretical
~3.3 at 40–55 °F outdoor with matched water temps. A New England heating season on those
figures lands in the ballpark of 12–17 MWh of HP electricity; at MA retail (~$0.28–0.33/kWh,
flat) that's roughly **$3.5–5.5 k/season**. Moving average COP from 2.69 toward 3.0–3.2
(mild-day water-temp tracking + warm-hour charging + standby reduction) is a **10–20 %**
cut ≈ **$400–1,000/season**, most of it from Phase B alone. Phase C/D add the timing and
float slices and, as importantly, make it hands-off. Treat these as bands to be replaced
by the Phase-A measurement (A-4) and the Phase-C attribution — not promises.

### 8.1 How savings are measured (against the true "before")

**The baseline is the as-found system:** HBX running its installed curve + HP setpoints
parked (owner: 75 °C at all times — A-6 confirms from the registers). It's frozen in two
forms before Phase B touches anything: the config/telemetry record, and a
**weather-normalized consumption model** — SPAN HP-circuit kWh/day fit against outdoor
temp (last winter's archive + Phase-A weeks), which is what makes seasons comparable.

**The ongoing measurement:** each day, feed the actual weather into the baseline model →
"what the old system would have used" → subtract actual kWh → × the real rate = $ saved.
Weekly and season-to-date on the dashboard's savings card. Phase start dates give the
attribution split (how much came from tracking vs timing vs float). TempIQ's existing
machinery does the heavy lifting: the weather archive with vintages, the SPAN energy
pipeline, and its weather-adjusted counterfactual analytics.

**Keeping the number honest:** counterfactual models drift, so (a) the measured COP
distribution by outdoor bin vs the flat 2.69 is tracked alongside — physics that can't be
gamed by a bad baseline fit — and (b) optionally, one mid-season **baseline week** (planner
paused, as-found settings restored for 7 days) recalibrates the model against reality.
Cheap insurance for a number you'll actually believe.

**Net-accounting doctrine (added 2026-07-14, owner challenge: "make sure it's TRULY
more efficient"): the meter is the ledger; models are diagnostics.**
The only claim-grade savings number is **whole-system daily kWh vs the weather-normalized
baseline with service held constant**. Specifically:
- **The ledger set** = SPAN circuits: Air-Water 1 + 2, the 16.5 kW element, *and the
  hydronic circulators* ("Hydronic Zone Pumps & Control", "Glycol Feeder") — lower targets
  mean more cycles and more circulator hours, and those must not hide. Mini-split circuits
  are *watched*: comfort shifting onto them is load-shifting, not saving.
- **Daily-total accounting internalizes every subtlety automatically** — cycling/start
  losses, tail overshoot (measured +7 °F at min-modulation), standby-loss reduction,
  circulator runtime: all land in the meter. Nothing per-charge can be gamed into a claim.
- **Service constancy is part of the claim**: DHW comfort (tank ≥ floor in draw windows,
  no owner complaints), room temps in band — verified from tank/draw/zone data, else the
  "saving" is a service cut.
- **Per-charge Wh/°F-of-tank-rise** (A-4: 102 Wh/°F at 68 °C, 87 °F ambient) is the
  diagnostic currency — mass-independent, so setpoint A/Bs are valid even before C_eff is
  pinned — but it never headlines. TempIQ's COP 2.69 absolute level is unreliable (assumed
  ~50 gal effective mass; A-4 shows the C_eff/COP pair is unresolved); only its *flatness*
  was load-bearing, and that survives any mass rescaling.

**Capacity-outage mask (added after the SPAN check):** the historical record is
contaminated by HP2's failure-to-start period — SPAN shows it healthy Nov–Dec, degraded
Jan–Feb (~60 %/55 % of HP1's energy), and essentially dead Apr–Jul (52/104/61/6 kWh vs
HP1's 810/472/316/151) — plus the element being SPAN-disabled most of the record. The
baseline model must be fit on **healthy-capacity periods only** (Nov–Dec, Mar; flag the
rest), or the "before" misrepresents a system that never had its full 2-pump capacity.
The planner should also maintain this mask forward: a pump drawing ~0 W while its stage
is called = capacity outage → alert + exclude from model fitting (that's the detection
rule HP2's failure never had).

---

## 9. Risks & hazards

| Hazard | Mitigation |
|---|---|
| HBX writes are persistent; stale optimizer target survives a planner crash | I7 fail-safe ordering makes any bounded stale target still terminate against the lapsed baseline setpoint; band clamp (I4); dead-man alert + restore-on-restart (I5) |
| Railway redeploy kills the planner mid-plan | Stateless-per-tick design: nothing queued (no store-and-forward, per the fusion-audit rule), plan recomputed from scratch on boot; Pi lease covers the gap |
| SensorLinx cloud is undocumented and could change/break | Adapter is read-verified and fail-safe: on any surprise, stop writing, restore baseline, alert. House falls back to today's behavior |
| Tank target set above HP capability (the original complaint) | I1 enforced + alerting in Phase B; ECO-0600 itself will never detect this |
| Lower tank temps → longer 16.5 kW element runtimes if backup triggers are tight | A-1 snapshot reviews `Backup Diff`/`Backup Time`; planner watches the element relay + SPAN circuit and alerts on unexpected runtime |
| DHW comfort regression (coil DHW at lower tank temps) | I3 floor + learned draw windows; mixing valve verified; complaints = raise floor, one config value |
| WWSD surprises in shoulder season (0–240 h hold timer) | Config snapshot first; planner treats WWSD state as read-only ground truth |
| HP2 static setpoint burns COP on stage-2 charges | §5.4 fixed-lead mitigation; Winnie repair path in flight |
| Planner bugs oscillate setpoints | Existing per-lane rate limits + renew-without-rewrite already prevent EEPROM churn; plan blocks are hourly, not reactive |
| Cross-system clock/units confusion (HBX °F, HP °C) | All planner-internal state in °C with explicit °F conversion only at the HBX adapter boundary; unit-tagged fields in stored plans |

---

## 10. Commissioning / verification checklist (adds to the winter-floor list)

- [x] HBX settings snapshot committed (A-1, 2026-07-13) — `hbx-config-asfound-20260713.json`
- [x] Summer DHW demand mechanism = `permHD` = 1 (permanent heat demand; WWSD set 125 °F = never)
- [ ] Buffer tank actual volume + model (planner thermal-mass constant)
- [ ] Verify coil-in-buffer topology; confirm no downstream potable storage (§6.5)
- [x] Element mapped: SPAN circuit "Buffer Tank", measured peak 16.5–16.8 kW; actual
      delivered energy 582 kWh this record (SPAN-disabled most of the time) — see §5.5
- [ ] Post-Phase-B owner decision: re-enable the element's SPAN circuit as the true
      freeze backstop (it should ~never fire once targets are reachable; R3 alerts if it does)
- [ ] A-4 charge-dynamics test: LWT-follows-setpoint confirmed; COP delta measured; I1 margin calibrated
- [ ] Mixing valve output temp measured (sets the true DHW floor)
- [ ] DHW delivery vs tank temp curve (what tank temp still gives a good shower?)
- [ ] HBX target read from SensorLinx matches the wall display (read-path trust)
- [x] Proxyman write capture — two live writes captured & verified (`hbx-write-api.md`); ⚠️ owner reverts the two test nudges in-app (`mbt` 144→145, `bkLag` 231→230)
- [ ] Real $/kWh from the utility bill set in TempIQ `utility_config` (replace the $0.15 default)
- [ ] Regs 2063/2088 calibrated against the SPAN HP circuits (units/scaling + the fixed-freq compressor gap quantified)
- [ ] 16.5 kW element's SPAN circuit identified and its baseline runtime recorded (backup-cost watch)
- [x] **WALK (gates §6.9): emitter survey — DONE 2026-07-14 (owner):** baseboard =
      Xmas Room + Upstairs only; Dining/Mud Room/Living Room all radiant (TempIQ's
      "Living Room Baseboard" mislabeled); Downstairs Kumo = forced air. Follow-ups:
      Xmas Room hydronic zone must be created in TempIQ; confirm what heat source feeds
      the Downstairs air handler (refrigerant vs hydronic coil — if hydronic, it's a
      tank draw at fan-coil temps and joins the floor table).
- [ ] Radiant manifolds inspected: tempering/injection hardware confirmed + its output
      setpoint recorded (the radiant zones' true service temp)
- [ ] First cold snap: per-zone room temps logged with tank held at the solver floor;
      reg 2051 outlet vs commanded setpoint sizes the buffer→emitter drop (§6.9 margin)
- [ ] Winter re-fit of zone UA/thermal-mass (current accepted fits are summer artifacts
      pinned at optimizer bounds — unusable for the winter solver)

## 11. Open questions for the owner (none block Phase A)

1. Buffer tank volume/model — and is the 16.5 kW element in the tank itself?
2. Are the zone thermostats plain (dumb) stats wired to HBX HD, or smart (Nest/etc. already
   in TempIQ)? Determines whether Phase D float needs any new hardware. (I believe TempIQ
   already controls some of them — verify which zones.)
3. Appetite for the §5.4 fixed-lead change (HP1 leads while HP2's port is dead) vs keeping
   rotation and accepting the COP penalty on HP2-led charges?
4. Winnie reply (already owed: series number + forced defrost): add the HP2 CN22 dead-port
   repair question?
5. ~~§6.9 walk~~ **ANSWERED 2026-07-14:** baseboard = Xmas Room + Upstairs only; the rest
   radiant; Downstairs = Kumo forced air. Still open from the same area: radiant manifold
   tempering hardware (photo), and the Downstairs air handler's heat source.
6. Storm mode (§6.11): comfort with the planner auto-arming on NWS warnings, or
   notify-and-ask-first for the first season?

---

**Sources (HBX):** ECO-0600 Manual v2.0.3, Submittal v3, Independent-Setpoint + Wide-Priority
bulletins (cms.hbxcontrols.com), product pages, HA community thread — full URLs in the
2026-07-13 research journal. **Sources (TempIQ):** repo deep-dive 2026-07-13 (read-only):
`server/connectors/sensorlinx.ts`, `server/services/thermal/hydronic-cop-calculator.ts`,
`zone-cop-calculator.ts`, `cost-calculator.ts`, `routes/surface-gateway.ts`,
`comfort-matched-schedule.ts`. **Owner inputs:** 2026-07-13 Q&A (rates, DHW, valve, float).
