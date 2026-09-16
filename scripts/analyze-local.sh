#!/usr/bin/env bash
# @purpose Restore the latest encrypted db-backup into a LOCAL Postgres so analysis never
# touches production.
#
# WHY. On 2026-09-16 I ran 19k-row window-function joins against the live Railway Postgres --
# the same database the house's telemetry ingests into -- to answer #89 and #76. The evidence
# says it did not cause that day's outage (ingest held a steady 2 rows/min right up to the
# cliff, and starvation degrades before it stops). It was still an unforced risk taken on live
# infrastructure for questions that a week-old snapshot answers just as well.
#
# The backups already exist: scripts/backup-db.sh writes an encrypted dump to the db-backups
# orphan branch every Monday. This restores the newest one locally. Same schema, same history,
# zero production load, and you can be as reckless as you like with the queries.
#
# Requires: a local postgres (brew install postgresql@17 && brew services start postgresql@17)
# Passphrase: $BACKUP_PASSPHRASE, else macOS Keychain item `a2w-backup-passphrase`.
#
# Usage:  scripts/analyze-local.sh [dbname]        # default a2w_local
#         psql a2w_local -c "select ..."           # then query freely
set -euo pipefail

DB="${1:-a2w_local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v psql >/dev/null || { echo "error: psql not found (brew install postgresql@17)" >&2; exit 1; }
pg_isready -q 2>/dev/null || { echo "error: no local postgres running (brew services start postgresql@17)" >&2; exit 1; }

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  BACKUP_PASSPHRASE="$(security find-generic-password -s a2w-backup-passphrase -w 2>/dev/null || true)"
fi
[ -z "${BACKUP_PASSPHRASE:-}" ] && {
  echo "error: no passphrase. Store it once (no echo, never hits shell history):" >&2
  echo "  security add-generic-password -a \"\$USER\" -s a2w-backup-passphrase -w" >&2
  exit 1; }

echo "==> fetching db-backups"
git fetch -q origin db-backups
LATEST="$(git ls-tree -r --name-only origin/db-backups | grep '^a2w-db-.*\.sql\.gz\.gpg$' | sort | tail -1)"
[ -z "$LATEST" ] && { echo "error: no backup found on the db-backups branch" >&2; exit 1; }
echo "    newest: $LATEST"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git show "origin/db-backups:$LATEST" > "$TMP/dump.gz.gpg"

echo "==> decrypting + restoring into '$DB' (dropping any existing copy)"
dropdb --if-exists "$DB"
createdb "$DB"
gpg --batch --quiet --decrypt --passphrase-fd 3 "$TMP/dump.gz.gpg" 3< <(printf '%s' "$BACKUP_PASSPHRASE") \
  | gunzip \
  | psql -q -d "$DB" -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true

ROWS="$(psql -Atd "$DB" -c "select count(*) from readings" 2>/dev/null || echo 0)"
TABLES="$(psql -Atd "$DB" -c "select count(*) from pg_tables where schemaname='public'" 2>/dev/null || echo 0)"
echo
echo "restored: $TABLES tables, $ROWS rows in readings"
echo "snapshot is from ${LATEST#a2w-db-}; anything newer than that is NOT here."
echo
echo "query it with:   psql $DB"
echo "NEVER analyse against production -- that is what this script is for."
