<!--
@purpose DESIGN NOTE for #241, generator-aware outage mode: how A2W should learn it is on the Kohler generator, where
the "element never closes on the generator" rule is enforced so it fails safe, what fits in 83 A, how storm pre-charge
hands off to outage conserve, and a phased rollout with the owner's physical steps and acceptance tests. No code.
Written 2026-11-20 against what is built in shadow (knowledge/reference/generator-outage-mode.md).
-->

# Generator-aware outage mode (#241): design note

> **Correction to the issue.** #241's body still says the generator is "~100 A / 24 kW". The owner corrected that on
> 2026-11-02: it is a **Kohler 20RESA on propane, rated 20 kW / 83 A at 240 V**. The planner (`GEN.CAP_W` in
> `planner/src/generator.ts`) and the Pi (`backup_fallback.generator_cap_w` in `heatpump-bridge/bridge/config.py`)
> already use 20 kW. Every number below uses 83 A. The issue text should be edited to match.

## Settled facts and rules (not re-opened here)

| Item | Value | Source |
|---|---|---|
| Transfer | Automatic whole-house transfer switch (ATS) **upstream of the SPAN panel**. The panel cannot tell grid from generator. | owner 2026-10-29 |
| Generator | Kohler 20RESA, propane, **20 kW / 83 A at 240 V** | owner 2026-11-02 |
| Heat pump | ~24 A each at peak (5.1–5.7 kW; measured p50 5.1, p95 6.1, max 6.6 kW) | owner; `span_readings` Jul 31 – Oct 29 |
| Element | 16.5 kW, **~69 A** | nameplate |
| Rule | **The element NEVER closes automatically on the generator**, by planner or by Pi. Unknown supply = generator. Replaces "last resort if it fits". | owner 2026-11-02 |
| Comfort | Hold normal targets where possible; **60 °F indoors is a hard floor**. | owner |
| Storm mode | Pre-charge tank and house before a storm so the system can conserve during the outage. | owner 2026-09-25 |
| Detection today | 6bb's National Grid email feed (`OUTAGEWATCH_URL`), email-based and laggy. The Pi gets no outage information. | built, #241 shadow |
| Hardware | Owner approved getting a quote for a **transfer-switch auxiliary contact wired into a Pi input**. | owner 2026-11-02 |

What exists, by path:

- `planner/src/generator.ts`: supply from the email feed (`OutageFeed.supply`: grid / generator / unknown), the budget,
  comfort, the `shed` and `one_pump` advisories. `assess()` sets `element_allowed = false` whenever supply ≠ grid.
- `planner/src/backupgate.ts`: the dynamic gate (`BACKUP_GATE`, shadow). A close its rules want is refused when
  `generator.allowed` is false (`generator_lockout`, one event per episode).
- `heatpump-bridge/bridge/backup_fallback.py` (shadow): Pi-local "every pump down 30 min → close Buffer Tank". It applies
  a 20 kW **budget**, which is not the owner's rule, and its header says so. `backup_fallback.live` is blocked until the
  Pi has a real generator signal.
- `heatpump-bridge/bridge/span_control.py`: `BreakerController.execute(..., precheck=)` runs the caller's check on the
  fresh panel read immediately before the POST. The "Buffer Tank" breaker is **kept OPEN**; closing it only makes the
  element available, the HBX still decides when it fires.
- `heatpump-bridge/bridge/self_heal.py`: E21 power cycles, "never two heat pumps off at once", the blind-Pi rule.
- `heatpump-bridge/bridge/span_local.py` + `span_v2.py`: the bridge reads `switch/relay` and `meter/active-power`
  per circuit and `power-flows/site`; it does not read voltage today.
- `planner/src/storm.ts`: arms on outage-grade triggers only (#115), pre-charge window = onset − 2 h, `outageActive`
  from the feed flips the machine to `active`.
- HBX `lagT = 60` (drift-check [9]): the second heat pump, and the HBX's own backup call, join ~60 min into a sustained
  call. With the breaker OPEN that backup call does nothing.

## 1. Detecting "on generator"

Ranked by latency and reliability. "Reaches" says which process can see it without the cloud.

| Rank | Signal | Latency | Reliability | Reaches | Fail-safe polarity? |
|---|---|---|---|---|---|
| 1 | **ATS auxiliary contact → Pi GPIO** | seconds (the ATS's own transfer delay, then one 30 s bridge tick) | direct, local, mechanical | Pi, then planner via the hub frame | **Yes**, by wiring (below) |
| 2 | **SPAN v2 voltage signature** (`meter/voltage-a/-b`) | ~2 s per sample; needs minutes of samples to judge | unproven; voltage only, no frequency | Pi (v2 transport), then planner | Partly: it can add "unknown", never "grid" |
| 3 | **Email feed** (`OUTAGEWATCH_URL`) | minutes to never (0 of 1 outages had a start email) | depends on National Grid mail, 6bb, and the planner's internet | planner only | Partly: silence assumes the grid after 6 h (owner 2026-11-01) |

### 1a. ATS auxiliary contact into a Pi GPIO (recommended, the only direct signal)

- **What it is.** Transfer switches carry a dry auxiliary contact (Form C) that follows the switch position: utility or
  emergency. The ATS model is not recorded in this repo; the electrician quoting the job confirms which contacts the
  installed switch has. If the switch has none, Kohler offers an aux-contact kit, and the generator controller's "running"
  relay is a weaker substitute (it says the engine runs, not that the house is on it).
- **Wiring for fail-safe.** Use the contact that is **CLOSED while on utility** and read it with a pull-up: grid = input
  pulled low through the closed contact; **generator, a broken wire, an unplugged connector, or a dead input module all
  read as "not grid"**. Never land the ATS's own voltage on the Pi: a low-voltage run to an opto-isolated input module
  (or an interposing 12/24 V relay), then the GPIO. The Pi is a Pi 5 (handoff doc); the bridge has no GPIO code today, so
  this is a small new module, not a change to an existing one.
- **Three states, not two.** The input yields `grid`, `generator`, or `unknown` (not configured, read failed, or the last
  read older than the freshness window). `unknown` is treated as generator everywhere (section 2).
- **Failure modes.**
  - Contact wired to the wrong position or polarity: reads "grid" on the generator. Caught only by the exercise test
    (section 5). The configuration must record the polarity, and the first transfer test must show the flip.
  - The Pi loses power on transfer. The ATS start-and-transfer gap is seconds; the 2026-10-11 record shows the Pi did
    **not** reboot at the 20:22 retransfer, but the outage start is unobserved. If the Pi reboots, it must read the input
    at boot before any breaker decision, and the fallback's hold clocks restart (they already do).
  - Weekly exerciser. The 20RESA has a programmable exercise; whether it transfers the house is an ATS setting. An
    exercise **with** transfer is a real "on generator" and should be treated as one (and is a free test). Nothing needs
    to special-case it.
  - The contact says "emergency position", not "generator healthy". A generator that stalls leaves the house dark; the
    Pi is dark too, so there is nothing to decide. The planner then sees the Pi unreachable and the hub pages as today.
  - The signal stops at the Pi if the Pi's Wi-Fi drops (33 reboots in 90 d, Oct). That costs nothing for the interlock:
    a planner close also needs the Pi, so "contact stale" and "cannot close" coincide (section 2). The owner's 2026-11-20
    plan includes Ethernet for the Pi, which shrinks this.

### 1b. SPAN-reported voltage (and what to measure to confirm it)

- **What SPAN exposes.** The v2 capture (`heatpump-bridge/sim/span_v2_capture.json`) shows the panel device publishing
  `meter/voltage-a` (L1) and `meter/voltage-b` (L2) in volts, plus `power-flows/site`. There is **no frequency**
  property and no upstream-lug current in the capture. v1 (`/api/v1/circuits`, what the bridge reads today) has no
  voltage at all; v1 is removed 2026-12-31 (#199). The heat pumps also report AC input voltage over Modbus (registers
  2067 / 2077, `ac_voltage_v`, reads 231 V), latest snapshot only.
- **Why it is weak alone.** Grid voltage at this panel already wanders (119.6 / 119.0 V in the one grid sample; utility
  tolerance is ±5 %). A Kohler residential set regulates voltage tightly at light load, so the mean may not move. Without
  frequency there is no clean generator fingerprint. What may differ: L1–L2 imbalance and voltage dips when a compressor
  starts, since a 20 kW alternator is a far softer source than the utility.
- **What to measure on the next real outage or exercise-with-transfer.** Log, at 5 s, for 15 min before, the whole
  generator run, and 15 min after:
  - `meter/voltage-a`, `meter/voltage-b`, `power-flows/site` from the panel;
  - both pumps' `ac_voltage_v` and `running`;
  - the ATS contact state once installed, or the owner's watch times for transfer and retransfer if not;
  - whether the SPAN panel's own device state (`$state`, uptime) resets at transfer, and whether the Pi reboots.
  Then compare: mean and standard deviation of each leg on grid vs. generator; the dip when a pump starts; the imbalance.
  If the generator shows a repeatable step (say > 2 V in the mean or a dip > 4 V on pump start that the grid never shows),
  voltage becomes a **confirmation** signal. If it does not, drop it and say so in the doc.
- **Role even if it works.** Voltage may only move the supply toward `unknown` (= generator). It never asserts `grid`.
  A false positive then costs element availability for the length of the oddity; a false negative costs nothing because
  the contact and the feed still stand.
- **Failure modes.** Needs the v2 transport live (the bridge reads v1 by default until the owner flips it); a learned
  threshold from a handful of samples; the panel itself may reboot on transfer and publish nothing for a minute.

### 1c. The email feed (what exists)

- Keeps its current role: the only source that reaches the planner without the Pi, and the storm machine's `outageActive`.
- **Failure modes** (all recorded): no start email (2026-10-11); silence for months unnoticed (Mar–Oct 2026, hence
  drift-check [5] and the 2 h silence email); an outage that starts while the feed is silent reads as grid; the restore
  email can precede the ATS retransfer (hence `RESTORE_TAIL_MS` 30 min); the feed describes National Grid's view of the
  area, not this house's transfer switch. It never reaches the Pi.

## 2. The hard interlock

**One fact, three values.** `supply ∈ {grid, generator, unknown}`, computed once per process from whatever sources that
process has, with `unknown` meaning "act as if on the generator". The owner's rule is then one line, applied at the
choke points the code already has. Nothing new learns to switch a breaker.

**Merging sources (planner).** The planner sees the Pi's contact reading in the hub frame (with the Pi's read time, like
`span.house_w` today) and the feed.

- `generator` if **any** fresh source says generator (contact, feed's active outage, feed's 30 min restore tail).
- `grid` only if the contact is **fresh and says grid**; without a contact (not installed, stale, Pi unreachable) the
  feed's existing rule decides, including the owner's 2026-11-01 "silent feed assumes the grid after 6 h".
- otherwise `unknown`.

A contact that says grid while the feed still says outage reads `generator` under this rule. That is deliberately
conservative for the first winter: the cost is a lockout during a reported outage that this house is not in, which is
rare, and the reason is visible in `/health`. Once the contact has one clean season it can be made authoritative.

**Where it is enforced.**

| Choke point | Today | With this design | Fails safe because |
|---|---|---|---|
| Planner gate close: `BackupGate.step` refuses when `generator.allowed` is false (`backupgate.ts`) | feed-only supply | merged supply above | `assess()` already sets `element_allowed = !(supply ≠ grid)`; an absent or stale contact can only move supply toward generator |
| Pi fallback tick and its `_budget_precheck` passed to `BreakerController.execute(..., "close", precheck=)` (`backup_fallback.py`) | 20 kW budget (not the rule) | **supply rule first**: `supply ≠ grid` → refuse with "on the generator: the element is never used there (owner 2026-11-02)" or "supply unknown, treated as the generator". Budget stays computed and reported. | no GPIO configured, a read error, or a stale read all yield `unknown`; the precheck re-reads the input immediately before the POST, with no await between |
| Pi controller: automated closes of "Buffer Tank" from `source` backup-gate or backup-fallback (`span_control.py`) | none | the same one-line supply rule as a controller-level precheck for **automated** sources only | the planner's view of the contact is up to a poll old; the Pi's is 30 s old. This catches a planner close sent in that gap. (This is the useful remainder of the closed #274, with the owner's never-rule instead of a budget.) |
| Human closes (dashboard, 6bb app, panel) | no check, on purpose | unchanged. The dashboard shows `supply` next to the breaker so the person knows. | the owner's rule is about **automatic** closes |

**Config fail-safe.** `backup_fallback.live = true` is refused at config validation unless a contact input is configured
(the same pattern as `self_heal.circuits_verified`). The planner needs no new knob: `BACKUP_GATE=live` already carries
the rule.

**What the interlock does not do.** It prevents closes. A breaker already CLOSED when the grid drops stays closed, and the
HBX can then fire 16.5 kW beside a 5–6 kW pump: 22–24 kW on a 20 kW set, which trips the generator's breaker or stalls it
and leaves the whole house dark. Today that is the `shed` advisory (one email) and residual risk 3 in the shadow doc. The
only real protection is an **automatic OPEN of "Buffer Tank" on transfer to generator**, Pi-local, through the existing
`OpenPermit` path, which needs `span.backup_reopen` and the owner's OK. This note recommends it as phase 3 (section 5);
it is the owner's decision, not built.

## 3. Load budget during an outage

Everything at 240 V, 83 A = 20 kW. `GEN.MARGIN_W` 2.4 kW (10 A) is kept for inrush and unmetered load.

| Load | A | kW | Note |
|---|---|---|---|
| House base, pumps idle | 5 | 1.2 | `power-flows/site`, 2026-10-29 |
| One heat pump heating | 21–24 (p95 25, max 28) | 5.1–5.7 (6.1 / 6.6) | inverter-driven: soft start, little inrush |
| **Both heat pumps** | **~48** (p95 ~51, max ~55) | 10.2–12.2 | never observed together in 90 d; lagT 60 makes it routine in a long call |
| Element | 69 | 16.5 | nameplate |
| EV charger | 30 | 7.2 | the one household load that eats the margin by itself |

**Both pumps plus the house.** 48 A (pumps) + 5 A (base) + 10 A (margin) = **63 A**, leaving **~20 A (~4.8 kW)** for
cooking, well pump, mini-splits and lights at the p50 draw; at the p95 draw about 17 A. That holds through lagT: the
second pump joining at minute 60 is exactly the "both pumps" row, and it fits. **Outage mode does not need to cap at one
pump.** Capping would halve the heat available against the 60 °F floor to protect a margin that the pumps are not the
threat to. What breaks the budget is a large non-heating load (EV charging, resistive cooking) on top of both pumps: the
planner's `one_pump` advisory fires at house + margin > cap (house > 17.6 kW), and shedding that load is 6bb's job (it
switches SPAN breakers; its outage plan lists shedding as phase 3). A2W reports; it does not shed pumps.

**The element has no place.** Element + base = 74 A: fits only while the rest of the house draws ≤ 1.1 kW, which the
measured base already exceeds. Element + one pump = 93 A, over the rating before the house draws anything. This is why
the rule is "never" and not "if it fits".

**Defrost and self-heal on the generator.** A defrosting pump draws in the same range as heating, so the table holds. A
self-heal power cycle (`self_heal.py`) takes one pump off for ≥ 60 s and refuses while the other is down; on the
generator that lowers load, never raises it. No change.

**Propane.** Outage duration is bounded by propane, not by the budget. The tank size and the 20RESA's burn rate near
12 kW are not recorded; add both to the winter drill checklist so the owner knows how many hours both pumps buy.

## 4. Storm pre-charge → outage conserve

**Pre-charge (exists).** `storm.ts` arms on High Wind / Blizzard / Ice Storm Warnings and the recalibrated synthetic
triggers (#115). The window opens 2 h before onset and the plan raises the tank target by +10 °F to the cap
(`stormCeilingF`): DHW resilience and standing-loss coast, explicitly not a space-heat bridge (#114). Pre-heating the
rooms is TempIQ's domain and is not built; the heat pumps keep the rooms at their normal targets.

**The handoff is the supply flip.**

1. Onset − 2 h: storm `armed`, tank charging toward the ceiling. Element breaker OPEN as always.
2. Utility drops. ATS starts the engine and transfers (seconds). The Pi's contact reads `generator` within one 30 s tick;
   the hub frame carries it; the planner sees it within its 5-min poll. The email feed agrees minutes to hours later.
3. **Planner on `supply = generator`:**
   - storm machine takes the merged supply as `outageActive` → `active` at once ("outage-activate"), window ≥ now + 6 h,
     exactly as a feed-reported outage does today;
   - **conserve** = drop the storm ceiling and every optional boost (storm +10 °F, DHW pre-boost, anticipation) and hold
     the **normal curve target**. The pre-charged tank coasts down to the curve, the pumps keep the house at its normal
     room targets (that is what "hold normal targets where possible" means here), and 60 °F stays the hard floor: the
     thermostats hold the rooms, and the planner's comfort check (`comfortRisk`) reports the coldest occupied zone;
   - the element is locked out (section 2); `shed` and `one_pump` report as today.
4. **Pi on `supply = generator`:** fallback refuses any close; self-heal unchanged; the Pi serves the owner's
   dashboard over the LAN as before.
5. Retransfer: the contact flips to `grid`. Keep the 30 min `RESTORE_TAIL` as a debounce (an ATS can retransfer and
   drop again on a flickering utility). After it, the normal plan resumes; storm `active` stands down when its window
   closes, as now.

A generator run with no storm (a tree on the line) follows the same steps from 2. Storm mode is not a prerequisite for
conserve; the supply is.

**What conserve is not.** It does not lower room setpoints, does not hold one pump back, and does not touch the HBX
beyond returning the target to the curve. The owner rejected over-engineering; this is one flag in plan shaping that
says "no boosts while on the generator", and the rest is the plant's normal behaviour.

## 5. Phased rollout

### Phase 0: shadow logging (software, before any hardware)

- Bridge: subscribe to `meter/voltage-a/-b` beside `power-flows/site` and record them with each SPAN poll (record only;
  the v2 session already carries them). Add a `supply` object to `/api/health` and the hub frame:
  `{value: unknown, source: none, read_ts}` until a contact exists.
- Planner: log every merged-supply transition with its sources; keep the `generator_shadow` lockout episodes and
  advisories as they are. Add the one-line supply rule to the Pi fallback **in shadow** so its "would close" notes say
  which rule held it (budget or supply).
- Nothing switches. This phase only makes the next transfer observable.

### Phase 1: what the owner must do physically

1. **ATS aux contact.** Get the quote (approved 2026-11-02). Ask the electrician for: a dry contact that is CLOSED in the
   utility position, a low-voltage run to the Pi's location, and an isolated input module. Record the ATS model, the
   contact used, and its polarity in the bridge config and in this doc.
2. **Generator exercise with transfer** (or the 15-min utility-main test already in the shadow doc), with the Phase 0
   logging running and the element breaker confirmed OPEN beforehand. The owner notes transfer and retransfer times.
   Before the contact is in, this is the voltage measurement of section 1b; after, it is the acceptance test below.
3. Decide phase 3 (auto-OPEN on transfer) with the exercise result in hand.

### Phase 2: build and promote

- Bridge: GPIO read module → `supply` with freshness; fallback applies the supply rule first (shadow, then live only
  with a contact configured); controller precheck for automated Buffer Tank closes; supply persisted so a Pi reboot at
  transfer starts with the last known value until the first read (seconds).
- Planner: merged supply; storm `outageActive` from it; conserve flag in plan shaping.
- Shadow through one real transfer, then the owner's go-live per the promotion list in the shadow doc.

### Phase 3 (owner decision): protect the generator from an already-closed breaker

Pi-local OPEN of "Buffer Tank" on transfer to generator, through `OpenPermit`, needs `span.backup_reopen`. Recommended,
because an overloaded 20 kW set goes dark for the whole house; but it is the one place this design would switch something
off, so it is the owner's call.

### Acceptance tests

| # | Test | Pass |
|---|---|---|
| A1 | Bench: short the input (grid), open it (generator), unplug the module (unknown) | `/api/health.supply` follows within one 30 s tick; unplugged reads `unknown`, never `grid` |
| A2 | Fake panel, every pump down 30 min, `supply = generator` (shadow and live) | fallback records a refusal naming the owner's rule; the fake panel logs **no** relay write |
| A3 | Same with `supply = unknown` | identical to A2 |
| A4 | Same with `supply = grid` | shadow "would close"; live closes, as today |
| A5 | Supply flips to generator between the tick and the POST | `BreakerRefused("precheck: …")`, nothing switched |
| A6 | Planner replay (`generator.test.ts`): contact says generator, feed says grid | gate `generator_lockout`; `/health` supply `generator`, source `ats` |
| A7 | Contact stale + feed silent > 6 h | existing rule: grid, `assumed: true` (unchanged) |
| A8 | Contact fresh grid + feed active outage | `generator` (conservative merge), reason names both sources |
| A9 | Storm machine with supply generator and feed null | `outage-activate` on the next tick; plan shaping shows no storm ceiling and no boosts |
| A10 | Live exercise-with-transfer, element breaker OPEN | dashboard supply flips within 1 min; planner `/health` within one poll; no breaker switched; `grid` 30 min after retransfer; voltage log captured; pumps' faults (P10/R10 AC voltage) noted if any |
| A11 | Config: `backup_fallback.live = true` with no contact configured | bridge refuses the config with a clear message |
| A12 | drift-check | new assertion: supply source is `ats` once configured; existing [5] feed assertion kept |

## Owner decisions this note asks for

- ⬜ Which ATS contact and polarity (with the electrician); recommendation: utility-position CLOSED, pull-up, isolated.
- ⬜ Run the next generator exercise **with** transfer, with logging on. Recommendation: yes, once, then quarterly.
- ⬜ Phase 3 auto-OPEN of "Buffer Tank" on transfer. Recommendation: yes, after one clean transfer in shadow.
- ⬜ Keep human closes outside the interlock (as today). Recommendation: yes; show `supply` beside the breaker instead.
- ⬜ Edit #241's body: 83 A / 20 kW, element never.
