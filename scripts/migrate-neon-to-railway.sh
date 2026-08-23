#!/usr/bin/env bash
#
# @purpose One-shot, verifiable migration of the a2w analytics DB from Neon (Vercel
# Marketplace, free_v3) to Railway Postgres. Neon's free tier caps compute at 100
# CU-hours/project/month with scale-to-zero disabled, so it hard-refused every
# connection on 2026-08-19 and crash-looped the planner. Railway Postgres is
# container-billed — there is no compute-hour cliff to hit.
#
# SAFETY CONTRACT — this script is strictly non-destructive to Neon. It only ever
# reads from the source. It refuses to run unless BOTH endpoints answer, keeps the
# dump file on disk as a rollback artifact, and exits non-zero if a single table's
# row count fails to match after restore. Cutover is a separate, manual step: nothing
# here touches the planner or dashboard connection strings.
#
# Usage:
#   export NEON_URL='postgresql://…neon.tech/neondb?sslmode=require'
#   export RAILWAY_URL='postgresql://postgres:…@<tcp-proxy-host>:<port>/railway'
#   scripts/migrate-neon-to-railway.sh            # dump + restore + verify
#   VERIFY_ONLY=1 scripts/migrate-neon-to-railway.sh   # re-compare, no writes
#
# Version note: Neon runs PG17, Railway runs PG18.6. pg_dump must be >= the source,
# so we pin the Homebrew libpq@18 client (18.3). The system pg_dump on this Mac is
# 14.12 and WILL refuse to dump a 17 server.

set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/libpq@18/bin}"
DUMP_DIR="${DUMP_DIR:-$HOME/a2w-migration}"
DUMP_FILE="$DUMP_DIR/neon-$(date +%Y%m%d-%H%M%S).dump"
VERIFY_ONLY="${VERIFY_ONLY:-0}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

for v in NEON_URL RAILWAY_URL; do
  if [ -z "${!v:-}" ]; then
    red "FATAL: \$$v is not set."
    echo "  NEON_URL    — pull with: cd analytics-mirror && vercel env pull --environment=production"
    echo "                then use POSTGRES_URL_NON_POOLING (direct, not the pooler)."
    echo "  RAILWAY_URL — Railway → a2w-hub → Postgres → Variables → DATABASE_PUBLIC_URL"
    echo "                (requires Settings → Networking → Add TCP Proxy on port 5432)."
    exit 1
  fi
done

for b in pg_dump pg_restore psql; do
  [ -x "$PGBIN/$b" ] || { red "FATAL: $PGBIN/$b not found. brew install libpq@18"; exit 1; }
done

# Never let a pooled/pgbouncer URL near pg_dump — it silently breaks on session state.
case "$NEON_URL" in
  *-pooler.*|*pgbouncer*) red "FATAL: NEON_URL looks pooled. Use POSTGRES_URL_NON_POOLING."; exit 1 ;;
esac

# ── inventory helper ────────────────────────────────────────────────────────────
# Exact per-table counts. count(*) not reltuples — reltuples is a planner estimate
# and will happily under-report on a freshly restored table that hasn't been
# ANALYZEd. We are verifying "did every row land", so estimates are useless.
inventory() {
  "$PGBIN/psql" "$1" -At -F'|' -v ON_ERROR_STOP=1 <<'SQL'
SELECT c.relname,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname),
                           false, true, '')))[1]::text::bigint
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
SQL
}

bold "── preflight ──────────────────────────────────────────────────────────────"
echo -n "  Neon    : "; "$PGBIN/psql" "$NEON_URL"    -Atc "select version()" | cut -c1-40 \
  || { red "  Neon is unreachable. If it still says 'exceeded the compute time quota',"; \
       red "  the plan upgrade has not taken effect yet — wait and retry."; exit 1; }
echo -n "  Railway : "; "$PGBIN/psql" "$RAILWAY_URL" -Atc "select version()" | cut -c1-40 \
  || { red "  Railway is unreachable. Is the TCP proxy enabled on the Postgres service?"; exit 1; }

bold ""
bold "── source inventory (Neon) ────────────────────────────────────────────────"
SRC="$(inventory "$NEON_URL")"
SRC_TABLES=$(echo "$SRC" | grep -c . || true)
SRC_ROWS=$(echo "$SRC" | awk -F'|' '{s+=$2} END {print s+0}')
echo "$SRC" | awk -F'|' '{printf "  %-28s %10d\n", $1, $2}'
printf "  %-28s %10d rows across %d tables\n" "TOTAL" "$SRC_ROWS" "$SRC_TABLES"

if [ "$SRC_TABLES" -eq 0 ]; then
  red "FATAL: source has no tables in schema 'public'. Refusing to 'migrate' nothing."
  exit 1
fi

if [ "$VERIFY_ONLY" != "1" ]; then
  bold ""
  bold "── dump ───────────────────────────────────────────────────────────────────"
  mkdir -p "$DUMP_DIR"
  # -Fc  custom format (compressed, selective restore possible)
  # --no-owner/--no-acl  strip Neon role grants; Railway's role is 'postgres'
  "$PGBIN/pg_dump" "$NEON_URL" -Fc --no-owner --no-acl --verbose -f "$DUMP_FILE" 2>&1 \
    | grep -E "dumping contents of table|error|warning" | sed 's/^/  /' || true
  grn "  wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"
  echo "  ^ keep this. It is your rollback artifact and it is the only copy of the"
  echo "    Neon data that does not depend on Neon staying unlocked."

  bold ""
  bold "── restore → Railway ──────────────────────────────────────────────────────"
  # --clean --if-exists makes this re-runnable: a second run replaces rather than
  # duplicating. Harmless on a virgin target.
  "$PGBIN/pg_restore" -d "$RAILWAY_URL" --no-owner --no-acl --clean --if-exists \
    --single-transaction --verbose "$DUMP_FILE" 2>&1 \
    | grep -iE "error|fatal" | sed 's/^/  /' || true
  # ANALYZE so the new planner has stats immediately rather than after autovacuum.
  "$PGBIN/psql" "$RAILWAY_URL" -q -c "ANALYZE;"
  grn "  restored + analyzed"
fi

bold ""
bold "── verify ─────────────────────────────────────────────────────────────────"
DST="$(inventory "$RAILWAY_URL")"

FAIL=0
while IFS='|' read -r t n; do
  [ -z "$t" ] && continue
  m=$(echo "$DST" | awk -F'|' -v t="$t" '$1==t {print $2}')
  if [ -z "$m" ]; then
    red "  MISSING  $t (source had $n rows)"; FAIL=1
  elif [ "$m" != "$n" ]; then
    red "  MISMATCH $t: neon=$n railway=$m"; FAIL=1
  else
    printf "  \033[32mok\033[0m       %-28s %10d\n" "$t" "$n"
  fi
done <<< "$SRC"

# Tables on the target that the source never had are not a migration failure, but
# they are worth surfacing — they usually mean a stale restore or a schema the app
# created on its own.
while IFS='|' read -r t n; do
  [ -z "$t" ] && continue
  echo "$SRC" | awk -F'|' -v t="$t" '$1==t {found=1} END {exit !found}' \
    || ylw "  EXTRA    $t ($n rows on Railway, absent from Neon)"
done <<< "$DST"

bold ""
if [ "$FAIL" -eq 0 ]; then
  grn "── VERIFIED: all $SRC_TABLES tables match ($SRC_ROWS rows) ────────────────"
  echo
  echo "Nothing has been cut over yet. Next, in order:"
  echo "  1. planner  : railway variables --service a2w-planner \\"
  echo "                  --set 'DATABASE_URL=\${{Postgres.DATABASE_URL}}'"
  echo "                (private network — free egress, no TCP proxy hop)"
  echo "  2. dashboard: set POSTGRES_URL on Vercel to the TCP-proxy URL, redeploy"
  echo "  3. watch    : curl \$PLANNER_URL/health"
  echo "  4. only then: delete the Neon store in the Vercel dashboard"
  exit 0
else
  red "── VERIFICATION FAILED — do NOT cut over ──────────────────────────────────"
  echo "The dump is still at $DUMP_FILE. Neon is untouched and still authoritative."
  exit 1
fi
