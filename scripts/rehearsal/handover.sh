#!/usr/bin/env bash
# @purpose Writer-lease HANDOVER rehearsal (a2w #162): two REAL planners against the LOCAL rehearsal DB with every
# upstream faked, lease enabled. A holds the lease; B waits; SIGTERM A; assert A released the row within seconds and
# B claimed it within the 20 s retry — not the 12-min staleness wait prod paid (649–981 s measured 2026-10-01).
# Then SIGTERM B and assert it released too. Never touches production: same localhost guards as run.sh.
#   scripts/rehearsal/handover.sh [scenario]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCEN="${1:-cold-morning}"
case "$SCEN" in *.json) SCEN_PATH="$SCEN" ;; *) SCEN_PATH="$HERE/scenarios/$SCEN.json" ;; esac
[ -f "$SCEN_PATH" ] || { echo "no scenario at $SCEN_PATH"; exit 2; }
DB="${REHEARSAL_DB:-a2w_rehearsal_handover}"
case "$DB" in a2w_rehearsal|a2w_rehearsal_*) ;; *) echo "refusing: REHEARSAL_DB must be a2w_rehearsal or a2w_rehearsal_*"; exit 2 ;; esac
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "refusing: REHEARSAL_DB is not a plain identifier"; exit 2; }
DB_URL="postgres://$(whoami)@localhost:5432/$DB"
PORT="${REHEARSAL_PORT:-9111}"
OUT="$HERE/out/handover"; mkdir -p "$OUT"
FAKE="http://127.0.0.1:$PORT"
PA="${REHEARSAL_PLANNER_A_PORT:-9201}"; PB="${REHEARSAL_PLANNER_B_PORT:-9202}"

echo "── handover rehearsal ─────────────────────────────────────────"
pg_isready -q -h localhost -p 5432 || { echo "local Postgres not running"; exit 2; }
dropdb --if-exists -h localhost -p 5432 "$DB"; createdb -h localhost -p 5432 "$DB"
( cd "$ROOT/planner" && npx tsc -p . && test -f dist/index.js ) || { echo "build      planner FAILED"; exit 1; }
TZ=America/New_York REHEARSAL_PORT=$PORT REHEARSAL_SCENARIO="$SCEN_PATH" REHEARSAL_LOG="$OUT/requests.jsonl" SLX_SYNC_CODE=FAKE-0001 \
  npx -y tsx "$HERE/fake-upstreams.ts" > "$OUT/fake.log" 2>&1 &
FAKE_PID=$!
PIDS=("$FAKE_PID")
trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT
for i in $(seq 1 40); do curl -sf "$FAKE/__state" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "$FAKE/__state" >/dev/null || { echo "fake did not start"; cat "$OUT/fake.log"; exit 1; }

start_planner() { # name port
  local name="$1" port="$2"
  ( cd "$ROOT/planner" && env -i PATH="$PATH" HOME="$HOME" \
    TZ=America/New_York PORT="$port" DATABASE_URL="$DB_URL" WRITER_LEASE_ENABLED=1 \
    SLX_BASE_URL="$FAKE" OPEN_METEO_URL="$FAKE" NWS_URL="$FAKE" OUTAGEWATCH_URL="$FAKE" \
    SENSORLINX_EMAIL=rehearsal SENSORLINX_PASSWORD=rehearsal SLX_BUILDING_ID=fake-building SLX_SYNC_CODE=FAKE-0001 \
    HUB_URL="$FAKE" HUB_CLIENT_TOKEN=t TEMPIQ_BASE_URL="$FAKE" TEMPIQ_SURFACE_TOKEN=t \
    AUTOPILOT_ENABLED=1 AUTOPILOT_DRY_RUN=0 PHASE_B_ENABLED=1 PHASE_B_DRY_RUN=0 PHASE_B_PUMPS=pump1,pump2 \
    FORECAST_FETCH_ENABLED=1 SHAPED_CURVE=shadow \
    node dist/index.js ) > "$OUT/planner-$name.log" 2>&1 &
  echo $!
}
# NB: the redirection is on the BACKGROUNDED subshell itself, so the planner does not inherit the $(...) capture pipe —
# with the redirect inside, start_planner never returned (the pipe stayed open for the planner's lifetime).
health() { curl -sf -m 5 "http://127.0.0.1:$1/health" 2>/dev/null || echo '{}'; }
lease_field() { python3 -c 'import sys,json; d=json.load(sys.stdin); l=d.get("writer_lease"); print((l or {}).get("held") if isinstance(l,dict) else l, (l or {}).get("holder") if isinstance(l,dict) else "")'; }
holder_row() { psql -Atq -h localhost -p 5432 -d "$DB" -c "select coalesce(holder,'NULL') from hbx_writer_lease where id=1" 2>/dev/null || echo "no-row"; }
fail=0; chk() { if [ "$1" = "true" ]; then echo "  ok    $2"; else echo "  FAIL  $2"; fail=$((fail+1)); fi; }

A_PID=$(start_planner A "$PA"); PIDS+=("$A_PID")
for i in $(seq 1 120); do read -r held holder < <(health "$PA" | lease_field); [ "$held" = "True" ] && break; sleep 1; done
read -r held holderA < <(health "$PA" | lease_field)
chk "$([ "$held" = "True" ] && echo true || echo false)" "planner A holds the lease (holder $holderA)"

B_PID=$(start_planner B "$PB"); PIDS+=("$B_PID")
for i in $(seq 1 60); do h=$(health "$PB"); [ "$h" != "{}" ] && break; sleep 1; done
read -r heldB holderB < <(health "$PB" | lease_field)
chk "$([ "$heldB" = "False" ] && echo true || echo false)" "planner B is up and does NOT hold the lease (sees holder $holderB)"

T0=$(date +%s)
kill -TERM "$A_PID"
released_at=""
for i in $(seq 1 100); do r=$(holder_row); if [ "$r" = "NULL" ] || { [ "$r" != "$holderA" ] && [ "$r" != "no-row" ]; }; then released_at=$(( $(date +%s%N)/1000000 )); break; fi; sleep 0.1; done
chk "$([ -n "$released_at" ] && echo true || echo false)" "A released the lease row within 10 s of SIGTERM (row now: $(holder_row))"
wait "$A_PID" 2>/dev/null; rcA=$?
chk "$([ "$rcA" = "0" ] && echo true || echo false)" "A exited 0 (rc $rcA)"
chk "$(grep -q '\[shutdown\] SIGTERM: writer lease released' "$OUT/planner-A.log" && echo true || echo false)" "A logged the release"
for i in $(seq 1 90); do read -r heldB holderB < <(health "$PB" | lease_field); [ "$heldB" = "True" ] && break; sleep 1; done
T1=$(date +%s)
chk "$([ "$heldB" = "True" ] && echo true || echo false)" "B holds the lease $((T1-T0)) s after A's SIGTERM (holder $holderB) — the 20 s claim retry, not the 12-min staleness wait"
chk "$([ $((T1-T0)) -le 60 ] && echo true || echo false)" "handover ≤ 60 s (was 649–981 s in prod)"
chk "$([ "$(psql -Atq -h localhost -p 5432 -d "$DB" -c "select count(*) from planner_instances where instance_id='$holderA'")" = "0" ] && echo true || echo false)" "A's heartbeat row was dropped"
chk "$([ "$(psql -Atq -h localhost -p 5432 -d "$DB" -c "select count(*) from hbx_writes where result='rejected' and detail like '%does not hold the single-writer lease%'")" = "0" ] && echo true || echo false)" "no write was refused for lack of the lease during the handover"

kill -TERM "$B_PID"; wait "$B_PID" 2>/dev/null; rcB=$?
chk "$([ "$rcB" = "0" ] && echo true || echo false)" "B exited 0 on SIGTERM (rc $rcB)"
chk "$([ "$(holder_row)" = "NULL" ] && echo true || echo false)" "B released the lease on its way out (row: $(holder_row))"
echo; [ "$fail" = "0" ] && echo "HANDOVER REHEARSAL PASSED" || { echo "HANDOVER REHEARSAL FAILED — $fail check(s)"; tail -20 "$OUT/planner-A.log"; exit 1; }
