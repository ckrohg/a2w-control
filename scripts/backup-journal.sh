#!/usr/bin/env bash
# @purpose Disaster-recovery snapshot of the TENET workspace journal
# (.tenet/journal/main.jsonl) — the decision history for this project: every trap, every
# "don't 'fix' this asymmetry" pin, every rejected approach and why. Unlike the DB, this file
# is UNTRACKED and exists ONLY on the owner's laptop, so no GitHub Action can reach it; this
# script must run locally. Mirrors scripts/backup-db.sh exactly: gzip + gpg symmetric AES256
# (safe to store even though this repo is PUBLIC), committed to the `journals` orphan branch
# that tenet-new created for precisely this purpose and which has been empty since init.
#
# The journal was scanned for credential patterns (postgres URLs, JWTs, ghp_/github_pat_, re_,
# sk-/sk-ant-, Bearer, AKIA) and is clean — but it contains room names, family first names, DHW
# draw timestamps (an occupancy signal) and the property UUID, so it is encrypted regardless.
#
# Passphrase resolution, in order:
#   1. $BACKUP_PASSPHRASE if already exported
#   2. macOS Keychain item `a2w-backup-passphrase`
# Use the SAME passphrase as the DB backups (one key for both, already in your password
# manager). Store it once with:
#   security add-generic-password -a "$USER" -s a2w-backup-passphrase -w
# (that prompts with no echo — the secret never lands in shell history or a transcript)
#
# Local run: bash scripts/backup-journal.sh
# Restore:   gpg -d a2w-journal-STAMP.jsonl.gz.gpg | gunzip > main.jsonl
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

JOURNAL=".tenet/journal/main.jsonl"
if [ ! -f "$JOURNAL" ]; then
  echo "error: $JOURNAL not found — nothing to back up" >&2
  exit 1
fi

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  BACKUP_PASSPHRASE="$(security find-generic-password -s a2w-backup-passphrase -w 2>/dev/null || true)"
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  cat >&2 <<'MSG'
error: no passphrase available.

Store it once in the Keychain (no echo, never hits shell history):
  security add-generic-password -a "$USER" -s a2w-backup-passphrase -w

Use the SAME value as the BACKUP_PASSPHRASE repo secret so one key opens both the DB
and journal backups. Every future run of this script is then fully automatic.
MSG
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="a2w-journal-${STAMP}.jsonl.gz.gpg"
LINES="$(wc -l < "$JOURNAL" | tr -d ' ')"

# Passphrase via fd 3 so it never appears in the process argument list (same as backup-db.sh).
gzip -9 -c "$JOURNAL" \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 -o "$OUT" 3< <(printf '%s' "$BACKUP_PASSPHRASE")

echo "wrote ${OUT} ($(du -h "$OUT" | cut -f1), ${LINES} journal entries)"

# Commit to the `journals` orphan branch via a scratch worktree, so the working tree and the
# current branch are never disturbed. The branch already exists (tenet-new created it).
WT="$(mktemp -d)/journals"
git fetch -q origin journals 2>/dev/null || true
git worktree add -q "$WT" journals
mv "$OUT" "$WT/"
git -C "$WT" add "$OUT"
git -C "$WT" -c user.name="a2w-backup-bot" -c user.email="noreply@users.noreply.github.com" \
    commit -q -m "journal backup ${OUT} (${LINES} entries)"
git -C "$WT" push -q origin journals
git worktree remove --force "$WT"
echo "pushed ${OUT} to the journals branch."
