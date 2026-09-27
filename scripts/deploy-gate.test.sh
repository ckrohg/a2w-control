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

echo
[ "$fails" -eq 0 ] && echo "deploy-gate.test.sh: all assertions passed" || { echo "deploy-gate.test.sh: FAILURES"; exit 1; }
