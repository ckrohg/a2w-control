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
HEALTH_URL="${A2W_HEALTH_URL:-http://localhost:8000/api/health}"
RESTART_CMD="${A2W_RESTART_CMD:-sudo systemctl restart heatpump-bridge}"
TAG_GLOB="${A2W_TAG_GLOB:-release-*}"
export PATH="$HOME/.local/bin:$PATH"

cd "$REPO"
git fetch -q origin --tags --prune --force
current=$(git rev-parse HEAD)
latest_tag=$(git tag -l "$TAG_GLOB" --sort=-creatordate | head -1)

if [ -z "$latest_tag" ]; then
  echo "no release tag matching '$TAG_GLOB' — not deploying from mutable main"
  exit 0
fi
target=$(git rev-list -n 1 "$latest_tag")

if [ "$current" = "$target" ]; then
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
    rm -f "$STATE"
    exit 0
  fi
  sleep 2
done

echo "HEALTH CHECK FAILED on $target — rolling back to $current"
apply "$current" || echo "rollback apply failed — manual attention needed"
exit 1
