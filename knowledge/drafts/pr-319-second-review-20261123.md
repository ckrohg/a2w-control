# PR #319 (draft) — independent second review (tenet delegate, account B / Opus, read-only, 2026-11-23 22:25 ET)

Requested by the Pi/ops/reviews session (owner popup 2026-11-23 20:40 ET: "remove the lock first" = the author's option 2)
for the hydronic lane, which owns the PR. The reviewer saw the PR description, the diff (base a973a3c), a checkout of
head 779dec2d and main, plus the new `scripts/pi-backup-pull.sh`; nothing was run. Pi facts given: bridge.db 211 MB,
the 03:30 copy took ≤ 19 s on Nov 22/23, SD card, `Store` has both an asyncio and a threading lock (#94), the
scheduler ticks every 20 s and runs `check_lease`, `pi-update.sh` may restart the service at any 15-min check.

**Verdict: NEEDS WORK.** Option 2 is already in this head, but the copy is written straight to its final file name. A copy that is interrupted, or still running, looks like a finished backup to the scheduler, to the next restart, and to the off-Pi pull.

**The option 2 change is already made.** `Store.backup` opens its own `mode=ro` connection inside the worker thread and takes neither lock (checkout `bridge/store.py:366-401`). The PR description's fourth bullet says the same (memory: c539a43). So part B below reviews that code and corrects it, rather than describing it from scratch. Main still copies from the shared connection under both locks (main `bridge/store.py:352`). (Pi/ops note: the PR's "The trade-off" section with its three options is therefore stale; the owner's choice is already implemented and the description should say so.)

## Findings, most severe first

### 1. HIGH: the copy goes straight to `bridge-YYYYMMDD.db`, and "done" only means the file is bigger than 0 bytes
- **Where (checkout):** `store.py:108-114` and `:396-398` write to the final `dest`; `scheduler.py:115-118` (the check after the run) and `:242` (the startup seed) accept any file over 0 bytes; `scheduler.py:262` catches only `Exception`.
- **What goes wrong on a stop:** `pi-update.sh:16,75` (or any `systemctl restart`) stops the service during the copy. `Scheduler.stop()` cancels the task (`main.py:149`). `CancelledError` is not an `Exception`, so the cleanup at `scheduler.py:265-267` never runs. The worker thread keeps writing. If the process is then killed, the half-written file stays under its final name (systemd SIGKILL after the default 90 s `TimeoutStopSec`, a power cut, or the OOM killer).
- **What follows:** the new process seeds "done today" from that file, so there is no real backup that day; the file takes one of the 7 retention slots (`scheduler.py:269`), pushing out a good backup; `scripts/pi-backup-pull.sh` picks it as the newest and fails `quick_check`; the destination uses the default rollback journal, so a kill likely also leaves `bridge-YYYYMMDD.db-journal` behind, which the `bridge-*.db` glob never prunes.
- **A second problem with no crash at all:** with the catch-up and the hourly retry the copy can run at any hour, and the Mac pull (04:07, or at wake) can rsync a file the bridge is still writing.
- **Fix:** write to a temporary name the glob does not match, check it, fsync it, then `os.replace` it onto the final name, all inside the worker (part B).

### 2. MEDIUM: one future-dated file makes the backup run again after every restart and breaks retention for good
- **Where (checkout):** `scheduler.py:251` seeds "last done" from `max(dates)` across all files.
- **Scenario:** `bridge-20991231.db` exists (clock jump, copied-in file). Every restart after 03:30 seeds 2099-12-31, which is not today, so the first tick runs the full 211 MB backup again, on every update or watchdog restart. The file always sorts last, so it is never pruned, and only 6 real backups are kept. The pull script's `sort | tail -1` pulls the 2099 file every night.
- **The test misses it:** test (i) (diff lines 557-565) builds only one `Scheduler`, so it locks this behaviour in.
- **Fix:** decide "done" by asking whether today's file exists (see C). Log, and leave out of retention, any name later than tomorrow.

### 3. MEDIUM: retrying hourly on a nearly full disk can make the live database's writes fail
- Free space below the size of the database (near the `disk_low` alert at 10 %): each attempt fills the volume (`ENOSPC`); while full, the bridge's own WAL commits fail with `SQLITE_FULL` (samples, the audit row of a lease revert, breaker audit rows); the partial file is unlinked; an hour later it repeats. Main hit this once a night; the draft up to about 20 times a day.
- **Fix:** before copying, check `shutil.disk_usage(backups).free` against `page_count*page_size` plus a margin (part B, step 1).

### 4. MEDIUM, not blocking at 19 s: the scheduler still awaits the copy
- **Where (checkout):** `scheduler.py:114`. After the tick that starts the copy, the next `check_lease` runs about 19 s plus the 20 s tick later, roughly 40 s worst case. Acceptable: a lease reverts at expiry, leases are capped at 180 min and warn 15 min ahead (`config.py:67-68`).
- **The weak spot:** a failing card is both the reason backups fail and retry, and the reason a copy could take minutes.
- **Fix:** log how long each copy took and warn above 60 s now. Move maintenance into its own task if that warning ever fires.

### 5. LOW: the hourly retry spacing uses the wall clock
- `scheduler.py:106`, `retry_at - now > 3600`: an NTP step back of 30 s makes the retry run at once. At most one extra attempt per clock step. Fix: `time.monotonic()` for spacing, wall clock only for the date.

### 6. LOW: a permission error on the backups folder skips that tick's timers
- `scheduler.py:116`: Python 3.13's `Path.is_file()` swallows ENOENT and ENOTDIR but not EACCES, so a mode-000 folder makes `check_once` raise after the lease check and before `due_schedules`, once an hour; the `<=` catch-up fires those timers on the next tick (~20 s late). Test (h2) only covers ENOTDIR.

### 7. INFO, checked and fine: local dates versus UTC
- Everything uses naive local time (`datetime.now()` at `scheduler.py:72`, file names from the same `now`, the gate compares local dates). The Pi is America/New_York (`deploy/pi-setup.md:20`); US clocks change at 02:00, so 03:30 exists exactly once every day. The only exposure is a Pi left on UTC.

### Paths that run the backup twice in a day, or never
- Twice: only through finding 2. Never: only through finding 1 (a partial file seeds "done today"). When every retry fails all day, the stale `retry_at` carries past midnight and the next 03:30 run logs "retrying failed backup" instead of the scheduled line (cosmetic).

### What the ten maintenance tests (plus the five store tests) do not cover
A stop or kill during the copy; a partial file visible under the final name while the copy runs; a future-dated file across more than one restart; a full disk; small clock steps backwards; EACCES on the backups folder; whether the copy is valid (every scheduler test only checks size > 0; only `test_store_backup.py` runs `integrity_check`); whether the copy is a single, self-contained file.

## B. Option 2 implementation note

**How the shared connection is opened today (checkout `store.py:133-153`):** `check_same_thread=False`; `PRAGMA journal_mode=WAL`; `synchronous` never set (default FULL); Python 3.13's default legacy isolation; the default 5 s busy timeout; `wal_autocheckpoint` never set (default 1000 pages); no `wal_checkpoint` call anywhere in `bridge/`, so all checkpoints are automatic PASSIVE ones.

**What that means for writers during the copy:** in WAL mode a reader never blocks the single writer, and the backup's connection never writes, so the bridge sees no `SQLITE_BUSY`. PASSIVE checkpoints cannot move the WAL past the reader's snapshot; the WAL grows only by the writes made during the ~19 s copy and drains later. The backup's own connection can wait on open only during WAL recovery (the 10 s timeout). `mode=ro` needs the `-shm` file to exist; it always does while the store is open.

**Do not split the copy into steps (`pages`/`sleep`) unless the snapshot is pinned.** SQLite restarts a backup from page 1 if a different connection changes the source between steps. The bridge commits on every poll, so a chunked 211 MB copy could keep restarting and never finish, while wearing the card. With option 2 the only "pause" left is SD-card bandwidth contention, not a lock. Keep `pages=-1` (one step). If poll round-trip times (#310's CommStats) show contention, throttle with `BEGIN` plus a read on `src` first (pins the snapshot across steps; the conftest `backup_source` fixture already relies on this), then e.g. `pages=2048, sleep=0.05`.

**Is `VACUUM INTO` a better fit? No.** One consistent snapshot too, and it would drop free pages left by `prune`, but it rebuilds every table and index (much more CPU on the Pi, unmeasured), cannot be throttled, and fails if the target exists. Stay with the backup API, which is what took the measured 19 s.

**`_thread_lock` is not needed in the new path.** The worker never touches `self._conn`. Leave both private connections at the default `check_same_thread=True`, so any accidental use from another thread raises instead of reproducing #94. Only the `:memory:` path keeps both locks.

**Code for `bridge/store.py`:**

```python
import os, shutil

BACKUP_BUSY_TIMEOUT_S = 10.0
BACKUP_FREE_MARGIN = 1.2          # need 1.2x the DB size free before writing a copy

def _rm_sidecars(p: str) -> None:
    for sfx in ("", "-journal", "-wal", "-shm"):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(p + sfx)

def _copy_db(src_uri: str, dest: str) -> float:
    """Runs in ONE worker thread; owns both connections. dest appears only complete and verified."""
    t0 = time.monotonic()
    tmp = dest + ".part"                       # NOT matched by bridge-*.db (pruning, seed, pi-backup-pull)
    _rm_sidecars(tmp)                          # leftovers from a killed run
    src = sqlite3.connect(src_uri, uri=True, timeout=BACKUP_BUSY_TIMEOUT_S)
    try:
        src.execute("BEGIN")                   # pin one read snapshot...
        src.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        n_pages, page_size = (src.execute("PRAGMA page_count").fetchone()[0],
                              src.execute("PRAGMA page_size").fetchone()[0])
        need = n_pages * page_size * BACKUP_FREE_MARGIN
        if shutil.disk_usage(os.path.dirname(dest)).free < need:
            raise OSError(f"backup skipped: {need/1e6:.0f} MB needed")
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst, pages=-1)          # ...and copy it in one step (no restarts)
            dst.execute("PRAGMA journal_mode=DELETE")   # self-contained single file, opens with mode=ro anywhere
            if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise sqlite3.DatabaseError("backup failed quick_check")
            if dst.execute("PRAGMA page_count").fetchone()[0] != n_pages:
                raise sqlite3.DatabaseError("backup page_count mismatch")
        finally:
            dst.close()
        src.rollback()
    except BaseException:
        _rm_sidecars(tmp)
        raise
    finally:
        src.close()
    fd = os.open(tmp, os.O_RDONLY); os.fsync(fd); os.close(fd)
    os.replace(tmp, dest)                      # atomic; happens in the worker even if the awaiting task was cancelled
    dfd = os.open(os.path.dirname(dest), os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    return time.monotonic() - t0
```

`backup()` builds `src_uri` on the event loop, as it does now at checkout `store.py:393`, and returns `await asyncio.to_thread(_run)`, where `_run` calls `_copy_db`. The old `with dst:` wrapper does nothing and can go. The `:memory:` branch stays as it is.

**If the copy straddles a restart:** `stop()` cancels the awaiting task, but the thread keeps running; `store.close()` closes the shared connection without waiting for it (safe: the backup has its own connection); on exit the default executor's thread is joined, so normally the copy finishes and is renamed (19 s fits inside the 90 s stop timeout); if killed before the rename, only `.part` remains, the next process sees "not done", runs the catch-up and removes the stale `.part` first.

## C. Changes needed beyond `Store.backup`

- **"Done today" (`scheduler.py:49`, `:115-118`, `:229-252`).** Replace the startup `max()` seed and the post-run size check with one check, `_backup_done(today)`: today's file exists and its first 16 bytes are `b"SQLite format 3\x00"`. Call it at the gate on each tick, or cache it per date. Removes finding 2. Do not run `quick_check` at startup (reads 211 MB).
- **`run_maintenance` (`scheduler.py:262-267`).** Stop unlinking `dest` (`Store.backup` owns cleanup; `dest` is only ever complete). Leave out of retention, and warn about, any name later than tomorrow. Log the copy duration and warn above 60 s.
- **Retry spacing.** `time.monotonic()` (finding 5); wrap the post-run check in `try/except OSError` (finding 6).
- **The call site.** No change needed for option 2 at 19 s. Running maintenance as its own task is the follow-up if the 60 s warning ever fires.
- **Existing tests.** Test (f) stubs `backup` to write `b"partial"` to the final `dest` and expects the scheduler to remove it; under the new contract the stub must write to `dest + ".part"`, and the test should assert that neither file remains. Test (g) still passes (an empty file fails the header check). The #94 structural test (`test_store_two_loops.py:733-771` in the diff) still holds as long as the worker stays a `_run` nested in `backup` that never touches `_conn`.

## Tests to add

1. A held copy (`backup_source.hold`): `backups.glob("bridge-*.db")` is empty while it runs, and the file appears only after release.
2. A run killed before the rename (patch `os.replace` to raise `SystemExit`): only `.part` and its sidecars existed; gone after the next run; a new `Scheduler` reports "not done"; the catch-up produces a valid `dest`.
3. Cancel the awaiting task during a held copy, `await store.close()`, then release: the worker finishes, `dest` passes `quick_check`, no `ResourceWarning`.
4. With `bridge-20991231.db` present, today's backup, then two new `Scheduler`s at 14:00: no second run; the 2099 file takes no retention slot.
5. `quick_check` forced to fail: no `dest`, no `.part`, retry armed.
6. `shutil.disk_usage` reports too little free space: nothing written, a warning logged, retry armed.
7. The copy is a single file: no `-wal`, `-shm` or `-journal` beside `dest`; `PRAGMA journal_mode` on it is `delete`; it opens with `mode=ro` from a read-only folder, as the pull script opens it.
8. A clock step back of 30 s after a failure does not retry before an hour of monotonic time.
9. Backups folder mode 000 (skip as root): a due timer still fires on that tick.
10. Only if chunking is ever added: with `pages=1` and a write in the `progress` callback, the copy completes and equals the pinned snapshot.

## Relied on
- TENET memory: the "#319 copies from its own read-only connection" entry (c539a43, draft); the owner's 2026-11-23 popups ("#319 remove the lock first"; off-Pi backup pull).
- Checkout: `bridge/store.py`, `bridge/scheduler.py`, `bridge/main.py`, `bridge/poller.py:938-971`, `bridge/config.py:62-68`, `deploy/heatpump-bridge.service`, `deploy/heatpump-bridge-update.timer`, `deploy/pi-update.sh`, `deploy/pi-setup.md:20`, `tests/test_store_two_loops.py`; the PR description and diff; main `bridge/store.py:352`, `bridge/scheduler.py:45,88-89,199`; `scripts/pi-backup-pull.sh` and `scripts/launchd/com.a2w.pi-backup-pull.plist`.
- SQLite and CPython behaviour from documentation, not tested here: backup restarting between steps, PASSIVE checkpoints and readers, `Path.is_file` and EACCES. One claim rests only on the test fixture: that `backup()` runs inside an open source read transaction.

## Pi/ops follow-up on the pull script (done 2026-11-23 22:40 ET)
`scripts/pi-backup-pull.sh` now skips files modified in the last 3 minutes, skips names dated after tomorrow, walks
newest-to-oldest until one passes `quick_check`, and never pulls `.part` files. Until #319 lands, the 03:30 copy on
the Pi still writes straight to the final name, so a 04:07 pull is the window that avoids it.
