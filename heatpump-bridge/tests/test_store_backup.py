# @purpose: Store.backup copies from its OWN read-only connection and holds neither store lock
# (#319 lets the backup run in the daytime; safety writes — the lease revert, a breaker cycle's
# audit row — must never queue behind it). Pins: the copy is a sound, consistent snapshot of a
# live WAL store; reads and writes proceed while it runs; a failed backup closes its connection,
# leaves the store usable, and through the scheduler leaves no file and retries in an hour; the
# in-memory store keeps the old locked path. And the final name only ever holds a complete,
# verified, single-file copy: it is written as .part and renamed (a held, killed, cancelled,
# corrupt or out-of-space copy leaves nothing under bridge-*.db); a slow copy logs a warning.
from __future__ import annotations

import asyncio
import gc
import itertools
import logging
import os
import sqlite3
import time
import warnings
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from bridge.store import Store

SNAP = {"inlet_c": 40.0, "outlet_c": 45.0, "ambient_c": 2.0, "setpoint_c": 48.0,
        "power_sys1": 1.2, "power_sys2": 0.0, "heating": True}


async def _store(path: str, rows: int) -> Store:
    store = Store(path)
    await store.open()
    for _ in range(rows):
        await store.add_sample("p1", SNAP)
    return store


def _check(path: Path) -> int:
    """integrity_check must pass; returns the backup's sample row count."""
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return conn.execute("SELECT count(*) FROM samples").fetchone()[0]
    finally:
        conn.close()


async def test_backup_of_a_live_wal_store_is_sound_and_complete(tmp_path, backup_source):
    store = await _store(str(tmp_path / "bridge.db"), 50)
    try:
        assert (tmp_path / "bridge.db-wal").exists()     # a real WAL store, -wal/-shm present
        dest = tmp_path / "out.db"
        await store.backup(str(dest))
        assert _check(dest) == 50
        assert len(backup_source.sources) == 1           # it used its own connection
        assert backup_source.closed == 1                 # and closed it
    finally:
        await store.close()


async def test_reads_and_writes_proceed_while_a_backup_runs(tmp_path, backup_source):
    store = await _store(str(tmp_path / "bridge.db"), 50)
    try:
        backup_source.hold = True
        dest = tmp_path / "out.db"
        task = asyncio.create_task(store.backup(str(dest)))
        assert await asyncio.to_thread(backup_source.started.wait, 5)
        # the copy is mid-flight: neither store lock is held, so safety writes don't queue
        assert not store._conn_lock.locked()
        assert not store._thread_lock.locked()
        for _ in range(20):
            await asyncio.wait_for(store.add_sample("p1", SNAP), 2)
        await asyncio.wait_for(store.add_event("p1", "setpoint_write", code="accepted"), 2)
        assert len(await asyncio.wait_for(store.get_history("p1", 1), 2)) == 70
        assert not task.done()                           # really was still running
        backup_source.release.set()
        await asyncio.wait_for(task, 10)
        # the copy is the snapshot from the backup's start: sound, and not torn by the writes
        assert backup_source.snapshot_rows == 50
        assert _check(dest) == backup_source.snapshot_rows
        assert len(await store.get_history("p1", 1)) == 70
    finally:
        backup_source.release.set()
        await store.close()


async def test_failed_backup_raises_closes_its_connection_and_leaves_store_usable(
        tmp_path, backup_source):
    store = await _store(str(tmp_path / "bridge.db"), 5)
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with pytest.raises(OSError):                 # the free-space check finds no folder
                await store.backup(str(tmp_path / "no-such-dir" / "out.db"))
            assert len(backup_source.sources) == 1
            assert backup_source.closed == 1                 # closed in the worker, on error too
            backup_source.sources.clear()
            gc.collect()
        assert not [w for w in caught if issubclass(w.category, ResourceWarning)]
        await store.add_sample("p1", SNAP)
        assert len(await store.get_history("p1", 1)) == 6
    finally:
        await store.close()


async def test_backup_failing_mid_copy_leaves_no_file_and_retries_hourly(
        tmp_path, backup_source, mono):
    """The real backup path raising inside the copy (not a stubbed store.backup): Store.backup
    removes the written-but-failed .part file itself, and the scheduler arms the hourly retry."""
    from bridge.scheduler import Scheduler

    store = await _store(str(tmp_path / "bridge.db"), 5)
    try:
        sched = Scheduler(store, {})
        dest = tmp_path / "backups" / "bridge-20260705.db"
        backup_source.fail_after_copy = True
        await sched.check_once(mono.at(datetime(2026, 7, 5, 3, 30)))
        assert not dest.exists()
        assert list(dest.parent.iterdir()) == []         # no .part, no -journal
        assert sched._last_maintenance_date is None
        assert sched._maintenance_retry_mono == mono.t + 3600
        assert backup_source.closed == len(backup_source.sources) == 1

        backup_source.fail_after_copy = False
        await sched.check_once(mono.at(datetime(2026, 7, 5, 4, 30)))
        assert _check(dest) == 5
        assert sched._last_maintenance_date == "2026-07-05"
    finally:
        await store.close()


def _names(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


async def test_held_copy_is_not_under_the_final_name_until_it_is_done(tmp_path, backup_source):
    store = await _store(str(tmp_path / "bridge.db"), 10)
    backups = tmp_path / "backups"
    backups.mkdir()
    dest = backups / "bridge-20260705.db"
    try:
        backup_source.hold = True
        task = asyncio.create_task(store.backup(str(dest)))
        assert await asyncio.to_thread(backup_source.started.wait, 5)
        # mid-copy: an off-Pi pull or a restart's "done" check sees nothing under bridge-*.db
        assert list(backups.glob("bridge-*.db")) == []
        assert (backups / "bridge-20260705.db.part").exists()
        backup_source.release.set()
        await asyncio.wait_for(task, 10)
        assert _names(backups) == ["bridge-20260705.db"]
        assert _check(dest) == 10
    finally:
        backup_source.release.set()
        await store.close()


async def test_a_run_killed_before_the_rename_reads_not_done_and_the_next_run_recovers(
        tmp_path, backup_source, monkeypatch):
    from bridge.scheduler import Scheduler

    store = await _store(str(tmp_path / "bridge.db"), 5)
    backups = tmp_path / "backups"
    backups.mkdir()
    dest = backups / "bridge-20260705.db"
    try:
        real_replace = os.replace

        def killed(src, dst):           # the process dies between the copy and the rename
            raise RuntimeError("killed")

        monkeypatch.setattr(os, "replace", killed)
        with pytest.raises(RuntimeError):
            await store.backup(str(dest))
        monkeypatch.setattr(os, "replace", real_replace)
        assert _names(backups) == ["bridge-20260705.db.part"]

        # what a kill mid-copy leaves: a torn .part and its hot journal
        (backups / "bridge-20260705.db.part").write_bytes(b"SQLite format 3\x00torn")
        (backups / "bridge-20260705.db.part-journal").write_bytes(b"stale")
        sched = Scheduler(store, {})                     # the restarted process
        assert not sched._backup_done("2026-07-05")
        await sched.check_once(datetime(2026, 7, 5, 9, 0))
        assert _names(backups) == ["bridge-20260705.db"]
        assert _check(dest) == 5
        assert sched._backup_done("2026-07-05")
    finally:
        await store.close()


async def test_cancelled_caller_and_closed_store_the_copy_still_finishes_sound(
        tmp_path, backup_source):
    """A restart mid-copy: the awaiting task is cancelled and the store closed while the
    worker thread is still copying. The thread finishes alone, closes its own connection,
    and renames a sound copy into place."""
    store = await _store(str(tmp_path / "bridge.db"), 10)
    dest = tmp_path / "out.db"
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            backup_source.hold = True
            task = asyncio.create_task(store.backup(str(dest)))
            assert await asyncio.to_thread(backup_source.started.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(store.close(), 2)    # the copy holds no store lock
            assert not dest.exists()
            backup_source.release.set()
            for _ in range(200):                         # src closes before the rename
                if dest.exists():
                    break
                await asyncio.sleep(0.05)
            assert dest.exists()
            assert backup_source.closed == len(backup_source.sources) == 1
            backup_source.sources.clear()
            gc.collect()
        assert not [w for w in caught if issubclass(w.category, ResourceWarning)]
        assert not Path(f"{dest}.part").exists()
        conn = sqlite3.connect(dest)
        try:
            assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            assert conn.execute("SELECT count(*) FROM samples").fetchone()[0] == 10
        finally:
            conn.close()
    finally:
        backup_source.release.set()
        await store.close()


async def test_a_copy_failing_quick_check_leaves_nothing_and_arms_the_retry(
        tmp_path, backup_source, monkeypatch, mono):
    from bridge.scheduler import Scheduler

    class Corrupt(sqlite3.Connection):
        def execute(self, sql, *a):
            if sql == "PRAGMA quick_check":
                return super().execute("SELECT '*** in database main *** Page 7: corrupt'")
            return super().execute(sql, *a)

    inner = sqlite3.connect

    def connect(database, *a, **kw):    # only the copy's own connection is corrupted
        if str(database).endswith(".part"):
            return inner(database, *a, factory=Corrupt, **kw)
        return inner(database, *a, **kw)

    monkeypatch.setattr(sqlite3, "connect", connect)
    store = await _store(str(tmp_path / "bridge.db"), 5)
    try:
        sched = Scheduler(store, {})
        await sched.check_once(mono.at(datetime(2026, 7, 5, 3, 30)))
        assert _names(tmp_path / "backups") == []        # no dest, no .part, no journal
        assert sched._last_maintenance_date is None
        assert sched._maintenance_retry_mono == mono.t + 3600
    finally:
        await store.close()


async def test_too_little_free_space_writes_nothing_warns_and_arms_the_retry(
        tmp_path, backup_source, monkeypatch, mono, caplog):
    import shutil
    from bridge.scheduler import Scheduler

    store = await _store(str(tmp_path / "bridge.db"), 5)
    try:
        monkeypatch.setattr(shutil, "disk_usage",
                            lambda path: SimpleNamespace(total=10**9, used=10**9 - 1024, free=1024))
        sched = Scheduler(store, {})
        with caplog.at_level(logging.WARNING):
            await sched.check_once(mono.at(datetime(2026, 7, 5, 3, 30)))
        assert _names(tmp_path / "backups") == []
        assert any(r.name == "bridge.store" and r.levelno == logging.WARNING
                   and "free" in r.getMessage() for r in caplog.records)
        assert sched._last_maintenance_date is None
        assert sched._maintenance_retry_mono == mono.t + 3600
        assert backup_source.closed == len(backup_source.sources) == 1
    finally:
        await store.close()


async def test_the_copy_is_one_self_contained_file(tmp_path):
    store = await _store(str(tmp_path / "bridge.db"), 20)     # a WAL store
    dest = tmp_path / "out.db"
    try:
        await store.backup(str(dest))
    finally:
        await store.close()
    for side in ("-wal", "-shm", "-journal", ".part"):
        assert not Path(f"{dest}{side}").exists(), side
    # read-only open: a WAL-mode file would need a -shm it can't create
    conn = sqlite3.connect(dest.as_uri() + "?mode=ro", uri=True)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert conn.execute("SELECT count(*) FROM samples").fetchone()[0] == 20
    finally:
        conn.close()
    for side in ("-wal", "-shm"):
        assert not Path(f"{dest}{side}").exists(), side


async def test_a_copy_slower_than_a_minute_logs_a_warning(tmp_path, monkeypatch, caplog):
    from bridge import store as store_mod

    store = await _store(str(tmp_path / "bridge.db"), 5)
    ticks = itertools.count(1000.0, 61.0)            # each reading 61 s after the last
    monkeypatch.setattr(store_mod, "time",
                        SimpleNamespace(**{**vars(time), "monotonic": lambda: next(ticks)}))
    try:
        with caplog.at_level(logging.INFO, logger="bridge.store"):
            await store.backup(str(tmp_path / "out.db"))
    finally:
        await store.close()
    msgs = [(r.levelno, r.getMessage()) for r in caplog.records if r.name == "bridge.store"]
    assert (logging.INFO, "backup: out.db copied in 61.0 s") in msgs
    assert any(lvl == logging.WARNING and "took 61 s" in m for lvl, m in msgs)


@pytest.mark.parametrize("path", [":memory:", ""])
async def test_in_memory_store_keeps_the_locked_backup(tmp_path, backup_source, path):
    store = await _store(path, 7)
    try:
        dest = tmp_path / "out.db"
        await store.backup(str(dest))
        assert _check(dest) == 7
        assert backup_source.sources == []               # no second connection: it can't see :memory:
    finally:
        await store.close()
