# @purpose: Store.backup copies from its OWN read-only connection and holds neither store lock
# (#319 lets the backup run in the daytime; safety writes — the lease revert, a breaker cycle's
# audit row — must never queue behind it). Pins: the copy is a sound, consistent snapshot of a
# live WAL store; reads and writes proceed while it runs; a failed backup closes its connection,
# leaves the store usable, and through the scheduler leaves no file and retries in an hour; the
# in-memory store keeps the old locked path.
from __future__ import annotations

import asyncio
import gc
import sqlite3
import warnings
from datetime import datetime
from pathlib import Path

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
            with pytest.raises(sqlite3.OperationalError):
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


async def test_backup_failing_mid_copy_leaves_no_file_and_retries_hourly(tmp_path, backup_source):
    """The real backup path raising inside the copy (not a stubbed store.backup): #319's
    scheduler still removes the written-but-failed file and arms the hourly retry."""
    from bridge.scheduler import Scheduler

    store = await _store(str(tmp_path / "bridge.db"), 5)
    try:
        sched = Scheduler(store, {})
        dest = tmp_path / "backups" / "bridge-20260705.db"
        backup_source.fail_after_copy = True
        await sched.check_once(datetime(2026, 7, 5, 3, 30))
        assert not dest.exists()
        assert sched._last_maintenance_date is None
        assert sched._maintenance_retry_at == datetime(2026, 7, 5, 4, 30)
        assert backup_source.closed == len(backup_source.sources) == 1

        backup_source.fail_after_copy = False
        await sched.check_once(datetime(2026, 7, 5, 4, 30))
        assert _check(dest) == 5
        assert sched._last_maintenance_date == "2026-07-05"
    finally:
        await store.close()


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
