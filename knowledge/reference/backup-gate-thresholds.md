# Backup-element gate: thresholds from measured data

**Status (2026-10-19):** built in SHADOW. Planner: `planner/src/backupgate.ts`. Pi-local fallback:
`heatpump-bridge/bridge/backup_fallback.py`. Nothing switches until the owner sets `BACKUP_GATE=live` (planner) and/or
`backup_fallback.live: true` (Pi). Re-opening the breaker needs its own owner OK (§6).

**The owner picks the floor.** The proposal is **100 °F for 30 min** (§4).

## 1 · The rule (owner, 2026-10-19)

> "Sometimes it's OK if the heat pumps are keeping up and there's just a massive load (and the tank isn't completely
> freezing), but if a heat pump has failed or just totally cannot keep up, THEN we'd want it to kick on."

The "Buffer Tank" SPAN breaker feeds the 16.5 kW element and is OPEN on purpose. Closing it only makes the element
*available*: the HBX still decides when to fire it. With `lagT` 60 (restored 2026-10-19) the HBX calls the backup at
the same moment as the lag stage, about 60 min into a sustained call. In every lagT-60 sample, "both stages called" and
"backup called" coincide: 34 of 34. So the open breaker is now the only thing keeping the element out of ordinary
shower sags, and the gate must never close it for a normal heavy load.

| Rule | Closes when | Held for |
|---|---|---|
| **failed_not_recovering** | a pump has FAILED (offline in a live frame, the bridge's `fault` state, or its stage's `stage_unserved` / `fault_called` open) **and** the HBX is calling **and** the tank is ≥ 10 °F below target **and** it has risen < 3 °F over the last 20 min | 90 min |
| **floor** | the HBX is calling **and** every *available* pump is engaged (heating or defrost) **and** the tank is < 100 °F **and** it has risen < 3 °F over 20 min | 30 min |
| **recovered** (re-open) | the gate closed it **and** every pump is healthy **and** tank ≥ target − 5 °F (or the HBX is satisfied) | 60 min, and ≥ 120 min after the close |

Clocks work like `stagewatch.ts`. Time is credited only between consecutive qualifying polls ≤ 7.5 min apart. A
non-qualifying poll resets the clock. A blind poll (no live Pi frame, a missing SensorLinx field, no tank sample 20 min
back) neither credits nor resets. **A rise of ≥ 3 °F over 20 min pauses the clock; it does not reset it.** In a real
failure, the surviving pump's defrost sawtooth (dip, partial recovery, dip) would otherwise restart the 90 min every
cycle, so only the floor would ever catch it (`backupgate.test.ts` §7b). A genuine recovery still resets the clock: the
call ends or the deficit closes. Every action is at least 120 min after the previous one, so the gate cannot flap.

The **Pi-local fallback** needs no cloud. It closes the breaker (it never opens it) when **every** pump has been down
for 30 min. Down means a fresh blocking fault while not running, or Modbus-stale while a fresh SPAN read shows no
compressor draw on its circuit. A deliberate off (switched off on the unit or from 6bb, or its circuit OPEN at the
panel) is never "down". A pump that is stale with no fresh panel read is **unknown**, and unknown resets the episode:
a Pi Wi-Fi/LAN drop loses Modbus and SPAN together and must not read as "every pump down". It makes at most one
decision per 6 h.

**Shadow pages are never phone pushes.** #211 pushes every high/urgent alert and every all-clear to the owner's phone
via 6bb. In shadow, the planner's would-close goes out at default priority through its own outbox, as one email per
episode. The would-open is a log line, `/health` and the dashboard only. The Pi fallback's shadow would-close is email
only.

## 2 · Data

- **Postgres restore** `a2w-db-2026-10-20T014442Z` via `scripts/analyze-local.sh`, into a separate local DB. Never
  production. It holds `slx_readings` at 5-min cadence from Jul 13 23:13 to Oct 19 21:44 ET (26,865 rows) and the
  mirror's `readings` at about 1/min (112k rows per pump).
- **The Pi's nightly SQLite** `bridge-20261019.db`, opened immutable. It holds 20 s Modbus samples, written only on
  success, plus 25 s SPAN samples. Used for gateway-outage lengths (§5).
- **Replay** `scripts/backup-gate-replay.ts` drives the shipped `BackupGate` and a `StageWatch` over every
  `slx_readings` row with the mirror's pump state at that instant. This is the input `index.ts` gives the gate. The
  `BACKUP_GATE_*` env overrides make every number below re-runnable:
  ```
  cd planner && LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/backup-gate-replay.ts
  ```
- **Caveat: there are no two-pump measurements.** In 97 days the pumps never heated at the same time. lagT was 180 from
  Aug 7 and the HBX never called a second stage. Before that, HP2 sat in fault from late July to mid-August. Every
  healthy-heavy number below is therefore **one pump carrying the house**, which is conservative for a rule about
  "everything running". The coldest data is 28.9 °F outdoor. Revisit after the first design-cold week (§7).

## 3 · What happened in the failure windows

| Window | What | Tank | Replay (defaults) |
|---|---|---|---|
| **Oct 15 12:00 → Oct 16 02:10** (14.2 h) | stage 2 called continuously; HP2 E21 (fault); HP1 idle and never called (lagT 180). Pi blind 14:35–16:40. | 103 °F by 12:15, then 99–104 flat against 119.5 for 12 h; a shower took it to 77 °F at 01:00 | **would close at 13:35**, 95 min into the call. **Would re-open at 03:10** after HP2 heated again |
| **Aug 12 12:08 → Aug 13 08:10** (20.1 h) | stage 2 called; HP2 fault; HP1 never called; 70–90 °F outdoor | slow decay 118 → 101 °F, about 0.5 °F per 30 min | **would close at 19:18**. The deficit stayed under 10 °F until late afternoon (summer: slow decay, nothing urgent) |
| **Jul 22 – Aug 7**, 12 calls with HP2 faulted in the lead (lagT 60) | HP1 joined as the lag stage with the HBX backup call about 60 min in, and recovered the tank within 15–25 min | dips to 96–117 °F | **no close.** Longest failed-rule clock 60 min (Jul 23 03:40, Aug 5 08:51), against the 90-min hold |
| Oct 11 15:15 → 19:30 | stage 2 called 4.3 h, tank 118 → 97 °F, recovered at once when the HBX switched to stage 1 | | **blind**: the mirror has no pump data that afternoon. Neither layer could attribute it. See §8 |

## 4 · The floor: 100 °F for 30 min (owner to confirm)

The question is how long the tank stays below *X* °F, while the HBX calls and the tank is not rising, **with no failed
pump**. The "all pumps engaged" half of the rule is left out of this count to be conservative. Measured over 97 days:

| Floor | Longest healthy spell | Margin vs 30 min |
|---|---|---|
| 95 °F | 5 min | 6× |
| **100 °F** | **5 min** | **6×** |
| 105 °F | 20 min (Oct 18 01:50, one pump at 32 °F outdoor) | 1.5×, too tight |
| 110 °F | 25 min | none |

The deepest healthy sag in the whole record is **100.8 °F** (Oct 18 01:35, HP1 alone at 32 °F, shower plus defrost). It
recovered within 25 min. A healthy pump has never put the tank below 100 °F.

Why 100 °F, not lower or higher:
- **Above the HBX's own floor.** `bkTemp` 90 °F is where the HBX fires the backup itself. 100 °F acts first, and never
  overlaps an ordinary sag.
- **Below every normal heavy load in the record**, with a 6× time margin. 105 °F would trip on a cold-night single-pump
  sag. The owner's "massive load" case is a tank sagging but holding above 100.
- **A comfort line.** The DHW-shortfall page fires at 113 °F. Showers turn lukewarm around 100 °F. The owner's cold
  shower on Oct 16 came from a tank at 77–86 °F.

"Not rising" was added after the first replay. On Oct 16 at 01:00, right after HP2 recovered, the tank climbed from 77
to 97 °F in 35 min but stayed below 100 °F for 30 min. That is a pump keeping up, not failing to.

**Why the floor needs "every available pump engaged":** with lagT 60, the lag pump is idle for the first hour of a
call. Below the floor with an idle healthy pump means the HBX still has capacity to add. A *failed* pump is not
"available", so the floor rule covers "one pump died and the survivor runs flat out but cannot hold 100 °F". With no
pump available, it fires on the floor alone.

## 5 · The failure rule: 10 °F, < 3 °F per 20 min, 90 min

**Margin 10 °F.** On healthy data, the longest clock of "called, ≥ M °F below target, not rising", with a rise pausing
the clock (the shipped rule):

| M | Longest healthy clock | Incident close | Aug 12 close |
|---|---|---|---|
| 5 °F | 85 min (Oct 18), too close to 90 | 13:30 | 17:18 |
| 8 °F | 50 min (Oct 18 08:40), 1.8× | 13:30 | 17:43 |
| **10 °F** | **25 min**, 3.6× | **13:35** | **19:18** |

The first cut used 8 °F, when a rise still *reset* the clock (healthy maximum 30 min). Pausing lets a healthy single
pump's sawtooth accumulate across dips, so the margin at 8 °F fell to 1.8×. 10 °F restores it, at a cost of 5 min on the
incident. The incident sat at 16–20 °F.

**Hold 90 min, not 60.** This is the measured reason, unchanged under the pause rule. With lagT 60 the HBX adds the lag pump about 60 min into a call,
and that pump needs 15–25 min to show a lift. A 60-min hold **false-closes on Jul 23 04:40**, while HP1 was about to
recover the tank (`backupgate.test.ts` pins this). The longest such spell is 60 min, so 90 leaves 30 min of margin.
90 min also covers the self-heal (10-min grace + 60 s power cycle + 15-min verify): if self-heal clears an E21, the gate
never closes.

**Not rising: < 3 °F over 20 min.** A working pump lifts the tank 1–4 °F per 5 min. With a 15-min window and a 2 °F
threshold, a +1.9 °F blip at 17:00 on Oct 15 split the incident's spell in two. 20 min / 3 °F does not. A rise pauses
the clock (§1).

**"Failed" includes `stage_unserved` / `fault_called`** from `stagewatch.ts`. That catches a pump that is called, not
heating, and shows no fault code. A pump that faults while idle, with the other pump carrying the house, does not close
anything: the tank half never holds for 90 min on healthy data (§3, §5 table).

## 6 · Re-open, and why it is off

The **recovered** rule re-opens only a breaker the gate closed, never one the owner closed. It needs every pump
healthy, tank ≥ target − 5 °F or the HBX satisfied, held 60 min, and ≥ 120 min after the close. In the replay it fires
at Oct 16 03:10 and Aug 14 03:13.

**Opening the Buffer Tank breaker is not allowed today.** The arm is close-only by construction. The re-open path is
built behind two flags, **both default OFF**. Enabling either needs the owner's explicit OK.
- Planner `BACKUP_GATE_REOPEN=1`. Without it, a live gate that wants to re-open pages once ("recovered, breaker left
  ON") and leaves the breaker closed.
- Pi `span.backup_reopen: true`. Without it, `BreakerController` refuses any OPEN of the element, from any caller.

With both on, an OPEN goes through the same path as the Air-Water power cycle: a single-use `OpenPermit` minted after
the guards, relay read-back, audit, and a page. It has two guards of its own:
- never while the element draws ≥ 300 W (it never switches a live 16.5 kW load off);
- never while the owner's arm intent is ARMED.

Live, a breaker the gate closed that someone switches OFF by hand makes the gate stand down for 12 h. It never fights
a human. A command a bridge guard refuses stands the gate down for the rest of that episode. A command with no answer
(no Pi, hub timeout) retries every 15 min, and if it landed anyway, the relay read confirms it as the gate's own. Either
failure pages once per episode. The element-open guard refuses when the element's draw is unknown, and it re-reads the
panel immediately before the OPEN.

## 7 · Pi-local fallback: 30 min

On the Pi, "both pumps stale" is the risky signal: during a gateway outage the pumps keep heating on the HBX's dry
contacts. Measured on the Pi's own samples:
- **Both gateways stale while the SPAN panel stayed reachable: never longer than 3.5 min** in 97 days (82 spells). The
  long both-stale spells (up to 75 h) all had SPAN stale too. Those were the bridge or Pi itself down, when nothing
  can act anyway.
- **One gateway stale: up to 41 min** (pump2, Aug 6). That is why the fallback needs **every** pump down.
- **SPAN idle draw** on Air-Water 1/2 is 5–9 W (median 8). Running is ≥ 5 kW. A stale pump whose circuit draws ≥ 500 W
  counts as running. A stale pump with no fresh panel read is unknown, never down (a Pi network drop loses both).

30 min is more than 8× the longest both-stale spell. A 30-min-old total loss of heat is also well inside the incident's
lesson: 14 h passed with nothing restoring heat.

## 8 · What to watch in shadow, and before going live

- **Pages:** "Backup element gate (shadow): WOULD close" (one email per episode; the would-open is not emailed), and
  "Backup fallback (shadow): WOULD close" (email). Neither is a phone push. `/health.backup_gate` and the dashboard's **Backup element gate** card show the clocks,
  the inputs and the **real** breaker separately from the gate's virtual state.
- **Re-validate after the first design-cold week**, with `BACKUP_GATE_*` overrides on a fresh restore. At ≤ 10 °F two
  pumps may legitimately run flat out with the tank in the low 100s. That is the owner's "massive load" case and must
  not cross the floor rule.
- **Going live, planner:** `BACKUP_GATE=live` and `HUB_ARM_TOKEN` on the planner service (the same second factor the
  dashboard uses). `/health.backup_gate.live_ready` must be true.
- **Going live, Pi:** `backup_fallback.live: true` in `~/bridge-data/config.yaml`, after the bridge release that carries
  it. Live, the fallback acts regardless of the arm intent. The planner's live close goes through the same
  `BreakerController.execute(…, "close")` the dashboard uses, so it is also unaffected by the arm intent. When the gate
  goes live, the portal's arm toggle should become three-way (Off / Auto / Always): open decision for the owner.
- **Known gap:** when the Pi is disconnected from the hub, the planner is blind and cannot execute. The fallback covers
  only "every pump down" (see the Oct 11 row). A one-pump failure during a Pi dropout waits for the link.
