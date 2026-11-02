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
#   scripts/deploy-gate.sh merge 123           # gate -> merge -> wait for the new build -> re-verify
#                                              #   planner/** (alone or with hub/**): wait for the writer
#                                              #     lease to change hands        (<= DEPLOY_DEADLINE_S)
#                                              #   hub/** only: wait for the hub to lose, then regain,
#                                              #     the Pi link                   (<= HUB_DEPLOY_DEADLINE_S)
#                                              #   anything else: inert, merged without a wait
#   scripts/deploy-gate.sh watch 20            # poll every 20s until healthy (Ctrl-C to stop)
#
# Env: PLANNER_URL, HUB_URL, STALE_S (180),
#      DEPLOY_DEADLINE_S (1500), LEASE_POLL_S (15)       -- planner lease handover
#      HUB_DEPLOY_DEADLINE_S (600), HUB_POLL_S (5)       -- hub-only Pi reconnect (#181)
set -uo pipefail

PLANNER="${PLANNER_URL:-https://a2w-planner-production.up.railway.app}"
HUB="${HUB_URL:-https://a2w-hub-production.up.railway.app}"
STALE_S="${STALE_S:-180}"
DEPLOY_WAIT_S="${DEPLOY_WAIT_S:-240}"          # retained for compatibility; no longer a blind sleep
# #116 measured ~11-15 min on 09-27; #139 (2026-09-29) measured 20 min: the old container kept
# heartbeating ~7 min after the new one came up, the lease is only claimable INSTANCE_FRESH_MS (12 min)
# after its last heartbeat, and the claim happens on the next 5-min poll. Worst case ≈ 7 + 12 + 5 = 24
# min, so 900 s reported a false REGRESSION on a healthy handover. 1500 s covers the measured worst case.
DEPLOY_DEADLINE_S="${DEPLOY_DEADLINE_S:-1500}"
LEASE_POLL_S="${LEASE_POLL_S:-15}"
# #181: a hub-only deploy never touches the planner's writer lease, so waiting for a holder change
# cost 25 min and ended in a false REGRESSION on every hub merge (#178 was healthy in 91 s). The hub
# has its own observable: the new container comes up with no Pi socket, the Pi's link to the old
# container drops when Railway retires it, and the Pi reconnects to the new one. Build + swap +
# reconnect measured ~1.5 min; 600 s is a generous bound. Poll fast enough to SEE the disconnected
# window -- that observation is what proves we are looking at the new container (see merge).
HUB_DEPLOY_DEADLINE_S="${HUB_DEPLOY_DEADLINE_S:-600}"
HUB_POLL_S="${HUB_POLL_S:-5}"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }

# Prints "ok|<detail>" or "bad|<detail>"; never exits, so callers decide.
# #116 helpers. writer_lease is one of: {held,holder} | "pending" | "off" (index.ts). Exported
# shape-handling so probe() and the reacquisition poll cannot disagree about what "held" means.
lease_state() {  # $1 = planner /health json -> held | unheld | pending | off | unknown
  jq -r 'if (.writer_lease|type) == "object"
         then (if .writer_lease.held then "held" else "unheld" end)
         else (.writer_lease // "unknown" | tostring) end' <<<"$1" 2>/dev/null || echo unknown
}
lease_holder() {  # $1 = planner /health json -> holder id, empty when not held
  jq -r 'if (.writer_lease|type) == "object" and .writer_lease.held
         then (.writer_lease.holder // "?") else "" end' <<<"$1" 2>/dev/null || echo ""
}

# #166: the hub counts Pi-link dropout episodes in /health (pi_dropouts_24h, longest_dropout_min,
# current_dropout_min while disconnected). Shown on the detail line, NOT gated: the gate asks "is
# the system healthy right now", and yesterday's 2 h dropout is drift-check's question ([6]).
# Empty until the #166 hub is deployed, so the line is byte-identical to before until then.
dropout_summary() {  # $1 = hub /health json -> "" | "dropouts24h=N longest=Mmin[ current=Kmin]"
  jq -r 'if (.pi_dropouts_24h|type) != "number" then "" else
           "dropouts24h=\(.pi_dropouts_24h) longest=\(.longest_dropout_min // 0)min"
           + (if (.current_dropout_min|type) == "number" then " current=\(.current_dropout_min)min" else "" end)
         end' <<<"$1" 2>/dev/null || echo ""
}

# Classification (2026-09-27, after #129 merged unbracketed). Pure function of the file list so it
# can be tested. Only planner/** and hub/** redeploy under the Railway watchPatterns. An EMPTY list
# is "unknown" -- never "inert": on #129 `gh pr view --json files` returned nothing for an instant
# and the old inline grep treated no-match as no-deploy.
#
# #181: the two services have different post-merge observables (planner: writer-lease handover;
# hub: Pi reconnect), so the classifier names WHICH services deploy. Output is exactly one of:
#   planner | hub | "planner hub" | inert | unknown     (the pair always in that order)
classify_services() {  # stdin = newline-separated paths
  local files out=""; files="$(cat)"
  [ -z "${files//[[:space:]]/}" ] && { echo unknown; return 0; }
  # .railway/ (#164) is inert HERE: Railway reads it only through `railway config apply`, never on a push.
  grep -qE '^planner/' <<<"$files" && out="planner"
  grep -qE '^hub/'     <<<"$files" && out="${out:+$out }hub"
  echo "${out:-inert}"
}
# Coarse wrapper kept for existing callers and assertions: deploying | inert | unknown.
classify_files() {  # stdin = newline-separated paths
  case "$(classify_services)" in
    unknown) echo unknown ;;
    inert)   echo inert ;;
    *)       echo deploying ;;
  esac
}
classify_pr() {  # $1 = PR number -> classify_services output; tries two sources before admitting it cannot tell
  local files
  files="$(gh pr view "$1" --json files --jq '.files[].path' 2>/dev/null)"
  [ -z "${files//[[:space:]]/}" ] && files="$(gh pr diff "$1" --name-only 2>/dev/null)"
  printf '%s' "$files" | classify_services
}

# #181: pure verdict on ONE hub /health sample, so the hub-only wait is testable without a network.
# Prints the verdict and returns 0 only when the hub is serving a connected, fresh Pi:
#   recovered(last push Ns ago) | disconnected | stale(Ns) | unreachable
# `unreachable` covers an empty body (curl failed) and unparseable JSON. A fresh container reports
# pi_connected:false and last_state_ts:null until the Pi reconnects and pushes -- that is "disconnected".
hub_recovered() {  # $1 = hub /health json (may be empty), $2 = now (epoch s), $3 = stale_s
  local verdict
  verdict="$(jq -r --argjson now "$2" --argjson stale "$3" '
      if .pi_connected != true then "disconnected"
      else (($now - (.last_state_ts // 0)) | floor) as $age
           | if $age > $stale then "stale(\($age)s)" else "recovered(last push \($age)s ago)" end
      end' <<<"${1:-}" 2>/dev/null)" || verdict=""
  [ -z "$verdict" ] && verdict="unreachable"
  echo "$verdict"
  [ "${verdict#recovered}" != "$verdict" ]
}

probe() {
  local hub planner pi age results lease drops="" bad=""
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
    drops="$(dropout_summary "$hub")"
  fi

  if [ -n "$planner" ]; then
    [ "$(jq -r '.ok' <<<"$planner")" != "true" ] && bad="${bad}planner-not-ok "
    # A Phase B result containing "failed" means we are not actually commanding the pumps.
    results="$(jq -r '[.phase_b.lastResults // {} | to_entries[] | select(.value|test("failed")) | .key] | join(",")' <<<"$planner")"
    [ -n "$results" ] && bad="${bad}phaseb-failing(${results}) "
    # #116: the ONE thing a planner redeploy actually disturbs, and the one thing this gate
    # could not see. A planner that is up, ok, and NOT holding the writer lease is silently
    # not commanding setpoints -- and used to pass as "healthy". `off` means the lease is
    # disabled by config, which is a deployment choice rather than a fault.
    lease="$(lease_state "$planner")"
    case "$lease" in
      held|off) ;;
      *) bad="${bad}writer-lease-${lease} " ;;
    esac
  fi

  if [ -n "$bad" ]; then echo "bad|${bad}${drops:+[$drops]}"; else
    echo "ok|pi connected, last push ${age}s ago, phase_b clean, lease ${lease}${drops:+, $drops}"
  fi
}

report() {  # $1 = label
  local r state detail
  r="$(probe)"; state="${r%%|*}"; detail="${r#*|}"
  printf '%-10s ' "$1"
  if [ "$state" = "ok" ]; then grn "OK    $detail"; return 0; else red "UNWELL $detail"; return 1; fi
}

# Allow the assertion suite to source the helpers without running a command.
if [ -n "${DEPLOY_GATE_LIB_ONLY:-}" ]; then return 0 2>/dev/null || exit 0; fi

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
    svc="$(classify_pr "$PR")"
    case "$svc" in
      unknown)
        red "REFUSING to merge #$PR: could not read its changed files from two sources, so it cannot be classified."
        red "An unreadable file list is not evidence the PR is inert -- on 2026-09-27 that assumption merged a"
        red "planner change with no bracket. Retry in a minute, or classify by hand with: gh pr view $PR --json files"
        exit 1 ;;
      inert) deploys=0 ;;
      *) deploys=1 ;;
    esac
    # #181: which post-merge observable applies. Planner (alone or with hub) -> lease handover,
    # which also outlasts any hub swap; hub alone -> the Pi reconnect, since nothing here will
    # ever change the planner's lease holder.
    case " $svc " in *" planner "*) deploys_planner=1 ;; *) deploys_planner=0 ;; esac

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

    # #116: remember WHO held the lease before the merge. "Held" after a deploy is only
    # meaningful if a DIFFERENT instance holds it -- otherwise we may simply have sampled
    # before the outgoing instance let go.
    BEFORE_HOLDER="$(lease_holder "$(curl -sf -m 15 "$PLANNER/health" 2>/dev/null || echo '{}')")"
    [ -n "$BEFORE_HOLDER" ] && echo "           lease held by ${BEFORE_HOLDER} before the merge"

    echo
    echo "── MERGING #$PR (deploying: $([ $deploys -eq 1 ] && echo "YES — $svc" || echo no)) ──"
    gh pr merge "$PR" --squash --delete-branch || { red "merge failed"; exit 1; }

    if [ "$deploys" -eq 0 ]; then
      grn "non-deploying PR — no live surface to verify."
      # Record the after-state, but do NOT let it set the exit code: this PR cannot have
      # touched a live surface, so failing here would report an unrelated ongoing outage as
      # "the merge failed". Conflating those two is exactly the kind of bad signal that makes
      # people stop trusting a gate.
      report "after" || true
      exit 0
    fi

    echo
    deploy_started=$(date +%s); handover=""
    if [ "$deploys_planner" -eq 1 ]; then
      measured="handover"
      echo "── WAITING FOR THE WRITER LEASE TO RETURN (deadline ${DEPLOY_DEADLINE_S}s) ──"
      # #116: DEPLOY_WAIT_S defaulted to 240 s while the real handover measured ~11 min on #113
      # (live-state documents ~15 min). So the post-merge verify ran systematically INSIDE the
      # handover, and a fixed sleep could not distinguish "in progress" from "stuck" -- it
      # reported a blind wait as a clean bracket. Poll instead, and make each deploy MEASURE the
      # handover rather than guess at it.
      while :; do
        elapsed=$(( $(date +%s) - deploy_started ))
        now_holder="$(lease_holder "$(curl -sf -m 15 "$PLANNER/health" 2>/dev/null || echo '{}')")"
        if [ -n "$now_holder" ] && [ "$now_holder" != "$BEFORE_HOLDER" ]; then
          handover="$elapsed"
          grn "lease reacquired after ${handover}s by ${now_holder} (was ${BEFORE_HOLDER:-none})"
          break
        fi
        if [ "$elapsed" -ge "$DEPLOY_DEADLINE_S" ]; then
          red "lease NOT reacquired within ${DEPLOY_DEADLINE_S}s (still ${now_holder:-unheld})."
          red "The planner may be up and healthy while silently not commanding setpoints."
          break
        fi
        printf '\r           waiting… %ds (holder: %s)' "$elapsed" "${now_holder:-unheld}"
        sleep "$LEASE_POLL_S"
      done
    else
      measured="Pi reconnect"
      echo "── WAITING FOR THE NEW HUB TO REGAIN THE PI (deadline ${HUB_DEPLOY_DEADLINE_S}s) ──"
      # #181: hub-only. /health carries no instance id, and the OLD container keeps answering
      # "connected, fresh" for the 1-2 min the new build takes -- so "poll until healthy" alone
      # would pass at 0 s against the outgoing hub, the same trap #116 closed for the planner by
      # demanding a DIFFERENT lease holder. The hub's equivalent of a holder change is the link
      # dip: the new container serves pi_connected:false until the Pi's socket to the retired
      # container drops and it reconnects. Require that dip, THEN recovery, and measure both.
      # Only an ANSWERED non-recovered sample (disconnected / stale) counts as the dip: a curl
      # failure on its own is a transport blip, not evidence that a new container is serving.
      dip=""
      while :; do
        elapsed=$(( $(date +%s) - deploy_started ))
        hub_now="$(curl -sf -m 15 "$HUB/health" 2>/dev/null || echo '')"
        if verdict="$(hub_recovered "$hub_now" "$(date +%s)" "$STALE_S")"; then
          if [ -n "$dip" ]; then
            handover="$elapsed"
            grn "hub regained the Pi after ${handover}s (link lost at ${dip}s; ${verdict})"
            break
          fi
        elif [ -z "$dip" ] && [ "$verdict" != "unreachable" ]; then
          dip="$elapsed"
          printf '\n'; echo "           hub lost the Pi at ${dip}s (${verdict}) — new container is serving"
        fi
        if [ "$elapsed" -ge "$HUB_DEPLOY_DEADLINE_S" ]; then
          if [ -z "$dip" ]; then
            red "hub never lost the Pi within ${HUB_DEPLOY_DEADLINE_S}s: no new container was observed."
            red "Either Railway did not deploy (the 2026-09-29 trap — check: railway deployment list)"
            red "or the swap beat the ${HUB_POLL_S}s poll. Confirm the deployment by hand before trusting this merge."
          else
            red "hub did NOT regain the Pi within ${HUB_DEPLOY_DEADLINE_S}s (link lost at ${dip}s, now: ${verdict})."
            red "The new hub is up but the Pi has not reconnected to it -- nothing can relay setpoints."
          fi
          break
        fi
        printf '\r           waiting… %ds (hub: %s)' "$elapsed" "$verdict"
        sleep "$HUB_POLL_S"
      done
    fi
    printf '\n'

    echo "── POST-MERGE VERIFY ───────────────────────────────────"
    if [ -n "$handover" ] && report "after"; then
      grn "clean bracket: #$PR merged, healthy before and after; ${measured} ${handover}s."
      exit 0
    fi
    red "REGRESSION after merging #$PR."
    red "You now have a known-good bracket: it was healthy immediately before this merge."
    red "Do NOT merge anything else until this is understood."
    exit 1
    ;;

  *) echo "usage: $0 {status|merge <pr>|watch [seconds]}" >&2; exit 2 ;;
esac
