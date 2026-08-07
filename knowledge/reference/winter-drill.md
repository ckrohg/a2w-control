# Winter-readiness alert drill

The safety/alerting stack was built in August 2026; its real season is January. This
runbook proves every alert path end to end **before** the first cold snap, without faking
sensor state. Run it once in late fall (and after any alerting change). Total time: ~15 min.

**Rule zero: tell the owner a drill is starting.** The messages look real on arrival —
the 2026-08-06 dead-man drill produced a "random Pi note" precisely because it wasn't
announced.

## What "pass" means

Email = intervention tier only (equipment faults, prolonged outage, Pi dead, freeze-risk,
Pi hardware). ntfy = everything actionable. See `resend-email-alerting` memory / #68.

## The drill

### 1. Planner channels — freeze-risk (email) + backup element (ntfy-only)

```bash
# PLANNER_URL + PLANNER_API_TOKEN via: cd analytics-mirror && vercel env pull --environment=production
curl -s -X POST "$PLANNER_URL/api/drill" -H "Authorization: Bearer $PLANNER_API_TOKEN"
```

Expect within ~1 min:
- **[DRILL] Freeze-risk advisory** — ntfy push **AND** email. Email missing → the one
  house-threatening email path is broken; fix before winter.
- **[DRILL] Backup element called** — ntfy push **only**. If this arrives as an email,
  the tiering regressed (planner EMAIL_PRIORITIES must be urgent/max only).

### 2. Hub dead-man — Pi silent > 3 min (email + ntfy w/ retry)

```bash
ssh -i ~/.ssh/6bb_bridge_ed25519 admin@6bb-a2w-control.local \
  'sudo systemctl stop heatpump-bridge; sleep 270; sudo systemctl start heatpump-bridge'
```

Expect: "A2W: heat-pump bridge offline" email (+ ntfy, best-effort with 3× retry — the
Railway→ntfy.sh path is known-intermittent, #66) at ~3 min, and the "back online" pair
after restart. Note: the bridge restart re-edges any active faults → those email too.

### 3. Bridge fault email — inject nothing; verify the canaries instead

Fault-code emails were proven live (E21, 2026-08-06). Verify the path is still armed:

```bash
curl -s http://6bb-a2w-control.local:8000/api/health | grep -o '"email_configured":[a-z]*'
```

`true` required. (A real end-to-end refire happens for free at step 2's restart if any
fault is latched.)

### 4. Physical checklist (no code)

- SPAN app: the **Buffer Tank** (backup element) breaker is ON and the SPAN backup alarm
  armed (dashboard → Control).
- ntfy app installed + subscribed on the phone that will be in a pocket in January.
- Pi health card (Advanced) green; hub `A2W hub online` self-test present in the ntfy
  list from the latest deploy.
- HBX wall controller reachable (CN23 bus) — E21 history means comm degradation shows
  there first.

## Paper trail

Log the drill + outcomes as a journal entry; file issues for any miss. The drill is
idempotent and safe: no setpoints, no writes, ~4.5 min without polling in step 2.
