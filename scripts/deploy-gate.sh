#!/usr/bin/env bash
# @purpose Make "verify between deploys" a mechanism instead of a discipline.
#
# WHY THIS EXISTS. On 2026-09-16 nine PRs were merged in one session, four of them inside five
# minutes, spanning a live planner deploy at 14:04. The Pi's telemetry stopped dead at 14:15.
# Nothing deployed to the Pi (no release-* tag was cut) and the hub never redeployed, so the
# merges were almost certainly not causal -- but that is a reconstruction, not a record. The
# real cost of merging in a burst was that it left NO known-good bracket around the failure, so
# the honest answer to "did we cause it?" became "probably not" instead of "no".
#
# This script brackets every deploying merge with a health snapshot, so next time the answer is
# a fact. It refuses to proceed from an already-unhealthy baseline (never stack a deploy on top
# of an unexplained outage) and reports a regression loudly if one appears after.
#
# Read-only against the live system apart from the `gh pr merge` you explicitly ask for.
# Never cuts a release-* tag -- nothing here can reach the Pi.
#
# Usage:
#   scripts/deploy-gate.sh status              # one health snapshot, exit 1 if unhealthy
#   scripts/deploy-gate.sh merge 123           # gate -> merge -> wait -> re-verify
#   scripts/deploy-gate.sh watch 20            # poll every 20s until healthy (Ctrl-C to stop)
#
# Env: PLANNER_URL, HUB_URL, STALE_S (default 180), DEPLOY_WAIT_S (default 240)
set -uo pipefail

PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
STALE_S="${STALE_S:-180}"
DEPLOY_WAIT_S="${DEPLOY_WAIT_S:-240}"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }

# Prints "ok|<detail>" or "bad|<detail>"; never exits, so callers decide.
probe() {
  local hub planner pi age results bad=""
  hub="$(curl -sf -m 15 "$HUB/health" 2>/dev/null)" || hub=""
  planner="$(curl -sf -m 15 "$PLANNER/health" 2>/dev/null)" || planner=""

  [ -z "$hub" ]     && bad="${bad}hub-unreachable "
  [ -z "$planner" ] && bad="${bad}planner-unreachable "

  if [ -n "$hub" ]; then
    pi="$(jq -r '.pi_connected' <<<"$hub")"
    [ "$pi" != "true" ] && bad="${bad}pi-disconnected "
    # last_state_ts is when the Pi last pushed. Stale = the Pi went quiet even if the socket
    # has not been reaped yet -- the earlier signal of the two.
    age="$(jq -r --argjson now "$(date +%s)" '($now - (.last_state_ts // 0)) | floor' <<<"$hub")"
    [ "$age" -gt "$STALE_S" ] 2>/dev/null && bad="${bad}pi-stale(${age}s) "
  fi

  if [ -n "$planner" ]; then
    [ "$(jq -r '.ok' <<<"$planner")" != "true" ] && bad="${bad}planner-not-ok "
    # A Phase B result containing "failed" means we are not actually commanding the pumps.
    results="$(jq -r '[.phase_b.lastResults // {} | to_entries[] | select(.value|test("failed")) | .key] | join(",")' <<<"$planner")"
    [ -n "$results" ] && bad="${bad}phaseb-failing(${results}) "
  fi

  if [ -n "$bad" ]; then echo "bad|${bad}"; else
    echo "ok|pi connected, last push ${age}s ago, phase_b clean"
  fi
}

report() {  # $1 = label
  local r state detail
  r="$(probe)"; state="${r%%|*}"; detail="${r#*|}"
  printf '%-10s ' "$1"
  if [ "$state" = "ok" ]; then grn "OK    $detail"; return 0; else red "UNWELL $detail"; return 1; fi
}

case "${1:-status}" in
  status)
    report "now"; exit $?
    ;;

  watch)
    every="${2:-20}"
    echo "polling every ${every}s until healthy — Ctrl-C to stop"
    until report "$(date -u +%H:%M:%S)"; do sleep "$every"; done
    grn "recovered."
    ;;

  merge)
    PR="${2:-}"
    [ -z "$PR" ] && { echo "usage: $0 merge <pr-number>" >&2; exit 2; }

    # Classify FIRST. The health gate applies only to PRs that actually deploy: refusing an
    # inert docs/CI merge because the system is unwell would, among other things, have blocked
    # the write-up OF an incident during that incident. Only planner/** and hub/** redeploy
    # under the watchPatterns; everything else cannot touch a live surface.
    files="$(gh pr view "$PR" --json files --jq '.files[].path' 2>/dev/null)"
    deploys=0
    grep -qE '^(planner|hub)/' <<<"$files" && deploys=1

    echo "── PRE-MERGE GATE ──────────────────────────────────────"
    if [ "$deploys" -eq 1 ]; then
      if ! report "before"; then
        red "REFUSING to merge #$PR: it deploys a live service and the system is already unhealthy."
        red "Stacking a deploy on an unexplained outage is how you lose the ability to"
        red "attribute the next failure. Resolve this first, or override deliberately."
        exit 1
      fi
    else
      report "before" || true   # recorded for the log, not a gate: this PR deploys nothing
      echo "           (non-deploying PR — health is recorded, not enforced)"
    fi

    echo
    echo "── MERGING #$PR (deploying: $([ $deploys -eq 1 ] && echo YES || echo no)) ──"
    gh pr merge "$PR" --squash --delete-branch || { red "merge failed"; exit 1; }

    if [ "$deploys" -eq 0 ]; then
      grn "non-deploying PR — no live surface to verify."
      report "after"; exit $?
    fi

    echo
    echo "── WAITING ${DEPLOY_WAIT_S}s FOR THE DEPLOY TO SETTLE ──"
    # A planner redeploy hands the writer lease over; ~15 min of lease churn is NORMAL and is
    # not what we are checking for. We are checking the Pi is still there and Phase B recovers.
    sleep "$DEPLOY_WAIT_S"

    echo "── POST-MERGE VERIFY ───────────────────────────────────"
    if report "after"; then
      grn "clean bracket: #$PR merged, system healthy before and after."
      exit 0
    fi
    red "REGRESSION after merging #$PR."
    red "You now have a known-good bracket: it was healthy immediately before this merge."
    red "Do NOT merge anything else until this is understood."
    exit 1
    ;;

  *) echo "usage: $0 {status|merge <pr>|watch [seconds]}" >&2; exit 2 ;;
esac
