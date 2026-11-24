#!/usr/bin/env bash
# @purpose Nightly off-Pi copy of the bridge's SQLite backup: pull the newest
#          verified ~/bridge-data/backups/bridge-YYYYMMDD.db from the Pi over the
#          tailnet to this Mac, check it opens, keep the newest N. The Pi's own
#          backups live on its SD card, so an SD failure would take the database
#          and its backups together (owner decision 2026-11-23). Runs from launchd
#          (scripts/launchd/com.a2w.pi-backup-pull.plist) or by hand.
#
# Candidate rules (from the #319 second review, knowledge/drafts/pr-319-second-review-20261123.md):
#   - never a file modified in the last 3 min (the bridge may still be writing it)
#   - never a name dated after tomorrow (a clock jump or a copied-in file)
#   - never a .part file; walk newest-to-oldest until one passes PRAGMA quick_check
#
# Usage:   scripts/pi-backup-pull.sh            # pull the newest verified backup
#          KEEP=30 scripts/pi-backup-pull.sh    # keep 30 instead of 14
# Env:     PI_SSH_CONFIG  ssh -F file           (default ~/.ssh/a2w-pi-backup.conf,
#                                                falling back to ~/.ssh/a2w-pi.conf)
#          PI_HOST        host alias in it      (default a2w-pi)
#          PI_BACKUP_DIR  on the Pi              (default /home/admin/bridge-data/backups)
#          DEST           on this Mac            (default ~/a2w-pi-backups)
#          KEEP           copies to keep         (default 14)
# Exit:    0 pulled (or already current), 1 could not reach the Pi or no candidate,
#          2 every candidate failed verification. One line per run in $DEST/pull.log.
set -uo pipefail

PI_SSH_CONFIG="${PI_SSH_CONFIG:-$HOME/.ssh/a2w-pi-backup.conf}"
[ -r "$PI_SSH_CONFIG" ] || PI_SSH_CONFIG="$HOME/.ssh/a2w-pi.conf"
PI_HOST="${PI_HOST:-a2w-pi}"
PI_BACKUP_DIR="${PI_BACKUP_DIR:-/home/admin/bridge-data/backups}"
DEST="${DEST:-$HOME/a2w-pi-backups}"
KEEP="${KEEP:-14}"
mkdir -p "$DEST"
LOG="$DEST/pull.log"
SSH_OPTS=(-F "$PI_SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=30)

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LOG" >&2; }

verify() {  # $1 = local sqlite file; 0 when it opens read-only and passes quick_check
  python3 -I -c '
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro&immutable=1" % sys.argv[1], uri=True)  # immutable: a WAL-mode copy has no -shm, and read-only cannot create one
r = c.execute("PRAGMA quick_check").fetchone()[0]
n = c.execute("select count(*) from sqlite_master").fetchone()[0]
sys.exit(0 if (r == "ok" and n > 0) else 1)' "$1" 2>>"$LOG"
}

tomorrow="$(date -v+1d '+%Y%m%d')"
# Candidates on the Pi, newest name first: "<bytes> <name>", non-empty, not touched in the last 3 min.
list="$(ssh "${SSH_OPTS[@]}" "$PI_HOST" \
  "cd $PI_BACKUP_DIR 2>/dev/null && find . -maxdepth 1 -name 'bridge-[0-9]*.db' -size +0 -mmin +3 -printf '%s %f\n' | sort -k2 -r" 2>>"$LOG")" || {
  log "FAIL reach: ssh to $PI_HOST failed (Tailscale check pending, Pi down, or key refused)"; exit 1; }
[ -n "$list" ] || { log "FAIL reach: no settled bridge-*.db under $PI_BACKUP_DIR"; exit 1; }

tried=0
while read -r size name; do
  [ -n "$name" ] || continue
  stamp="${name#bridge-}"; stamp="${stamp%%.*}"
  if [ "$stamp" \> "$tomorrow" ]; then log "skip $name: dated after tomorrow"; continue; fi
  if [ -f "$DEST/$name" ] && [ "$(stat -f %z "$DEST/$name")" = "$size" ]; then
    log "OK current: $name ($size bytes) already here"; exit 0
  fi
  if [ "$tried" -ge 2 ]; then log "FAIL verify: two candidates failed, not walking further back"; break; fi
  tried=$((tried+1))
  tmp="$DEST/.$name.part"
  if ! rsync -t --partial --inplace -e "ssh -F $PI_SSH_CONFIG -o BatchMode=yes -o ConnectTimeout=30" \
       "$PI_HOST:$PI_BACKUP_DIR/$name" "$tmp" 2>>"$LOG"; then
    log "FAIL copy: rsync of $name failed"; rm -f "$tmp"; continue
  fi
  got="$(stat -f %z "$tmp")"
  if [ "$got" != "$size" ]; then log "FAIL verify: $name size $got != $size"; rm -f "$tmp"; continue; fi
  if ! verify "$tmp"; then log "FAIL verify: $name did not pass PRAGMA quick_check"; rm -f "$tmp"; continue; fi
  mv "$tmp" "$DEST/$name"
  log "OK pulled: $name ($size bytes)"
  # Retention: keep the newest $KEEP by name (names carry the date).
  ls -1 "$DEST"/bridge-*.db 2>/dev/null | sort -r | awk -v k="$KEEP" 'NR>k' | while read -r old; do
    rm -f "$old" && log "pruned $(basename "$old")"
  done
  exit 0
done <<< "$list"

[ "$tried" -gt 0 ] && { log "FAIL verify: all $tried candidate(s) failed"; exit 2; }
log "FAIL reach: no eligible candidate"; exit 1
