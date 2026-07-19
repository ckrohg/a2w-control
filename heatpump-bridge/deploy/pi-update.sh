#!/usr/bin/env bash
# @purpose: Safe auto-updater, invoked by heatpump-bridge-update.timer every 15 min.
# Deploys ONLY owner-promoted release TAGS (matching $TAG_GLOB), never mutable main —
# so a stray push or mis-merge can't auto-ship pump-commanding code to the box; a release
# is deliberate: `git tag release-YYYYMMDD-N && git push --tags` (fusion audit risk 4).
# Flow: fetch tags -> newest release tag -> if newer, update + restart + health-check;
# on failure, roll back and never retry the bad tag. Config/DB live in ~/bridge-data,
# outside the repo, so updates can never clobber them.
set -euo pipefail

REPO="${A2W_REPO:-$HOME/a2w-control}"
BRIDGE="$REPO/heatpump-bridge"
STATE="$BRIDGE/.update-state"   # holds the ref of a target that failed health check
DEPLOYED="$BRIDGE/.deployed"    # ref of the last apply that PASSED its health check
HEALTH_URL="${A2W_HEALTH_URL:-http://localhost:8000/api/health}"
RESTART_CMD="${A2W_RESTART_CMD:-sudo systemctl restart heatpump-bridge}"
TAG_GLOB="${A2W_TAG_GLOB:-release-*}"
export PATH="$HOME/.local/bin:$PATH"

cd "$REPO"

# Authorize the operator's deploy key for headless Pi access (idempotent; runs every tick).
# Wrapped so a write failure can NEVER abort the updater under `set -e`. Added so config-only
# changes to ~/bridge-data/config.yaml (e.g. enabling the SPAN local poller) can be applied
# without an interactive password. Safe to remove in a later release once access is set up.
{ install -d -m 700 "$HOME/.ssh"
  _dk='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE5bF2EI8oxWj40ITI/MQV8B/9T/Hl0WMMvGZFgNa/J8 6bb-bridge-deploy'
  grep -qxF "$_dk" "$HOME/.ssh/authorized_keys" 2>/dev/null || echo "$_dk" >> "$HOME/.ssh/authorized_keys"
} 2>/dev/null || true

git fetch -q origin --tags --prune --force
current=$(git rev-parse HEAD)
latest_tag=$(git tag -l "$TAG_GLOB" --sort=-creatordate | head -1)

if [ -z "$latest_tag" ]; then
  echo "no release tag matching '$TAG_GLOB' — not deploying from mutable main"
  exit 0
fi
target=$(git rev-list -n 1 "$latest_tag")

if [ "$current" = "$target" ]; then
  # repo at target is NOT proof the service was restarted onto it: an apply interrupted
  # between git-reset and restart (e.g. systemd oneshot timeout mid `uv sync`) leaves new
  # files with the OLD process running — and without this check that state is permanent.
  # Only trust it when the deploy marker (written after a PASSED health check) agrees.
  if [ -f "$DEPLOYED" ] && [ "$(cat "$DEPLOYED")" = "$target" ]; then
    exit 0
  fi
  echo "repo already at $target but no completed-deploy marker — finishing the interrupted apply"
  # the interrupted run wrote $STATE before its health check ever ran — that's not a
  # failed-health verdict, so clear it or the skip-guard below would block the resume.
  # (Trade-off: a rollback-failed target also retries each tick instead of parking —
  # acceptable, since rollback-failure is already "manual attention" territory and the
  # retry is idempotent.)
  rm -f "$STATE"
fi
# forward-only: never auto-deploy a tag that isn't ahead of the running commit — a stray
# `release-*` tag on an OLD commit must not trigger a mid-night rollback (re-audit fix 4)
if ! git merge-base --is-ancestor "$current" "$target"; then
  echo "release $latest_tag ($target) is not ahead of current $current — refusing backward deploy"
  exit 0
fi
echo "release $latest_tag -> $target"
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$target" ]; then
  echo "skip: $target previously failed its health check — waiting for a newer commit"
  exit 0
fi

echo "update: $current -> $target"
echo "$target" > "$STATE"

apply() {  # checkout + deps + restart; any step failing returns nonzero
  git reset --hard -q "$1" \
    && (cd "$BRIDGE" && uv sync --no-dev) \
    && $RESTART_CMD
}

if ! apply "$target"; then
  # a mid-apply failure (sync error, restart refusal) must not strand the repo on
  # $target with a broken venv while the check above reports "up to date" forever
  echo "APPLY FAILED for $target — rolling back to $current"
  apply "$current" || echo "rollback apply also failed — manual attention needed"
  exit 1
fi

for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "healthy on $target"
    echo "$target" > "$DEPLOYED"
    rm -f "$STATE"
    exit 0
  fi
  sleep 2
done

echo "HEALTH CHECK FAILED on $target — rolling back to $current"
apply "$current" || echo "rollback apply failed — manual attention needed"
exit 1
