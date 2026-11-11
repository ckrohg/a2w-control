# Generator-aware outage mode (#241) — SHADOW

**Status (2026-11-02):** built in shadow. The planner's backup gate never closes the element breaker on the generator or
an unknown supply. The Pi's cloud-free fallback applies a 20 kW budget, which does **not** enforce that rule (see "The Pi
fallback"). Nothing is switched by this work; going live is the owner's call (see "Promotion" below).

## Owner requirements (2026-10-29, revised 2026-11-02)

- An **automatic whole-house transfer switch** (ATS), upstream of the SPAN panel, puts the house on a generator in an
  outage. The panel probably cannot tell.
- **The generator (owner, 2026-11-02):** a **Kohler 20RESA on propane, rated 20 kW / 83 A at 240 V**. The earlier
  assumption of ~100 A / ~24 kW was wrong.
- **The 16.5 kW element NEVER closes automatically on the generator** (owner, 2026-11-02). An unknown supply counts as
  the generator. This replaces the 2026-10-29 rule ("last resort: only when the house is getting cold AND the load
  leaves room").
- **Comfort:** **60 °F indoors is a hard floor** ("my mom will NOT be happy if she gets cold"). All occupied zones count:
  any zone with a heating call, and the coldest drives the decision. On the generator the heat comes from **both heat
  pumps (about 2 × 5.1 kW = 10.2 kW) plus the house load**, and from a **tank pre-charged** before the outage.
- Storm mode pre-charges before a storm so the house can conserve during the outage.

## What fits on 20 kW (measured)

| Load | Draw | Source |
|---|---|---|
| Whole house, pumps idle | **1.2 kW** | SPAN `power-flows/site`, 2026-10-29 (span-v2 capture, read-only) |
| Heat pump heating | **p50 5.1 kW, p95 6.1 kW, max 6.6 kW** (owner: about 5.1 kW each) | `span_readings` Jul 31 – Oct 29, 17.7k samples |
| Both pumps at once | **never happened** in 90 days | same data: no sample with both > 1 kW |
| Element | 16.5 kW (nameplate) | owner. It never drew in the window: the breaker was kept OPEN |
| Pump idle | ~8 W | `span_readings`, Oct 15 incident |

The budget is `house load + 16.5 kW + 2.4 kW margin ≤ 20 kW`, so the element would fit only while the rest of the house
draws at most **1.1 kW**. The measured base load alone (1.2 kW) already exceeds that.

| Situation on the generator | Total with the element | Budget | Element (planner) |
|---|---|---|---|
| Both pumps down, base load 1.2 kW | 20.1 kW | over | never |
| One pump heating + base (today's lagT 60 adds the 2nd pump after 60 min) | 25.2 kW | over | never |
| Both pumps down + EV charger (7.2 kW) | 27.3 kW | over | never |
| Both pumps heating, no element | 10.2 kW + base ≈ 11.4 kW | fits (8.6 kW spare) | — |

So on the generator the element has no place: the budget is reported, but **the outage heat is both heat pumps (about
10.2 kW) plus house load, and the pre-charged tank**. Both pumps running always fit.

## Detecting "on generator" — what can and cannot be seen

**One real outage is in the data: 2026-10-11.** National Grid's restored email says power returned at 8:22 PM ET; the
outage-start email never reached 6bb, so its start time and the feed's start latency are unknown. What A2W recorded:

- **The house internet stayed up on the generator.** SensorLinx (the HBX, via the cloud) answered every 5-min poll from
  14:30 to 22:40 with no gap. This agrees with 6bb's note that the generator keeps the SPAN panel and the internet up. So
  the planner, the hub and the 6bb feed normally all keep working during an outage.
- **The Pi saw nothing useful.** It lost its LAN from 16:07 to 22:10 (both W610 gateways "never responded", no SPAN
  reads). That window sits exactly on the Pi's Wi-Fi watchdog cadence (boots 16:06 and 22:10, about every 6 h Oct 7–11;
  33 reboots in 90 days). It cannot be attributed to the outage. The Pi did **not** reboot at 20:22 (uptime continuous),
  so either the retransfer did not interrupt its power or the Pi rides through short interruptions. A Pi reboot is
  therefore not an outage signal.

Candidate signals:

| Signal | Can it tell generator from grid? | State |
|---|---|---|
| 6bb National Grid email feed (`OUTAGEWATCH_URL`) | Yes, after a delay | **Used.** Start latency unmeasured (0 of 1 outages had a start email). Restore notice: one data point. 6bb's outage history now records `noticeLagMin` per outage; read it after the next outage. |
| SPAN v1 `/api/v1/circuits` (what the bridge reads) | No: per-circuit power and relay only | Gives the **house load** (sum of circuits), which the budget needs. |
| SPAN v1 `/api/v1/panel` (`dsmGridState`, `currentRunConfig`) | Probably not: these track SPAN's own islanding (SPAN battery), and the ATS is upstream | Unverified. v1 is removed 2026-12-31 (#199). |
| SPAN v2 MQTT (`meter/voltage-a/-b`, `power-flows/site`, upstream lugs `current-a/-b`) | Voltage only, and only if the generator regulates measurably differently. **No frequency.** | Captured once on the grid (119.6 / 119.0 V). No generator sample exists. |
| Heat pumps' AC input voltage (Modbus 2067/2077, read in diagnostics) | Same voltage-only limit | Reads 231 V now. Only the latest snapshot is kept, so there is no history. |
| ATS auxiliary contact / generator "running" dry contact → Pi GPIO | **Yes, instantly, locally** | Hardware. The only direct signal. **Recommended.** |

**Conclusion:** there is no measured local signal today. The supply decision uses the email feed. A silent feed is
treated as the generator only while an outage is plausible; otherwise the grid is assumed (owner 2026-11-01, below).

## The rule (planner: `planner/src/generator.ts` + `backupgate.ts`)

- **Supply:**
  - **generator:** the feed reports an outage, or reported one < 30 min ago (an ATS waits before retransfer, and the
    restored email can come first);
  - **grid:** a fresh (≤ 15 min) "no outage" answer;
  - **feed silent** (unreachable, stale, or no answer since the planner started):
    - **unknown, treated as the generator,** if the last answer was an active outage, an outage was seen < 6 h ago,
      or the planner started < 30 min ago and the feed has not answered yet;
    - otherwise **grid, assumed**: `assumed: true` in the supply and in /health `generator.feed`, with a why such as
      "the outage feed has not answered for N min; assuming the grid (no outage seen in the last 6 h)".
- **On the generator or unknown, the gate never closes the element** (owner, 2026-11-02), whatever the budget and
  comfort say. `element_allowed` is false, with `element_why` "on the generator: the element is never used there
  (owner, 2026-11-02)" or "the supply is unknown, so it is treated as the generator: …". On the grid, and on an assumed
  grid, nothing changes. Budget and comfort are still computed and shown in /health `generator`, and drive the
  advisories:
  - **budget:** house load (every SPAN circuit except the element's, from a fresh Pi panel read) + 16.5 kW + margin ≤
    cap. An unknown load fails.
  - **comfort:** whether the house is getting cold, judged over **every occupied zone** (owner: "all occupied zones"):
    - **occupied:** a zone with a heating call, or with a setpoint whose thermostat mode is not OFF. A thermostat set
      back or satisfied still counts.
    - **never counted:**
      - an OFF Nest (no setpoint: the baseboard and dining comfort-only zones);
      - DHW;
      - `COMFORT_EXCLUDE_ZONES`. The default is the barn: "Barn - Tack" read exactly 59 °F in 344 of 344 samples (a
        stuck sensor), and "Barn Basement" is held at 55.4 °F.
    - **at risk** when any occupied zone is < 62 °F (2 °F above the floor), or ≥ 4 °F below its own setpoint (owner 2026-11-04; it was 2 °F, which the bathrooms alone tripped in 47 % of
      hydronic hours Oct 30 – Nov 2).
    - **unknown** when an occupied zone has no temperature, or a stale one. TempIQ's payload has no per-zone reading
      time, so a reading unchanged for 6 h counts as stale. Such a zone is never silently dropped.

  Under the 2026-10-29 rule unknown comfort counted as at risk. Since 2026-11-02 comfort is reported only: no verdict
  lets the element close on the generator.

  **Measured, Oct 15–29 (367 hourly zone snapshots): by this measure the house is "getting cold" 100 % of the time.**
  - Den / Office and Xmas Room are mini-splits that sit at a median 57 °F and 56 °F against 70.7 °F setpoints.
  - Excluding them too still leaves 84 % at risk, 15 % unknown and 1 % not at risk: mini-split bedrooms sit under their
    setpoints.
  - The hydronic zones alone (the only rooms the element can heat) give 9 % at risk, 8 % unknown and 83 % not at risk.

  That is one reason the old "last resort if cold" rule could not tell a real emergency from an ordinary day. Which
  zones count is still the owner's call (`COMFORT_EXCLUDE_ZONES`); it now only changes what /health reports. The gate's
  own rules (a pump failed and the tank is not recovering, or every pump runs and the tank stays under 100 °F) still
  decide whether it wants the element at all. The generator rule only refuses.
- **Advisories (/health, dashboard, log; never acted on):**
  - `shed`: the breaker is ON while on the generator (or unknown) without headroom, or with the house load unknown, so
    the HBX could fire the element at any moment. On 20 kW that is any house load above 1.1 kW, so in practice a breaker
    left ON in an outage.
  - `one_pump`: both pumps run with the house within the margin of the cap.
- **Knobs:** `GEN_CAP_KW` (default 20, range 15–40) and `GEN_MARGIN_KW` (default 2.4) on the planner.
- **Notices:** alert episode `generator_shadow` (`generator` once `BACKUP_GATE=live`), tier attention, so **one email
  per episode**. An episode left open under the other kind is closed at restart, and the watch re-opens it if it still
  holds:
  - `lockout`: the gate wanted the element and the generator rule refused (on the generator, always);
  - `shed`: as above.

## The Pi fallback (`heatpump-bridge/bridge/backup_fallback.py`)

- **No outage information reaches the Pi, so it always applies the budget.** Its condition is every pump down for
  30 min.
- **It cannot enforce "never on the generator".** The Pi cannot tell the grid from the generator, and no new signal path
  is built. With the 20 kW cap and 2.4 kW margin it closes only when the rest of the house draws **at most 1.1 kW**:
  - on the generator it **can still close** at a very low house load, against the owner's rule;
  - on the grid it **will usually refuse** (the measured base load is 1.2 kW), so the fallback rarely helps there.
  The notice tells the owner to switch the breaker ON themselves if the house is on the grid. This is why
  `backup_fallback.live` is a pre-live blocker (below).
- **Unknown load = no close.** When a circuit has no power reading, the v2 panel-level site power (`power-flows/site`,
  less the element's draw) stands in for the sum, unless it reads below what the other circuits already add up to, which
  contradicts them. With neither, the refusal names the circuit, because the fix is at the panel and not on the Pi's
  network. No generator sample of `power-flows/site` exists yet; the ATS is upstream of the panel, so it should read the
  same on either supply.
- **Re-checks:** a refused episode is re-checked every 30 s and noted once per hold. A hold after the load fitted is a
  new one and is noted again, at most every 5 min. In shadow that note is record-only (as every shadow fallback notice);
  live, it is a page.
- **At the close:** the 30 s tick can judge a panel read up to 120 s old, so the close re-runs the budget on the
  controller's fresh read, by the same rule: over budget or unknown holds it for the next tick.
- **The Pi's budget binds only its own fallback close.** A close from the dashboard or a person has no budget check, on
  purpose. Neither does the planner gate's close: the Pi can't tell the grid from the generator, and on the grid the
  gate's normal winter close (every pump running) would fail the budget. On the generator or an unknown supply the
  planner sends no close at all (owner, 2026-11-02), so no panel read decides one. A Pi-side re-check for the gate's
  close, in case that rule is ever relaxed, is on the closed #274 (`claude/gate-close-generator-budget`).
- **Knobs:** `backup_fallback.generator_cap_w` (20000), `generator_margin_w` (2400), `element_w` (16500).
- **House load source:** the bridge now computes `house_w` from each `/circuits` read and puts it in the hub frame
  (`span.house_w`). The planner's budget and `shed` advisory need it; the planner's element decision on the generator
  does not (it is always no). On the grid nothing changes.

## Heat-pump staging under the budget

Both pumps (about 10.2 kW at p50, 12.2 kW at p95) plus a normal house is about 11.4–13.4 kW, well under the 20 kW cap
less the margin (17.6 kW), so holding to one pump is never the first lever. A load that would push two pumps over the
cap is something else (EV charger, mini-splits, cooking). **Shedding that load is
6bb's job** (it switches SPAN breakers; its outage plan lists shedding as phase 3). A2W only reports `one_pump` as an
advisory.

## Storm pre-charge

Storm mode raises the tank +10 °F before onset (owner 2026-09-25). That buys about 12.8 h of standing-loss coast and
DHW resilience, explicitly **not** a space-heat bridge (#114). On the generator the pumps keep running (they fit) and the
element never does, so the pre-charged tank and both pumps are the whole outage heat. Pre-heating the house itself (raising zone setpoints before onset) is TempIQ's
domain and is not built.

## Pre-live gaps (owner decision before going live; not built)

- **BLOCKER: `backup_fallback.live` must not be set until the Pi has a real generator signal.** The Pi cannot tell the
  grid from the generator, so its 20 kW budget can still close the element on the generator at a very low house load
  (≤ 1.1 kW), against the owner's rule, and refuses on the grid most of the time (see "The Pi fallback"). The signal is
  the transfer switch's auxiliary contact wired to a Pi input; the owner approved getting a quote on 2026-11-02. Until it
  is installed and read by the Pi, the fallback stays in shadow.
- **Nothing re-checks the budget once the breaker is ON.**
  - A breaker closed on the grid (by the gate, the Pi or a person) stays ON when the generator takes over.
  - The planner only *reports* it (`shed`, one email).
  - Nothing re-opens it, and the Pi can only close.
  - Automatic shedding needs an OPEN on the generator: either `BACKUP_GATE_REOPEN=1` plus `span.backup_reopen` with a
    generator trigger, or 6bb's shedding.
- **~~A stale outage feed blocks the element on the grid too.~~ Resolved (owner decision 2026-11-01).**
  - The gap: unknown supply was treated as the generator, and in normal winter use the floor rule fires only while
    every available pump runs (at least 5.1 kW of house), so the budget fails. A feed silent for more than 15 min would
    have kept the gate from closing the element on the grid. The previous feed (OutageWatch) was dead from 2026-03-15 to
    2026-10-29 unnoticed: under that rule, the whole season.
  - **The rule now:** a silent feed assumes the grid (flagged `assumed`) unless the last answer was an active outage,
    an outage was seen < 6 h ago (`GEN.SILENT_OUTAGE_RECENT_MS`), or the planner started < 30 min ago with no answer yet
    (`GEN.FEED_STARTUP_GRACE_MS`; every deploy restarts the planner). A fresh answer is used as before.
  - **Remaining risk:** an outage that starts while the feed is silent leaves the planner gate believing it is on the
    grid, so for that window the planner gate does not apply the generator rule. Like the email-lag window (Residual
    risk 1), this needs a gate episode to reach its close while the house is on the generator. The Pi fallback has no
    outage input and always applies its budget check, which is not the never-on-the-generator rule (blocker above).
  - drift-check [5] asserts the feed daily (#242) from `/health.backup_gate.generator.feed`: red when `last_answer_at` is
    null or over 2 h old, when `last_failure` is set, or when the field is missing; `assumed: true` in /health shows
    when the grid is a guess.
  - **Silence reaches the owner (#252 review):** a feed silent for 2 h sends one email (`outage-feed-silent`, attention)
    naming the failure, whichever way the supply reads. A planner restart restarts that 2 h clock.
  - **A restart keeps the outage (#252 review):** the feed's last answer and last outage live in `outage_feed_memory`, so
    a deploy mid-outage does not read a silent feed as the grid.
- **The feed's latency at outage start has never been measured** (see Detection).

## Residual risks (owner should know)

1. **The email-lag window.** In the first minutes of an outage, before National Grid's email arrives, the planner
   believes the grid.
   - In shadow this changes nothing.
   - Live, a gate episode already 85 min into its 90-min hold could close the element on the generator in that window.
     The breaker is OPEN by default, so this needs a real double failure.
   - The fix is the ATS aux contact.
2. **A pump coming back while the element is ON.**
   - self-heal power-cycles E21 pumps, so a "down" pump can restart.
   - Pump (5.1–6.1 kW) + element + base is 22.8–23.8 kW: over the 20 kW rating.
   - The planner's `shed` advisory would see it.
   - The Pi cannot open anything (close-only).
3. **The breaker left ON going into an outage.** Nothing switches it off automatically; `shed` reports it. With
   16.5 kW of element on a 20 kW generator, the HBX firing it beside any pump overloads the generator.
4. **Loads not on a SPAN circuit** are not in `house_w` (none known). SPAN v2's `power-flows/site` would include them;
   switch the source when #199's v2 transport is live.

## Promotion: owner decisions

- **Decide the defaults:**
  - ~~the cap: 24 kW, or the generator's real continuous rating~~ decided 2026-11-02: 20 kW, the Kohler 20RESA's
    rating on propane (83 A at 240 V);
  - ~~the element on the generator: last resort if the budget fits and the house is cold~~ decided 2026-11-02: never
    automatically; an unknown supply counts as the generator;
  - the 2.4 kW margin;
  - ~~unknown supply → generator~~ decided 2026-11-01: a silent feed assumes the grid unless an outage is plausible
    (above);
  - ~~unknown comfort → at risk~~ moot since 2026-11-02 (comfort no longer decides the element on the generator);
  - which zones count for comfort (`COMFORT_EXCLUDE_ZONES`; the mini-split rooms?), now for /health reporting only;
  - the pre-live gaps above.
- **Install the ATS aux contact** into a Pi input (owner approved getting a quote, 2026-11-02). It is the pre-live
  blocker for `backup_fallback.live`, and would replace the email feed as the supply input.
- **Do a transfer test:** throw the utility main for 15 min while the Pi logs SPAN v2 voltage/site power and the pumps'
  AC voltage every 5 s. That measures what the panel actually sees on the generator.
- **Go live:** `BACKUP_GATE=live` (planner) already carries the never-on-the-generator rule. `backup_fallback.live` (Pi)
  does not, and stays off until the aux contact is in (blocker above). A `shed` that actually opens the breaker would
  also need `BACKUP_GATE_REOPEN=1` and `span.backup_reopen`.
