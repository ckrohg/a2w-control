# A2W owner alert policy

Owner decision, 2026-10-20. This replaces the 2026-08-06 policy ("email is the intervention channel") and the
2026-08-23 policy ("high must email"). It also replaces the 2026-10-19 6bb rule ("every high/urgent alert and
every all-clear goes to the phone").

## Why

From 2026-09-21 to 10-20, A2W sent the owner **422 alert emails**, up to 48 a day. From 10-19 it also sent phone
pushes. Almost none needed a human:

| What fired | Emails | What it was |
|---|---|---|
| Phase B "no lease armed" / "tracking failing" | 113 | Internal planner state. "No lease" re-fired on every redeploy (in-memory latch). |
| "Second planner instance" + RESOLVED | 67 | All 34 came within 3 h of a planner deploy: Railway's old/new container overlap, cleared in about 10 min. |
| "Heat call but NO pump running" + RESOLVED | 72 | 29 of 36 cleared within 15 min (start-up, defrost). |
| Bridge offline / Pi disconnected + RESOLVED | 104 | The cloud losing the Pi for 2–4 h. The HBX keeps heating without it. |

Meanwhile the Pi recorded a handful of real events:
- an **E21 on HP2 that stuck for 2 days** (Oct 14–16);
- an R02 on HP1 that clears itself in about 3 min but has recurred 5 times since August.

The noise buried the real faults.

## The rule

Notify on **outcomes**: the house is at risk, or a person has to physically do something. Never notify on the
system's internal mechanics. The buffer tank and the house carry hours of heat, so almost nothing needs a human
inside 30 minutes.

| Tier | Channels | Meaning |
|---|---|---|
| `page` | 6bb phone push + email | The house is at risk, or a human must act soon. |
| `attention` | Email only | Nothing is wrong now, but someone should look this week. |
| `record` | ntfy log, DB row, dashboard, Monday digest | Everything else. |

These rules apply to every tier:

- **Every call site declares a tier.** The planner's `ntfy()` requires `{ tier }` (a TypeScript error if it is
  missing). The bridge's `_push`/`notify.alert` require `tier=`; an unknown tier raises. Priority only sets ntfy
  loudness; it never picks a channel.
- **All-clears are never their own notification.** A resolved call carries the tier of the alert it resolves.
  - Only a page gets an all-clear: the 6bb push replaces the alert by tag, plus one email.
  - Attention and record all-clears are record-only.
- **One problem, one alert.** Each incident has one owner; its symptoms are record-only:
  - "no heat" (planner all-idle check) is the incident; the per-stage unserved/fault-called episodes and a cold
    tank during it are its symptoms;
  - "Pi unreachable" (planner) is the incident; the hub dead-man, SPAN-local stale and I8-blind are its symptoms.
- **Restarts never re-alert.**
  - Planner: keyed alerts are latched in `notify_latches`. A redeploy's re-fire is suppressed, and a condition
    still true is re-sent at most once per 24 h.
  - Bridge: sustained-fault pages are recorded as `alert` events and re-adopted on restart.
- **Shadow mode never notifies.** Neither do the owner's own dashboard actions (breaker clicks, write-enable,
  mode toggles).
- **Page budget.** More than 3 pages in 7 days logs `PAGE BUDGET EXCEEDED`. Treat it as an alerting bug, not as
  normal.

## What pages

| Incident | Source | Threshold |
|---|---|---|
| Freeze risk | planner | Outdoor ≤ 5 °F and tank < 105 °F |
| No heat being made | planner `checkUnservedCall` | A stage called with no pump heating for 45 min (9 polls) |
| Tank cold | planner `checkDHWShortfall` | Tank < 113 °F for 60 min, unless a no-heat page is already open |
| Pump fault that sticks | bridge `poller._check_sustained_faults` | Any non-INFO fault except PC (weather) still set after 30 min |
| Breaker left OFF | bridge `span_control` | A close not confirmed, a re-close failed, or an unreadable cycle record |
| Both pumps down, element unavailable | bridge `backup_fallback` (live) | No breaker control, close refused, or close unconfirmed |
| Backup gate could not close | planner backup gate (live) | The close command failed |
| Pi unreachable | planner `checkLeaseAndPi` | 2 h when outdoor < 32 °F, else 12 h |
| Planner down | hub planner dead-man | 2 h (was 15 min) |
| Foreign HBX curve writer | planner `drift.ts` | Any confirmed foreign write; at most one page a day |

## What emails (attention)

- **Pumps and faults:**
  - the same fault code 3+ times in 7 days (bridge);
  - a pump that never answered since boot, or comm offline 60+ min;
  - a W610 identity mismatch.
- **Pi health:** CPU ≥ 80 °C, disk ≤ 10 % free.
- **Hygiene:** no ≥ 134 °F × 30-min soak in 72 h (one missed window is record: the planner re-schedules the soak).
- **Planner state:**
  - Phase B with no lease armed (FINDING-1);
  - writer lease unheld 15+ min;
  - a second planner instance still live after 30 min;
  - HBX target not adopting;
  - SensorLinx unreachable 6 h;
  - an identification cleanup stuck (at most daily).
- **Cost and capacity:**
  - the SPAN backup element drawing power;
  - A2W closing the element breaker itself (backup gate or Pi fallback, live);
  - winter cap checks.
- **Configuration and monitoring:**
  - self-heal mis-configured (config invalid, history unreadable, identity mismatch, map swap suspected);
  - SPAN local down 4+ h;
  - the backup-element ARM going live;
  - promoted pump-health checks;
  - a pump-health digest that flags drift.

## Replay: the last 30 days under this policy

Inputs: Resend's sent list (2026-09-21 to 10-20) and the Pi's event log. The script is in the PR description.

| | Before | After |
|---|---|---|
| A2W alert emails | 422 | about 30 |
| Phone pushes | (from 10-19) every high/urgent alert and all-clear | 18 (9 pages + their 9 all-clears) |
| Recorded only | — | about 200 |

The 9 pages are all real heat or invariant events:
- **No heat** ×3: Oct 11 and Oct 15 (HP2 E21 outage), Oct 18 (75 min);
- **Tank cold 60+ min** ×2;
- **E21 stuck on HP2** ×2;
- **Pi unreachable 16 h** on Oct 8;
- **One foreign HBX curve write** on Oct 18.

8 of the 12 attention emails are FINDING-1's "no lease armed", which is fixed (armed 2026-10-18, #216), so the run
rate going forward is lower.

## Email format

Every email has the same layout, readable on a phone in a few seconds (owner, 2026-10-20: "really hard to skim").
From top to bottom:
1. a tier banner in words: URGENT · act now / NEEDS A LOOK · this week / RESOLVED;
2. the headline;
3. a boxed **What to do**;
4. a short facts table;
5. the technical details, small and grey;
6. a footer: time, source, dashboard link, and why this reached you.

Where the code lives:
- Planner `alertemail.ts`; `hub/src/alertemail.ts` is a byte-for-byte copy (a hub test enforces it). The bridge
  has the same layout in `notify.render_html`.
- Call sites pass `action` and `facts`. The plain-text body is still sent alongside.
- The daily pump-health digest (email only when drift is flagged) is a side-by-side table per pump.

## Where events live

- **Planner:** `notifications` records every decision, including what was suppressed and why. `notify_latches`
  holds the open keyed alerts. Plus the existing episode tables.
- **Bridge:**
  - SQLite `events`, mirrored to Postgres `pump_events`, covers faults, comm, breaker, self-heal and fallback;
  - `type='alert'` rows mark the bridge's own pages (`fault_sustained`) and repeat-fault emails
    (`fault_pattern:<code>`).
- **Monday digest:** the "Alerts & events" block shows what reached the owner, then what was recorded without
  bothering them, with repeats grouped.
