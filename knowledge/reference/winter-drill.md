# Winter-readiness alert drill

The safety/alerting stack was built in August 2026; its real season is January. This
runbook proves every alert path end to end **before** the first cold snap, without faking
sensor state. Run it once in late fall (and after any alerting change). Total time: ~15 min.

**Rule zero: tell the owner a drill is starting.** The messages look real on arrival —
the 2026-08-06 dead-man drill produced a "random Pi note" precisely because it wasn't
announced.

## What "pass" means

Tiers per `alert-policy.md` (2026-10-20): page = 6bb phone push + email, attention = email only, record = ntfy log
only. `POST /api/drill` fires one page-tier and one attention-tier drill; its response says what should arrive where.

## The drill

### 1. Planner channels: one page-tier and one attention-tier alert

```bash
# PLANNER_URL + PLANNER_API_TOKEN via: cd analytics-mirror && vercel env pull --environment=production
curl -s -X POST "$PLANNER_URL/api/drill" -H "Authorization: Bearer $PLANNER_API_TOKEN"
```

Expect within ~1 min:
- **🚨 A2W — [DRILL] Freeze-risk advisory**: 6bb phone push **AND** email. Either one missing means the
  house-threatening alert path is broken; fix before winter.
- **A2W needs a look — [DRILL] Needs a look**: email **only**. A phone push here means the tiering regressed.

### 2. Hub dead-man: Pi silent > 3 min

```bash
ssh -F ~/.ssh/a2w-pi.conf a2w-pi \
  'sudo systemctl stop heatpump-bridge; sleep 270; sudo systemctl start heatpump-bridge'
```

Expect: "A2W: heat-pump bridge offline" email at ~3 min, and the "back online" pair after restart. The SSH session
needs a fresh Tailscale approval first. Confirm afterwards that both leases read `armed` in planner `/health.phase_b`. Note: the bridge restart re-edges any active faults → those email too.

### 3. Bridge fault email — inject nothing; verify the canaries instead

Fault-code emails were proven live (E21, 2026-08-06). Verify the path is still armed:

```bash
ssh -F ~/.ssh/a2w-pi.conf a2w-pi "curl -s http://localhost:8000/api/health" | grep -o '"email_configured":[a-z]*'
```

`true` required. (A real end-to-end refire happens for free at step 2's restart if any
fault is latched.)

### 4. Physical checklist (no code)

- The **Buffer Tank** (backup element) breaker reads **OPEN** in planner `/health.backup_gate.relay`. It is kept OPEN
  on purpose; see the live safety layer in `CLAUDE.md`.
- The 6bb app is signed in, with notifications on, on the phone that will be in a pocket in January. Nobody subscribes
  to the ntfy topic, so ntfy is not a check here.
- Pi health card (Advanced) green.
- HBX wall controller reachable (CN23 bus) — E21 history means comm degradation shows
  there first.

## Paper trail

Log the drill + outcomes as a journal entry; file issues for any miss. The drill is
idempotent and safe: no setpoints, no writes, ~4.5 min without polling in step 2.
