<!--
@purpose Incident record: the Pi went silent at 14:15 UTC on 2026-09-16, during a session that
merged nine PRs. Written so the next session does not re-derive the analysis, and so the
process changes have a reason attached to them.
-->

# Incident 2026-09-16 — Pi offline at 14:15 UTC

**Impact:** loss of the A2W overlay (Phase B setpoint optimisation, Modbus monitoring, SPAN
logging). **No heating impact.** The HBX is the actual heating controller and ran the house
unaffected — verified live: `connected: t`, tank 119.3 °F tracking a 120.2 °F target, zones
calling, outdoor 67.8 °F. Both pumps held their last setpoint of 52 °C (warm).

## Timeline (UTC)

| time | event |
|---|---|
| 05:21 | hub deploy SUCCESS (#96, watchPatterns) — **the only hub deploy all day** |
| 05:23 | planner deploy (#97, FINDING-1b) |
| 05:29 | verified live: `/health` correctly reporting `⚠ NO LEASE ARMED` |
| 13:44 | pump2 `cannot connect to 192.168.184.171:8899` (W610 gateway) |
| 14:04 | planner deploy SUCCESS (#101) |
| 14:10 | pump2 `timeout reading 2000: No response` |
| **14:15** | **all three Pi feeds stop in the same minute** — `readings`, `span_readings`, `system_stats` |
| 14:16 | last state push received by the hub |
| 14:24–14:29 | four more PRs merged (#105, #102, #100, #103); all hub/planner deploys SKIPPED |
| 14:29 | `drift-check.sh` flags `pi NOT connected` |
| 15:06 | still down (51 min) |

## Ruled out, with evidence

- **Code deployed to the Pi.** Newest `release-*` tag is `release-20260823-1` (Aug 23, three
  weeks prior). `pi-update.sh` deploys only tags, never `main`. Nothing merged this session
  could reach the box — the fusion-audit risk-4 gate working as designed.
- **Hub redeploy dropping the Pi's WebSocket.** This was the best candidate mechanism, since
  the hub holds that socket. Railway shows one non-SKIPPED hub deploy all day, at 05:21 —
  nine hours before the cliff. Everything after was SKIPPED by the new watchPatterns.
- **The self-heal watchdog (#85).** Rung 2 needs `pumps_fresh == 0` for 45 min; rung 3 needs
  120 min plus a prior restart. pump1 polled cleanly at 62 s intervals until 14:15, so the
  verdict was `ok` and the ladder never armed. A rung-3 reboot would also have returned in
  ~2 min.
- **Database starvation from the session's ad-hoc analytics.** Ingest held a steady 2 rows/min
  through 14:04, 14:10 and 14:15, then stopped dead. Resource contention degrades before it
  stops; this was a clean cliff.

## Not determined

The cause. Most likely local to the Pi: SD-card failure (classic, and fits both the clean
simultaneous stop and the failure to return), loss of power on the Pi's own outlet, or a WiFi
adapter drop. The pump2 Modbus errors at 13:44/14:10 may have been an early symptom of the
same trouble rather than a separate fault.

**Why it could not be determined remotely — the finding that matters most:** the only thing
that reports on the Pi is the Pi. When it dies, the diagnostic channel dies with it, so
crash / network / power are indistinguishable from the cloud. `heartbeat_url` covers
*detection*; nothing covers *attribution*.

## What this cost, and the real lesson

Nine PRs merged in one session, four inside five minutes, spanning a live deploy at 14:04.
The merges were almost certainly not causal — but that is a **reconstruction**, not a record.

The cost of merging in a burst was not that it broke something. It was that it left no
known-good bracket around the failure, so the honest answer to *"did we cause it?"* became
*"probably not"* instead of *"no"*. On infrastructure controlling a real home's heat, that
difference matters.

Second, unrelated-but-owned: analysis queries (19k-row window-function joins) were run against
the **production** database for #89 and #76. Not causal here, but an unforced risk taken
silently on live infrastructure for questions a week-old snapshot answers equally well.

## Mechanisms added in response

- `scripts/deploy-gate.sh` — brackets every deploying merge with a health snapshot. Refuses to
  merge from an already-unhealthy baseline, waits for the deploy, re-verifies, and reports a
  regression against a known-good before-state. Turns discipline into mechanism.
- `scripts/analyze-local.sh` — restores the newest encrypted `db-backups` dump into a local
  Postgres. Analysis never touches production again.
- CLAUDE.md "Working rules" — the serialisation rule, written where a future session reads it.

## Recovery

Power-cycle, then:

```bash
journalctl -u heatpump-bridge -n 100 --no-pager   # what happened before 14:15
journalctl --list-boots | tail -3                 # did it reboot on its own?
dmesg | grep -iE 'mmc|ext4|read-only|I/O error'   # SD card health  <- look hardest here
systemctl status bridge-watchdog.timer
```

Filesystem errors or a root mount flipped read-only means the SD card is going and a power
cycle buys days, not a fix.
