# Incident investigation — HP2 E21, no heat, Oct 14–16 2026

Investigates `Downloads/a2w-failure-report-2026-10-16.md` (owner report, cold shower Oct 16 ~12:40 AM ET).
Method: planner logs for the whole window (Railway deployment `7182eed4`, Oct 14 05:00Z → Oct 16 09:00Z,
2261 lines, full 5-minute coverage), hub logs, the code paths each failure touches, the HBX config,
and live endpoints. **No production database query was run**, so per-pump state history, fault events
and the unserved-call episode table are not yet read — §5 says how to close that.

All times Eastern unless marked Z (UTC = ET + 4 h).

## 1 · Bottom line

The report is right that every layer detected something and nothing restored heat. The investigation
changes the picture in three places:

1. **Stage 1 stayed off because of the HBX's own staging config, not a config change that night.** Lead/lag
   rotation is ON (`rotTi` 1; stage hours 3256 vs 3267 confirm it) and the lag-stage timer `lagT` was raised
   **60 → 180 min on Aug 7** to keep the element out of shower sags (#132). With HP2 in the lead and not
   producing heat, the HBX holds the stage-2 call and waits **three hours of continuous call** before it adds
   HP1. HP1's water at 48 °F at 12:42 AM shows it had not run for hours. The HBX has no idea HP2 is faulted
   (dry-contact staging), so this is exactly what it is configured to do.
2. **The "HBX config changed at 12:00 AM" banner was noise.** The only field that changed was `dmd`
   (9 → 41 at 04:00:50Z, back at 05:10Z). It flipped nine times in two days (1 ↔ 9 ↔ 41). It behaves like a
   live demand bitmask, but `planner/src/drift.ts` lists it as a configuration field, so every flip raises a
   "config changed" event. Nothing about staging, the curve or the stage timers changed.
3. **The Pi restart at 4:38 PM Oct 15 was the self-heal watchdog working.** The Pi lost the hub from 18:35Z
   to ~20:40Z (125 min). `bridge-watchdog.sh` reboots the Pi after 120 min with both gateways unreachable;
   your uptime reading (8 h 16 m at 12:54 AM → boot 20:38Z) lands on that minute. Same pattern Oct 14
   15:15–17:20Z (130 min). This confirms the wave-plan hypothesis: **the Pi's WiFi stalls and only a reboot
   recovers it** (eval-2026-10-18 F1, #165, #76).

The planner's 60 → 52 °C setpoint drop at 12:35 AM did not make anything worse (§3, F2). The real
software gaps are an alarm that cannot see a one-unit failure, a boost UI that is a preview, two dashboard
indicators that report the opposite of reality, and no automated recovery action at all.

## 2 · The report's facts, checked

| Report says | Verified | Evidence |
|---|---|---|
| HP2 E21 from Oct 14 02:17 AM | consistent | 06:00–06:05Z Oct 14 the Pi lost the hub and **both** gateways were unreachable (`cannot connect to 192.168.184.140:8899`, pump2 timeout) — E21 appeared 12 min later. Aug 6's E21 also followed a comm wedge. |
| E21 means HP2 produced no heat for 46 h | **not established** | E21 is wall-controller ↔ board comms; a previous E21 "lived 2 weeks" while the unit kept heating (poller.py comment). When HP2 actually stopped making heat needs the per-pump `state` history (§5). |
| HBX config changed 12:00 AM | **noise** | `dmd: 9 -> 41` only (§1.2). |
| Planner lowered setpoints during the deficit | true, not causal | 60 °C at 12:25 was Phase B leading a 135 °F plan block; at the :35 replan the block dropped to 120 °F → 52 °C (= 120 + 5 °F margin). Neither pump was running, and an HP far below its setpoint runs flat out at 126 °F or 140 °F alike. |
| Backup tier disabled, shown green | true | Home card text is static "breaker off, settings clean" whenever `backup_called` was 0 for 7 days (`app/page.tsx:228`). It never reads the breaker. `bkLag` 230 min. |
| Boost buttons are previews | true | `optimize-client.tsx`: "Boost card … PREVIEW ONLY". A real planner boost route exists (`/api/planner/boost` → `/api/hbx/boost`); PR #130 wiring it is a **draft since Sep 27**. |
| Storm mode armed since Sep 27, 4 events open | **dashboard bug** | Planner `/health.storm` is `idle`. The banner shows any `storm_events` row with `ended_at IS NULL`. Each arming inserts a row; stand-down closes only `max(id)`, and only on an in-memory transition — a planner restart while armed (there were 17 deploys Sep 27–Oct 1) leaves rows open forever. |
| Pi restarted 4:38 PM Oct 15 | true, by design | §1.3. |
| SPAN unreachable | corroborated | planner `[spanwatch] tick failed: fetch failed` 23:43Z Oct 15 (SPAN **cloud**). Whether the panel's **local** API answered the Pi is in the mirror's `span_readings` (§5). |
| HP2 7 W vs SPAN 108 W | expected | Modbus power = registers 2063 + 2088, inverter compressors only; the circuit also feeds the fixed compressor, fan, circulator and controls (register map §telemetry). |
| Curve 120 @ 33 °F → 118 @ 125 °F | intended | 125 °F is the as-found WWSD (`permHD`=1, heats year-round for DHW); the planner never moves it. The near-flat shape is the demand-shaped curve with learned demand ≤ 121 °F. |
| Upstairs Bathroom binds on an unverified emitter | true | `[demand] … UNVERIFIED delivery_type` throughout; #134 / Wave 0 (#175). |

## 3 · Failures — cause and fix

**F1 · HP2 E21 (trigger).** Recurs, cleared by power cycle, and twice now follows a comm/power disturbance on
the gateway side. Hypotheses, in order: (a) a supply or ground disturbance at the enclosure (one RS-15-12
powers both gateway chains; CN22 pin 2 GND is landed on HP2's board), (b) HP2's board itself — its CN22 was
once "dead at the board" (plan §5.4). Diagnose with the per-pump fault history against Pi/gateway outages;
check the enclosure supply when on site. Not a software fix.

**F2 · No failover to HP1 (core).** Cause is §1.1: rotation ON + `lagT` 180. Fix is an **owner app change**
(the planner must not write staging — invariant I6): turn rotation off with **HP1 fixed lead** (plan §5.4
already recommends this), and/or bring `lagT` back toward 60 for winter (#132's open decision). Software
side: the planner cannot add a stage, but it can (i) detect "stage N called, pump N not heating" and page
within minutes, (ii) escalate the levers it has (SPAN element close, see F3/F4).

**F3 · Backup tier off and shown green.** Two parts. (a) The card must read the element breaker state (the
bridge already logs the "Buffer Tank" circuit relay via SPAN local) and show red when the last tier is
unavailable. (b) The SPAN **arm** feature (close-only on the element breaker, spec `span-backup-arm-spec.md`)
is built and running in **shadow** (`arm_live=false`). Arming it means: owner sets intent ARMED, A2W closes
the element breaker when the ladder needs it, HBX `bkLag`/`bkDif` still decide whether it fires. Owner decision.

**F4 · No self-healing power cycle.** Needs a **new capability**: opening a heat-pump circuit. Today's SPAN
code is deliberately CLOSE-ONLY ("the safety keystone"). A power-cycle path must: target only the
"Air-Water 1/2" circuits, require an active fault or a sustained stage-called-no-heat, never during defrost
or within anti-short-cycle, off 3–5 min, at most 2 attempts per 6 h, close in a `finally`, verify recovery
(fault clear + outlet rising + power up), audit and page every step, and fall back to a manual instruction.
Owner decision on relaxing close-only for these two circuits only.

**F5 · SPAN unreachable.** Cloud path failed (logged). Use the **local** API for any safety action (the bridge
already talks to it with auto re-registration), add a SPAN-local heartbeat to `/health` and the drift-check,
and confirm "Air-Water 2" is user-controllable in the SPAN app.

**F6 · Comfort override is a stub with false confirmation.** The write path exists. Fix: merge/finish PR #130
(custom boost through the real route), wire the presets to it, show confirmation from read-back
(commanded vs operative target, which pumps are heating), and render any unwired control disabled. A
"Heat now, any cost" action = boost to `strictCapF` for N hours + Phase B leads + element arm (F3) + self-heal
(F4) for a faulted unit. Hot-water estimates must start from the current tank.

**F7 · Storm banner stale.** Close every open row on stand-down (not just `max(id)`), close stale rows on
planner start when `/health.storm` is idle, show the date, and drive the banner from `/health.storm` rather
than the table.

**Alerting.** Three paths should have reached you; none leaves a log line on success, so your inbox is the
evidence:
- **Oct 14 ~2:17 AM** — Pi email "⚠ Heat Pump 2: E21" (every warning-level fault emails since Aug 6).
- **Oct 16 ~12:xx AM** — planner "⚠ Heat call active but NO pump is running" (10 min of stage call with no
  pump heating) and "⚠ DHW comfort shortfall" (tank < 113 °F for 20 min). Both high priority, which emails.
The design gap regardless: the unserved-call check passes if **any** pump is heating, so a single-unit
failure while the other unit carries the load never pages except through the E21 email.

**dmd noise.** Remove `dmd` from `CONFIG_FIELDS` (or treat it as telemetry) so the "config changed" banner
means a setting changed.

## 4 · How this relates to work already in flight

- Pi WiFi stall + reboot ladder: #165 (`/health.pi`, building now), #166 (hub dropout counters, live), #76.
- Planner no longer writes against stale Pi state: #167 (live tonight).
- Element breaker, lagT, unverified zones: #138, #132, #134, owner card #175.
- The 2026-10-18 eval missed this incident: it read logs from Oct 14 12:10Z onward and never looked at the
  fault history, and it graded alerting "unverified" without checking whether the E21 email went out.

## 5 · What is still unverified, and how to close it

| Question | Where the answer is | How to get it |
|---|---|---|
| Did the E21, unserved-call and DHW-shortfall emails arrive? | your inbox | search "A2W" for Oct 14 and Oct 16 |
| When did HP2 actually stop heating? When did the HBX rotate HP2 into the lead? | mirror `readings` (pump state per minute), `slx_readings.stages_called`, `pump_events` | sign in to the dashboard in the browser pane (Activity + History pages), or restore Monday's backup locally (needs the backup passphrase in this Mac's Keychain) |
| Did SPAN's local API answer during the cloud outage? | mirror `span_readings` | same |
| Did the unserved-call alarm open an episode? | planner `unserved_episodes` | same |

## 6 · Correction and closure (2026-10-19, measured on the restored 2026-10-20 backup)

**§1.1 was wrong about the timing.** The HBX did not "wait three hours" before adding HP1. With `lagT=180` it
**never added a second stage at all**. `slx_readings`, 5-min samples:

| period | both stages called | backup called | single-stage samples |
|---|---|---|---|
| lagT=60 (Jul 13 – Aug 7) | 34 | 34 | 379 |
| lagT=180 (Aug 7 – Oct 19) | **0** | **0** | 1,884 |

On the incident night, stage 2 (HP2, faulted) was called continuously from **Oct 15 12:00 to Oct 16 02:10 ET (14.2 h)**,
with the tank at 104–111 °F against 119.5 °F, and stage 1 never came on. The same thing happened Aug 12–13 for 20.1 h.
The old all-idle alarm opened `unserved_call_episodes` #52 at 12:05 ET Oct 15 and held it until 01:00 Oct 16.

**Fix (F2):** `lagT` 180 → 60, written 2026-10-19 22:34 ET. It was a guarded one-off write: it went ahead only if the
HBX read 180, was echoed back, and a fresh read confirmed that `lagT` was the only field changed. It is asserted
by drift-check [9]. The element stays gated by its SPAN breaker (OPEN), with a dynamic A2W close rule building in shadow.

**Status of every failure:**

| | Failure | Status |
|---|---|---|
| F1 | HP2 E21 trigger | Hardware hypothesis (enclosure supply/ground) is **open**; needs an on-site check. Mitigated by self-heal, live since 2026-10-19 (#201/#202). The "Pi reconnect traffic" theory was tested in `hp2-e21-reconnect-analysis.md`: **weak** (E21 follows Pi-side Wi-Fi outages, but not our traffic). That doc has the on-site checklist. |
| F2 | No failover to HP1 | **Fixed**: lagT 60 (above); per-stage unserved alarm (#185 via #196); self-heal. |
| F3 | Backup off and shown green | (a) **Fixed**: the card reads the breaker (#184). (b) Element gate: dynamic rule **building in shadow**. |
| F4 | No self-healing power cycle | **Fixed, live** (#201/#202). The 60 s cycle was proven on Air-Water 2; not yet exercised by a real E21. |
| F5 | SPAN unreachable | **Fixed**: local API with the nested relay body (#200), SPAN-local heartbeat (#187). The SPAN *app's* cloud command channel is a SPAN-side fault (owner ticket). |
| F6 | Comfort override stub | **Fixed**: real boost with read-back, plus Heat now (#186/#192); the auto-pilot holds during a boost (#197). |
| F7 | Storm banner stale | **Fixed** (#183 via #192/#196); 0 open storm rows. |
| — | dmd noise | **Fixed** (#182 via #196). |
| — | Pi WiFi stall | Power-save off; no 2-hour wedge since. **Open**: −79 dBm signal across 3 mesh APs and no Ethernet, so the link still drops for minutes. Physical fix. |
| — | Silent failures (no fault code) | **New**: pump-health checks in shadow (#204). They caught a stuck 83-min defrost on pump1 (Oct 17 22:07 ET), which the all-idle alarm saw as `unserved_call_episodes` #57. |

