#!/usr/bin/env bash
# @purpose BACKWARD ARM for #116 (epic #122 Wave 0). The gate's failure was not that it lacked a
# lease check -- it was that it reported "clean bracket: #113 merged, system healthy before and
# after" over a planner that was NOT holding the writer lease. So the test that matters is a replay:
# feed the fixed classifier the payload recorded at that exact moment and prove it now says unwell.
#
# Run: bash scripts/deploy-gate.test.sh     (no network, no live system touched)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DEPLOY_GATE_LIB_ONLY=1 . scripts/deploy-gate.sh

fails=0
ck() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"
  else printf '  FAIL %s — expected %q, got %q\n' "$1" "$2" "$3"; fails=1; fi
}

# ---- 1. THE #113 REPLAY. Verbatim from issue #116: this is what /health reported while the old
#         gate declared a clean bracket. The lease was unheld and did not return for ~11 min.
P113='{"ok":true,"writer_lease":{"held":false,"holder":"c0485e0004f3:15"},
       "phase_b":{"lastResults":{"pump1":"ok 61°C","pump2":"ok 61°C"}}}'
ck "#113: lease classified unheld"        "unheld" "$(lease_state "$P113")"
ck "#113: no holder reported when unheld" ""       "$(lease_holder "$P113")"

# The old gate looked only at .ok and phase_b — both clean here. That is precisely why it passed.
ck "#113: planner.ok really was true"     "true"   "$(jq -r '.ok' <<<"$P113")"
ck "#113: phase_b really was clean"       ""       "$(jq -r '[.phase_b.lastResults|to_entries[]|select(.value|test("failed"))|.key]|join(",")' <<<"$P113")"

# ---- 2. Healthy live shape (captured 2026-09-26T07:48Z during the High Wind Warning).
LIVE='{"ok":true,"writer_lease":{"held":true,"holder":"1655bad3a83e:15"},
       "phase_b":{"lastResults":{"pump1":"ok 61°C — ⚠ NO LEASE ARMED"}}}'
ck "live: held"                "held"             "$(lease_state "$LIVE")"
ck "live: holder surfaced"     "1655bad3a83e:15"  "$(lease_holder "$LIVE")"

# ---- 3. The non-object shapes index.ts can emit. "off" must NOT read as a fault: the lease being
#         disabled by config is a deployment choice. "pending" MUST, because it means unknown.
ck "off is not a fault"   "off"      "$(lease_state '{"writer_lease":"off"}')"
ck "pending is distinct" "pending"   "$(lease_state '{"writer_lease":"pending"}')"
ck "absent -> unknown"   "unknown"   "$(lease_state '{}')"
ck "off has no holder"   ""          "$(lease_holder '{"writer_lease":"off"}')"

# ---- 4. Holder-identity contract. Post-deploy "held" only counts if a DIFFERENT instance holds it;
#         otherwise we may have sampled before the outgoing instance let go.
before="$(lease_holder "$P113")"                       # unheld -> empty
after="$(lease_holder "$LIVE")"
ck "handover detectable" "yes" "$([ -n "$after" ] && [ "$after" != "$before" ] && echo yes || echo no)"
same='{"writer_lease":{"held":true,"holder":"1655bad3a83e:15"}}'
ck "same holder is NOT a handover" "no" \
  "$([ "$(lease_holder "$same")" != "1655bad3a83e:15" ] && echo yes || echo no)"

# ---- 5. CLASSIFICATION FAILS CLOSED (2026-09-27). #129 -- planner/src/storm.ts -- merged as
#         "deploying: no" because the file list read back empty and no-match meant no-deploy.
ck "empty list is UNKNOWN, never inert"      "unknown"   "$(printf '' | classify_files)"
ck "whitespace-only list is UNKNOWN"         "unknown"   "$(printf '  \n' | classify_files)"
ck "the exact #129 list is DEPLOYING"        "deploying" "$(printf 'planner/src/storm.test.ts\nplanner/src/storm.ts\n' | classify_files)"
ck "hub/ is DEPLOYING"                       "deploying" "$(printf 'hub/src/index.ts\n' | classify_files)"
ck "docs + scripts are INERT"                "inert"     "$(printf 'knowledge/reference/x.md\nscripts/y.sh\n.github/workflows/z.yml\n' | classify_files)"
# #164: Railway never reads .railway/ at deploy, and no watch pattern matches it, so its MERGE deploys nothing.
# `railway config apply` is the step that changes the services. Bracket that by hand (see .railway/railway.ts).
ck ".railway/ IaC is INERT at merge"         "inert"     "$(printf '.railway/railway.ts\n.railway/package.json\n.railway/package-lock.json\n' | classify_files)"

# #181: the services have different post-merge observables, so classify_services names WHICH deploy.
# The pair is always printed "planner hub" regardless of input order; the wrapper above stays coarse.
ck "services: hub-only list -> hub"          "hub"          "$(printf 'hub/src/index.ts\nhub/src/dropouts.ts\n' | classify_services)"
ck "services: planner-only -> planner"       "planner"      "$(printf 'planner/src/storm.test.ts\nplanner/src/storm.ts\n' | classify_services)"
ck "services: mixed -> planner hub"          "planner hub"  "$(printf 'hub/src/index.ts\nplanner/src/index.ts\n' | classify_services)"
ck "services: docs -> inert"                 "inert"        "$(printf 'knowledge/reference/x.md\nscripts/deploy-gate.sh\n' | classify_services)"
ck "services: empty -> unknown"              "unknown"      "$(printf '' | classify_services)"
ck "services: whitespace -> unknown"         "unknown"      "$(printf '\n  \n' | classify_services)"
ck "services: hub/ must be a path prefix"    "inert"        "$(printf 'docs/hub/notes.md\nhubris.md\nplanner-notes.md\n' | classify_services)"
ck "wrapper: hub-only is still DEPLOYING"    "deploying"    "$(printf 'hub/src/index.ts\n' | classify_files)"

# ---- 6. #166 dropout counts on the detail line. Absent (pre-#166 hub) must render EMPTY so the
#         probe output is unchanged until the hub actually deploys; present must show the counts;
#         an open dropout adds its running length. Never a gate input -- that is drift-check [6].
ck "pre-#166 hub: no dropout text"  ""  "$(dropout_summary '{"ok":true,"pi_connected":true,"last_state_ts":1}')"
ck "counts shown when present"      "dropouts24h=2 longest=130min" \
  "$(dropout_summary '{"ok":true,"pi_connected":true,"pi_dropouts_24h":2,"longest_dropout_min":130,"current_dropout_min":null}')"
ck "open dropout shows its length"  "dropouts24h=0 longest=0min current=45min" \
  "$(dropout_summary '{"ok":true,"pi_connected":false,"pi_dropouts_24h":0,"longest_dropout_min":0,"current_dropout_min":45}')"
ck "garbage json -> empty, not a crash" "" "$(dropout_summary 'not json')"

# ---- 7. #181 hub-only wait verdict. hub_recovered <json> <now> <stale_s> is the whole decision the
#         hub poll makes, with the clock injected. Returns 0 ONLY for connected + fresh. A brand-new
#         container reports pi_connected:false / last_state_ts:null until the Pi reconnects -- that
#         must read as disconnected, never as a crash or a pass.
rc() { hub_recovered "$@" >/dev/null && echo yes || echo no; }
FRESH='{"ok":true,"pi_connected":true,"last_state_ts":1000}'
ck "connected + fresh -> recovered"       "recovered(last push 30s ago)" "$(hub_recovered "$FRESH" 1030 180)"
ck "connected + fresh returns 0"          "yes"                          "$(rc "$FRESH" 1030 180)"
ck "connected + stale -> stale(age)"      "stale(400s)"                  "$(hub_recovered "$FRESH" 1400 180)"
ck "connected + stale returns 1"          "no"                           "$(rc "$FRESH" 1400 180)"
ck "exactly STALE_S old is still fresh"   "yes"                          "$(rc "$FRESH" 1180 180)"
DISC='{"ok":true,"pi_connected":false,"last_state_ts":1000,"current_dropout_min":0.5}'
ck "disconnected -> disconnected"         "disconnected"                 "$(hub_recovered "$DISC" 1030 180)"
ck "disconnected returns 1"               "no"                           "$(rc "$DISC" 1030 180)"
NEWBOX='{"ok":true,"pi_connected":false,"last_state_ts":null}'
ck "fresh container (null ts) -> disconnected" "disconnected"            "$(hub_recovered "$NEWBOX" 1030 180)"
ck "connected but never pushed -> stale"  "no"                           "$(rc '{"ok":true,"pi_connected":true,"last_state_ts":null}' 1030 180)"
ck "empty body -> unreachable"            "unreachable"                  "$(hub_recovered '' 1030 180)"
ck "empty body returns 1"                 "no"                           "$(rc '' 1030 180)"
ck "garbage json -> unreachable"          "unreachable"                  "$(hub_recovered 'not json' 1030 180)"

echo
[ "$fails" -eq 0 ] && echo "deploy-gate.test.sh: all assertions passed" || { echo "deploy-gate.test.sh: FAILURES"; exit 1; }
