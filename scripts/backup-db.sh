#!/usr/bin/env bash
# @purpose Disaster-recovery snapshot of the Neon Postgres DB. The LIVE DB is the real archive
# -- nothing in planner/ or hub/ ever prunes, truncates, or expires a row, so history is already
# kept indefinitely. THIS is the belt-and-suspenders copy for the case where Neon itself is lost:
# its free-tier point-in-time recovery reaches only ~7 days. The dump is gzipped AND
# gpg-symmetric-encrypted (AES256) so it is safe to store even though this repo is PUBLIC, then
# the workflow commits it to the orphan db-backups branch (versioned, indefinite, no external
# account). A compressed dump of a ~100k-row/yr DB is a few MB, so the branch stays small.
#
# Env (both required):
#   DATABASE_URL       -- same Postgres connection string the planner uses
#   BACKUP_PASSPHRASE  -- symmetric key for the dump; store it somewhere OUTSIDE this repo
#                         (a password manager). Without it the backups are unrecoverable.
#
# Local run:  DATABASE_URL=... BACKUP_PASSPHRASE=... bash scripts/backup-db.sh
# Restore:    gpg -d a2w-db-STAMP.sql.gz.gpg | gunzip | psql "$TARGET_DATABASE_URL"
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "error: set DATABASE_URL (the planner Postgres connection string)" >&2
  exit 1
fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "error: set BACKUP_PASSPHRASE (symmetric key; keep it out of this repo)" >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="a2w-db-${STAMP}.sql.gz.gpg"

# --no-owner/--no-privileges keeps the dump portable to a fresh Neon project on restore.
# Passphrase via fd 3 (process substitution) so it never appears in the process argument list.
pg_dump --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 -o "$OUT" 3< <(printf '%s' "$BACKUP_PASSPHRASE")

SIZE="$(du -h "$OUT" | cut -f1)"
echo "wrote ${OUT} (${SIZE})"

# Hand the filename to the workflow next step (no-op when run locally).
echo "backup_file=${OUT}" >> "${GITHUB_ENV:-/dev/null}"
