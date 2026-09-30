#!/usr/bin/env bash
# @purpose Cold-day rehearsal: run the REAL planner (POLL_ONCE) twice against a LOCAL Postgres with every
# upstream faked (scripts/rehearsal/fake-upstreams.ts), then assert what it did. Never touches production:
# the DB must be localhost, SLX/hub/TempIQ/open-meteo all point at the fake, ntfy/email/SPAN stay unset.
#   scripts/rehearsal/run.sh [scenario]      scenario = cold-morning (default) | warm-evening | <path.json>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCEN="${1:-cold-morning}"
case "$SCEN" in
  *.json) SCEN_PATH="$SCEN" ;;
  *) SCEN_PATH="$HERE/scenarios/$SCEN.json" ;;
esac
[ -f "$SCEN_PATH" ] || { echo "no scenario at $SCEN_PATH"; exit 2; }
NAME="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["name"])' "$SCEN_PATH")"
DB="${REHEARSAL_DB:-a2w_rehearsal}"
DB_URL="postgres://$(whoami)@localhost:5432/$DB"
PORT="${REHEARSAL_PORT:-9101}"
OUT="$HERE/out/$NAME"; mkdir -p "$OUT"
FAKE="http://127.0.0.1:$PORT"

echo "── rehearsal: $NAME ─────────────────────────────────────────"
pg_isready -q -h localhost -p 5432 || { echo "local Postgres not running"; exit 2; }
dropdb --if-exists -h localhost -p 5432 "$DB"; createdb -h localhost -p 5432 "$DB"
echo "db         fresh $DB_URL"

( cd "$ROOT/planner" && npx tsc -p . && test -f dist/index.js ) || { echo "build      planner FAILED"; exit 1; }
echo "build      planner/dist ok"

# fake upstreams
REHEARSAL_PORT=$PORT REHEARSAL_SCENARIO="$SCEN_PATH" REHEARSAL_LOG="$OUT/requests.jsonl" SLX_SYNC_CODE=FAKE-0001 \
  npx -y tsx "$HERE/fake-upstreams.ts" > "$OUT/fake.log" 2>&1 &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf "$FAKE/__state" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "$FAKE/__state" >/dev/null || { echo "fake did not start"; cat "$OUT/fake.log"; exit 1; }
echo "fake       $FAKE (pid $FAKE_PID)"

run_planner() {
  local n="$1"
  ( cd "$ROOT/planner" && env -i PATH="$PATH" HOME="$HOME" \
    TZ=America/New_York POLL_ONCE=1 DATABASE_URL="$DB_URL" \
    SLX_BASE_URL="$FAKE" OPEN_METEO_URL="$FAKE" NWS_URL="$FAKE" OUTAGEWATCH_URL="$FAKE" \
    SENSORLINX_EMAIL=rehearsal SENSORLINX_PASSWORD=rehearsal SLX_BUILDING_ID=fake-building SLX_SYNC_CODE=FAKE-0001 \
    HUB_URL="$FAKE" HUB_CLIENT_TOKEN=t TEMPIQ_BASE_URL="$FAKE" TEMPIQ_SURFACE_TOKEN=t \
    WINTER_SOLVER_SHADOW=1 FLOOR_CADENCE=1 \
    AUTOPILOT_ENABLED=1 AUTOPILOT_DRY_RUN=0 PHASE_B_ENABLED=1 PHASE_B_DRY_RUN=0 PHASE_B_PUMPS=pump1,pump2 \
    IDENTIFICATION_ENABLED=1 IDENTIFICATION_MODE=armed \
    TEMPIQ_WINDOWS_ENABLED=1 TEMPIQ_PUSH_ENABLED=1 TEMPIQ_READ_ENABLED=1 FORECAST_FETCH_ENABLED=1 \
    SHAPED_CURVE="${REHEARSAL_SHAPED_CURVE:-shadow}" \
    node dist/index.js > "$OUT/planner-run$n.log" 2>&1 ) && echo "run $n      POLL_ONCE ok" || { echo "run $n      planner FAILED — tail:"; tail -20 "$OUT/planner-run$n.log"; exit 1; }
}
run_planner 1   # plans (a virgin DB has no plan yet, so the controllers no-op this run)
run_planner 2   # acts on run 1's plan: floor re-check, Phase B lead, auto-pilot writes the floor (driver idles: base not yet at plan)
psql -Atq -h localhost -p 5432 -d "$DB" -c "select count(*) from identification_windows" > "$OUT/ident-after-run2.txt"
curl -sf "$FAKE/__state" > "$OUT/fake-state-after-run2.json"
run_planner 3   # the plant now sits at the plan target → identification draws; auto-pilot held for the window
curl -sf "$FAKE/__state" > "$OUT/fake-state.json"
( cd "$ROOT/planner" && LOCAL_DATABASE_URL="$DB_URL" REHEARSAL_OUT="$OUT" REHEARSAL_SCENARIO="$SCEN_PATH" npx -y tsx "$HERE/assert.ts" )
