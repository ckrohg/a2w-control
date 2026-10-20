# HP2 E21 vs the Pi's Wi-Fi reconnects — analysis (2026-10-19)

**Question (owner):** is HP2's recurring E21 ("display controller lost communication with the
heat pump", wall controller ↔ main board on CN23) set off by the Pi resuming Modbus traffic
after one of its own Wi-Fi outages? If so, it is partly our doing.

**Verdict: WEAK.** E21 does follow the Pi's *own* Wi-Fi outages more often than chance would
explain (3 of 4 onsets; p ≈ 0.002 on a split chosen after seeing the data, so treat it as
suggestive). But the data argues against **our resumed traffic** being the trigger:

- No write frame reached HP2 in the hour before any onset.
- On Oct 11, E21 was already showing on the first poll after a 5-hour silence.
- On Aug 10 and Oct 14, 13–18 minutes of clean polls came between the reconnect and the
  onset.

The likelier reading is a **common cause**: whatever knocks the Pi off the Wi-Fi also
disturbs HP2. That points to the enclosure supply/ground, RF, or a house-network event, not
the bridge. A cheap mitigation ships anyway (§4) so the next episode is a clean test.

Data: backup `a2w-db-2026-10-20T014442Z` restored locally (`scripts/analyze-local.sh a2w_e21`), the
`pump_events` ledger (Jul 12 – Oct 19, 99 days) and `system_stats` (the Pi's per-minute heartbeat
as received by the hub). Production was not queried. All times are ET.

## 1 · The four E21 episodes (all pump2; pump1 has never had one)

| Onset seen | Cleared | What came before | E21 bit before the onset? |
|---|---|---|---|
| Jul 23 02:54 | Aug 6 11:59 (14.4 d) | **No outage.** One write at 01:55 failed to *connect* to HP2's gateway; polls were fine all night. The Pi had no gap. | clean polls for 58 min |
| Aug 10 21:32 | Aug 14 02:09 (3.2 d) | Three ~1 min blips with both gateways down: 17:16, 20:54 and 21:14. The last one was Pi-side (3 min hub gap). Before that, both pumps timed out on a read at 20:53 (TCP up, no answer). | **clean polls for 18 min** after reconnect |
| Oct 11 ≤16:07 | Oct 11 22:10 (6.1 h) | Pi off the network 10:58 → 16:07 (5.2 h, no hub, no gateways), plus a bridge restart at 11:51. | **unknown**: E21 was present on the *first* poll back, so it began while the Pi was silent |
| Oct 14 02:17 | Oct 16 00:54 (1.9 d) | Pi-side outage 01:56 → 02:03 (7.7 min; journal shows an auth timeout to the AP). At 02:05:47 HP2 timed out on the pre-write control read (TCP up, no answer). | **clean polls for 13 min** after reconnect |

HP2 was idle at 0 W at every onset: no compressor start, defrost or flow edge in the two
hours before (`readings`, `pump_events` state rows). The pump itself did nothing electrical.

## 2 · Base rate: how many reconnects did NOT produce E21

An outage counts as "both unreachable" when both pumps went offline within 2 min of each other.
Events less than 60 min apart are clustered into one episode. An episode is **at risk** only
while E21 is clear (E21 was active for 19.8 of the 99 days). A **hit** is an E21 onset during
the episode or up to 60 min after its last reconnect. **Expected** is how many of the 4 onsets
would land in those windows by chance, given the share of E21-free time the windows cover.

| Reconnect kind | At-risk episodes | Followed by E21 | Did NOT | Expected by chance | P(≥ observed) |
|---|---|---|---|---|---|
| Both unreachable, any length | 84 | 3 | **81** | 0.70 | 0.02 |
| Both unreachable, longest outage ≥ 5 min | 24 | 2 | **22** | 0.54 | 0.09 |
| **Pi-side** (the Pi lost the hub too) | 31 | 3 | **28** | 0.34 | 0.002 |
| ↳ of which ≥ 5 min | 20 | 2 | **18** | — | — |
| **Gateway-side** (Pi online, both gateways down) | 53 | 0 | **53** | 0.36 | P(0) ≈ 0.70 |
| pump2-only outages (its own W610 dropped) | 48 | 0 | **48** | 0.41 | P(0) ≈ 0.65 |
| pump2 setpoint writes **accepted** (clusters) | 225 | 0 | 225 | — | — |
| pump2 setpoint writes **failed** (clusters) | 214 | 3 | 211 | 0.62 | 0.01 |

**Oct 11 is counted as a hit in every row.** Its onset was first seen at the reconnect, which
falls inside the episode's window, even though the true start time is unknown (§1).

Per-event, not clustered: 722 pump2 reconnects in all, 4 followed by E21 within 60 min.
There were 30 both-unreachable outages of ≥ 5 min while E21 was clear (Oct 11 counted the same
way), and 2 were followed by E21 (Oct 11 and Oct 14).

**Reading it:**
- **Every E21 that followed an outage followed a Pi-side one.** Gateway-side and pump2-only
  outages (101 at-risk episodes) were never followed by E21. But with only 4 onsets, 0 hits
  is what chance predicts there anyway (P ≈ 0.70 and 0.65), so those zeros are **no evidence
  either way**. They don't show that bridge behaviour after a reconnect is innocent; the
  three points below do the work.
- **Writes are not the trigger.** There were 545 accepted writes to HP2 with no E21 after
  any of them. The "failed write" correlation is a marker of a disturbed period, not a
  cause. A *connect*-failed write never reaches the bus. A write whose pre-read *timed out*
  never sends the write frame. So in the hour before each onset, HP2 received read requests
  and nothing else.
- **Timing doesn't fit a traffic trigger.** If our first frames after a reconnect caused it,
  the fault should show on the first poll or two. Instead Aug 10 and Oct 14 had 13–18 min
  (~40–55 polls) of clean reads first. Oct 11's E21 was present on the first poll after
  5 h with no traffic at all.
- Small numbers: 4 onsets in 79 E21-free days. The Pi-side/gateway-side split was chosen
  after looking, so p = 0.002 overstates it.

## 3 · What the bridge and the W610 actually do around a reconnect

**W610 settings the bridge manages** (`bridge/w610_config.py`) are UART (2400 8N1) and transparent
mode, nothing else. Neither has a buffering knob. Serial packing/auto-frame (UARTF) is documented
**OFF** in `deploy/w610-setup.md`. In TCP-server mode the W610 only carries network → serial
data while a client is connected and sending. The pump never talks unprompted, so the W610 has
nothing of its own to flush onto CN22. Unverified on the units: `AT+MAXSK` (max clients) and
`AT+TCPTO` (TCP timeout). The setup doc recommends 1 and 60 s, but the "record both results here"
line was never filled in. If they are still factory (many clients, timeout 0), the W610 keeps a
dead session open after a Pi Wi-Fi drop and accepts the new one alongside it.

**The bridge after a reconnect** (`poller.py`, `modbus_client.py`), before this change:
- One poll is three block reads back to back (40/51/9 registers, ~2 s of bus at 2400 baud),
  every 20 s. There are no pymodbus retries (`retries=0`), no write queue on the Pi, and the
  hub answers 503 when no Pi is connected, so nothing is queued centrally either.
- **One Pi-specific path did exist.** After a 5 s timeout, `_flush_socket` called pymodbus
  `close()`, which is a *graceful* close. If the Wi-Fi stalled with a request frame still
  unacknowledged in the Pi's kernel send queue, the orphaned socket kept retransmitting it. On
  a short outage (under roughly 2 min) that stale frame and the FIN can reach the W610 *after*
  the link returns, at the same moment as the new session's first poll. On a W610 that allows
  more than one client, two request frames can then hit HP2's CN22 bus close together. This
  path occurs only when the Pi's link stalls, which matches the Pi-side/gateway-side split.
  It does **not** explain the 13–18 min delay. It is the only stale-traffic route found, and
  it is now closed (§4).

## 4 · Mitigation shipped in the bridge (needs an owner-cut `release-*` tag; not tagged)

1. **Hard close on timeout.** `PumpClient._flush_socket` now sets `SO_LINGER 0` before closing. The
   socket ends with an RST and the kernel discards any stuck request frame, so it can never be
   delivered late.
2. **Reconnect quarantine.** When a pump has been failing polls for ≥ `reconnect_min_outage_s`
   (60 s), the first good poll does three things:
   - It starts a **write hold** of `reconnect_write_hold_s` (120 s). Setpoint, power, mode and
     parameter writes are refused with 503 "reconnect quarantine" and audited as `rejected`.
     The planner just retries on its next replan. The lease revert retries on its next tick.
   - It **paces** that poll and the polls inside the hold, with 1 s between block reads, so
     the three frames reach the W610 one at a time.
   - It logs a `comm/reconnect_hold` event with the outage length. The next E21 analysis can
     then see which reconnects were quarantined.

   Set `reconnect_write_hold_s: 0` in `~/bridge-data/config.yaml` under `guardrails:` to turn it
   off without a release.

   **Writes the hold never blocks.** FINDING-1 has been armed on the Pi since 2026-10-18
   (`baseline_setpoint_c: 52`), so the hold must not be able to stop a lease revert.
   - Source `baseline-revert`, the lease's revert to the warm baseline.
   - Power-ON, which is always toward heat.
   - Person-initiated writes: the local UI (`ui`) and the owner's dashboard via the hub
     (`hub:dashboard`, `hub:armed-dashboard`).

   The hold only defers the planner's routine traffic (`hub:phase-b`).

   **At most one hold per 10 min**, counted from the end of the previous hold. A gateway that
   keeps dropping for ≥ 60 s and coming back would otherwise restart the hold every time, and
   no planner write would ever land.

   **No hold after a bridge restart or reboot.** The outage has to be seen by the running
   process. A startup hold would nack the planner's first command after every deploy, and the
   evidence doesn't implicate writes. The case it would cover, the watchdog reboot after a
   2-hour Wi-Fi wedge, hasn't recurred since Wi-Fi power-save was turned off.
3. Tests: `heatpump-bridge/tests/test_reconnect_quarantine.py` (9). They cover:
   - hold and release, and no hold after a short blip;
   - pacing, and `0` disabling it;
   - exempt sources and power-ON;
   - a baseline revert landing during a hold;
   - one hold per window under flapping;
   - an audit-write failure not failing the poll;
   - a real socket proving the peer sees an RST.

   The RST, revert and flapping tests each fail when their guard is removed.

**What it buys:** the next time E21 follows a Pi-side outage with this release live, our
traffic is ruled out as the trigger, both writes and stale frames. If E21 stops following
Pi outages, the stale-frame path was worth closing. Either way the cost is a 2-min write
delay after a ≥ 60 s outage.

## 5 · On-site checks for the Ethernet visit (~7 days)

Do these with HP2 **powered** (it is a live control board), except where noted. Photograph
everything before touching it.

1. **HP2's CN23 wall-controller cable and terminations.** Do this first; it is the E21 link
   itself.
   - Re-seat the CN23 plug on the main board. Look for a loose or backed-out pin, corrosion
     or heat discoloration.
   - Check the wall-controller end the same way.
   - Is the cable shielded? Is the shield landed at one end only?
   - Trace the route. Does it run in the same conduit or bundle as the 240 V supply, the
     compressor leads, or the W610 / RS-485 run?
   - Compare against HP1, which has never had an E21. Any difference in cable type, length
     or routing is the prime suspect.
   - With HP2 off: ohm each conductor end to end, and check each to the shield or ground
     for leakage.
2. **CN22 GND landing.** CN22 pin 2 (GND) is landed on HP2's board. Check whether that
   ground also ties to the repeater's isolated side or to the W610/PSU ground.
   - If the isolated repeater's "isolated" side shares a ground with the PSU, the isolation
     is defeated. A disturbance on the gateway side would then reach HP2's board ground,
     which CN23 shares.
   - Meter the DC voltage, then the AC voltage, between CN22 GND and HP2's chassis earth,
     with the gateway powered.
   - Do the same on HP1 and compare. Anything above a few hundred mV AC on HP2 only is a
     finding.
3. **RS-15-12 PSU output.** It powers both gateway chains.
   - Measure DC at the terminals, unloaded and loaded (both W610s and repeaters running). Expect
     12 V ± 5%.
   - Measure AC ripple on the DC output (meter on AC mV). Above about 100 mV is suspect.
   - Check whether its −V is tied to earth or to either pump's ground. It should float, or be
     tied at exactly one point.
   - Wiggle the input and output screw terminals while watching the meter. On these supplies,
     a flaky terminal looks exactly like an intermittent fault.
4. **While there, cheap and useful:**
   - Read each W610's socket settings in the web console: max clients (`AT+MAXSK`) and TCP
     timeout (`AT+TCPTO`). Fill in the "record both results" line in `deploy/w610-setup.md`.
   - Note how far each W610's antenna is from the CN23 cable.
   - Note whether HP2's W610 or repeater sits closer to its control board than HP1's does.

## 6 · How to re-run

```bash
export PATH="$HOME/micromamba/envs/pg/bin:$PATH"
scripts/analyze-local.sh a2w_e21
psql a2w_e21 -c "select pump_id, code, to_timestamp(ts) from pump_events where code='E21' order by ts"
```

The episode clustering and chance baseline were a one-off Python pass over `pump_events`
(type `comm`/`fault_*`/`setpoint_write`) and `system_stats`, using the definitions in §2. After
this release, `comm/reconnect_hold` events mark every quarantined reconnect directly.
