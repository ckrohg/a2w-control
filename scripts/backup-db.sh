#!/usr/bin/env bash
# @purpose Disaster-recovery snapshot of the live Railway Postgres DB (Neon until 2026-08-23, #79). The LIVE DB is the real archive
# -- nothing in planner/ or hub/ ever prunes, truncates, or expires a row, so history is already
# kept indefinitely. THIS is the belt-and-suspenders copy for the case where the database itself
# is lost. The dump is gzipped AND
# gpg-symmetric-encrypted (AES256) so it is safe to store even though this repo is PUBLIC, then
# the workflow commits it to the orphan db-backups branch (versioned, indefinite, no external
# account).
#
# Env (both required):
#   DATABASE_URL       -- the live DB's PUBLIC connection string (Railway TCP proxy; the
#                         internal postgres.railway.internal host is unreachable from a runner)
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

# Freshness guard: the house writes readings every minute, so a newest row older than
# BACKUP_MAX_AGE_S means DATABASE_URL points at the wrong (dead) database. From 2026-08-24 to
# 2026-10-19 this backup "succeeded" every week while dumping the abandoned Neon DB.
MAX_AGE_S="${BACKUP_MAX_AGE_S:-21600}"
AGE_S="$(psql "$DATABASE_URL" -Atc "select coalesce((extract(epoch from now()) - max(ts))::bigint, -1) from readings")"
if [ "$AGE_S" -lt 0 ] || [ "$AGE_S" -gt "$MAX_AGE_S" ]; then
  echo "error: newest reading is ${AGE_S}s old (limit ${MAX_AGE_S}s) -- DATABASE_URL is not the live database" >&2
  exit 1
fi
echo "newest reading ${AGE_S}s old -- live database confirmed"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="a2w-db-${STAMP}.sql.gz.gpg"

# --no-owner/--no-privileges keeps the dump portable to a fresh database on restore.
# Passphrase via fd 3 (process substitution) so it never appears in the process argument list.
pg_dump --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 -o "$OUT" 3< <(printf '%s' "$BACKUP_PASSPHRASE")

SIZE="$(du -h "$OUT" | cut -f1)"
echo "wrote ${OUT} (${SIZE})"

# Hand the filename to the workflow next step (no-op when run locally).
echo "backup_file=${OUT}" >> "${GITHUB_ENV:-/dev/null}"
