# Generator-aware outage mode (#241) — SHADOW

**Status (2026-10-29):** built in shadow. The planner's backup gate and the Pi's cloud-free fallback both refuse to close
the element breaker when the generator budget says no. Nothing is switched by this work; going live is the owner's call
(see "Promotion" below).

## Owner requirements (2026-10-29)

- An **automatic whole-house transfer switch** (ATS), upstream of the SPAN panel, puts the house on a generator in an
  outage. The panel probably cannot tell.
- **Budget:** about **100 A at 240 V (~24 kW)** for the whole house.
- The **16.5 kW element is a last resort** on the generator: only when the house is getting cold AND the load leaves room.
- **Comfort:** hold targets where the budget allows. **60 °F indoors is a hard floor** ("my mom will NOT be happy if she
  gets cold"). All occupied zones count: any zone with a heating call, and the coldest drives the decision.
- Storm mode pre-charges before a storm so the house can conserve during the outage.

## What fits on 24 kW (measured)

| Load | Draw | Source |
|---|---|---|
| Whole house, pumps idle | **1.2 kW** | SPAN `power-flows/site`, 2026-10-29 (span-v2 capture, read-only) |
| Heat pump heating | **p50 5.1 kW, p95 6.1 kW, max 6.6 kW** | `span_readings` Jul 31 – Oct 29, 17.7k samples |
| Both pumps at once | **never happened** in 90 days | same data: no sample with both > 1 kW |
| Element | 16.5 kW (nameplate) | owner. It never drew in the window: the breaker was kept OPEN |
| Pump idle | ~8 W | `span_readings`, Oct 15 incident |

The rule is `house load + 16.5 kW + 2.4 kW margin ≤ 24 kW`, so the house may draw at most **5.1 kW** before the element
is refused.

| Situation on the generator | Total with the element | Element? |
|---|---|---|
| Both pumps down, base load 1.2 kW | 20.1 kW | **fits** |
| One pump heating + base (today's lagT 60 adds the 2nd pump after 60 min) | 25.2 kW | refused |
| Both pumps down + EV charger (7.2 kW) | 27.3 kW | refused |
| Both pumps heating, no element | 11.4 kW + base | fits easily |

So on the generator the element is in practice **for "both heat pumps are down" only**. The pumps themselves (both, at
11.4 kW) always fit; the element on top of even one running pump does not. Both pumps running is the generator's best
heat source.

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

**Conclusion:** there is no measured local signal today. The supply decision uses the email feed, and anything uncertain
is treated as the generator.

## The rule (planner: `planner/src/generator.ts` + `backupgate.ts`)

- **Supply:**
  - **generator:** the feed reports an outage, or reported one < 30 min ago (an ATS waits before retransfer, and the
    restored email can come first);
  - **grid:** a fresh (≤ 15 min) "no outage" answer;
  - **unknown:** the feed is unreachable, stale or has not answered since the planner started. **Treated as the
    generator.**
- **On the generator or unknown, the gate may close the element only if both hold:**
  - **budget:** house load (every SPAN circuit except the element's, from a fresh Pi panel read) + 16.5 kW + margin ≤
    cap. An unknown load fails.
  - **comfort:** the house is getting cold, judged over **every occupied zone** (owner: "all occupied zones"):
    - **occupied:** a zone with a heating call, or with a setpoint whose thermostat mode is not OFF. A thermostat set
      back or satisfied still counts.
    - **never counted:**
      - an OFF Nest (no setpoint: the baseboard and dining comfort-only zones);
      - DHW;
      - `COMFORT_EXCLUDE_ZONES`. The default is the barn: "Barn - Tack" read exactly 59 °F in 344 of 344 samples (a
        stuck sensor), and "Barn Basement" is held at 55.4 °F.
    - **at risk** when any occupied zone is < 62 °F (2 °F above the floor), or ≥ 2 °F below its own setpoint.
    - **unknown** when an occupied zone has no temperature, or a stale one. TempIQ's payload has no per-zone reading
      time, so a reading unchanged for 6 h counts as stale. Such a zone is never silently dropped.

  **Unknown comfort counts as at risk** (TempIQ down must not leave her cold; the budget still binds).

  **Measured, Oct 15–29 (367 hourly zone snapshots): under this rule the house is "getting cold" 100 % of the time.**
  - Den / Office and Xmas Room are mini-splits that sit at a median 57 °F and 56 °F against 70.7 °F setpoints.
  - Excluding them too still leaves 84 % at risk, 15 % unknown and 1 % not at risk: mini-split bedrooms sit under their
    setpoints.
  - The hydronic zones alone (the only rooms the element can heat) give 9 % at risk, 8 % unknown and 83 % not at risk.

  So on the generator the **budget is the check that actually binds**, and "last resort" rests on it. Whether the
  mini-split rooms belong in the comfort set is the owner's call: set `COMFORT_EXCLUDE_ZONES`. The gate's own
  rules (a pump failed and the tank is not recovering, or every pump runs and the tank stays under 100 °F) still decide
  whether it wants the element at all. The generator rule only refuses.
- **Advisories (/health, dashboard, log; never acted on):**
  - `shed`: the breaker is ON while on the generator without headroom, so the HBX could fire the element at any moment.
  - `one_pump`: both pumps run with the house within the margin of the cap.
- **Knobs:** `GEN_CAP_KW` (default 24) and `GEN_MARGIN_KW` (default 2.4) on the planner.
- **Notices:** alert episode `generator_shadow`, tier attention, so **one email per episode**:
  - `lockout`: the gate wanted the element and the generator rule refused;
  - `shed`: as above.

## The Pi fallback (`heatpump-bridge/bridge/backup_fallback.py`)

- **No outage information reaches the Pi, so it always applies the budget.** Its condition is every pump down for
  30 min. Then the pumps draw almost nothing, so a normal house fits and the close goes ahead.
- **What it refuses:** the element on top of an EV charger or mini-splits running hard.
  - On the generator that refusal prevents an overload. Tripping the generator would black out the whole house,
    mini-splits included.
  - On the grid that same load is mostly heat already being made (the mini-splits). The notice tells the owner to switch
    the breaker ON themselves if the house is on the grid.
- **Unknown load = no close.**
- **Re-checks:** a refused episode is re-checked every 30 s and noted once. In shadow that note is record-only (as every
  shadow fallback notice); live, it is a page.
- **Knobs:** `backup_fallback.generator_cap_w` (24000), `generator_margin_w` (2400), `element_w` (16500).
- **House load source:** the bridge now computes `house_w` from each `/circuits` read and puts it in the hub frame
  (`span.house_w`). Until the bridge release carrying this lands, the planner sees no house load. On the generator or
  with an unknown supply it then locks the element out. On the grid nothing changes.

## Heat-pump staging under the budget

Both pumps plus a normal house is about 12.6 kW, about half the cap, so holding to one pump is never the first lever. A
load that would push two pumps over the cap is something else (EV charger, mini-splits, cooking). **Shedding that load is
6bb's job** (it switches SPAN breakers; its outage plan lists shedding as phase 3). A2W only reports `one_pump` as an
advisory.

## Storm pre-charge

Storm mode raises the tank +10 °F before onset (owner 2026-09-25). That buys about 12.8 h of standing-loss coast and
DHW resilience, explicitly **not** a space-heat bridge (#114). On the generator the pumps keep running (they fit), so the
pre-charge is headroom, not survival. Pre-heating the house itself (raising zone setpoints before onset) is TempIQ's
domain and is not built.

## Pre-live gaps (owner decision before going live; not built)

- **Nothing re-checks the budget once the breaker is ON.**
  - A breaker closed on the grid (by the gate, the Pi or a person) stays ON when the generator takes over.
  - The planner only *reports* it (`shed`, one email).
  - Nothing re-opens it, and the Pi can only close.
  - Automatic shedding needs an OPEN on the generator: either `BACKUP_GATE_REOPEN=1` plus `span.backup_reopen` with a
    generator trigger, or 6bb's shedding.
- **A stale outage feed blocks the element on the grid too.**
  - Unknown supply is treated as the generator. In normal winter use the floor rule fires only while every available
    pump runs: at least 5.1 kW of house, so the budget fails.
  - So if 6bb's feed is silent for more than 15 min, the backup gate cannot close the element even on the grid.
  - How often that happens is **not knowable from A2W's data**: the planner never persisted feed answers, and this feed
    went live on 2026-10-29.
  - The precedent is bad: the previous feed (OutageWatch) was dead from 2026-03-15 to 2026-10-29 unnoticed, which
    under this rule would have meant the whole season.
  - drift-check [5] now asserts the feed daily (#242).
  - Options: trust the last "no outage" answer for hours instead of 15 min, or treat unknown as the grid unless an
    outage was seen recently.
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
   - Pump (5.1–6.1 kW) + element + base is 22.8–23.8 kW: right at the cap, using up most of the 2.4 kW margin.
   - The planner's `shed` advisory would see it.
   - The Pi cannot open anything (close-only).
3. **The breaker left ON going into an outage.** Nothing switches it off automatically; `shed` reports it.
4. **Loads not on a SPAN circuit** are not in `house_w` (none known). SPAN v2's `power-flows/site` would include them;
   switch the source when #199's v2 transport is live.

## Promotion: owner decisions

- **Decide the defaults:**
  - the cap: 24 kW, or the generator's real continuous rating;
  - the 2.4 kW margin;
  - unknown supply → generator, given the stale-feed gap above;
  - unknown comfort → at risk;
  - which zones count for comfort (`COMFORT_EXCLUDE_ZONES`; the mini-split rooms?);
  - the pre-live gaps above.
- **Install the ATS aux contact** into a Pi GPIO. That would replace the email feed as the supply input.
- **Do a transfer test:** throw the utility main for 15 min while the Pi logs SPAN v2 voltage/site power and the pumps'
  AC voltage every 5 s. That measures what the panel actually sees on the generator.
- **Go live:** `BACKUP_GATE=live` (planner) and `backup_fallback.live` (Pi) already carry the generator rule. A `shed`
  that actually opens the breaker would also need `BACKUP_GATE_REOPEN=1` and `span.backup_reopen`.
