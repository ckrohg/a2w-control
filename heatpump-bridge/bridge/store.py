# @purpose: SQLite persistence (right-sized by design — no InfluxDB/Postgres): time-series
# samples, event log (faults + setpoint audit), and periodic comm-stats snapshots. Stdlib
# sqlite3 run via asyncio.to_thread; WAL mode so API reads never block the poller's writes.
from __future__ import annotations

import asyncio
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY,
    pump_id TEXT NOT NULL,
    ts REAL NOT NULL,
    inlet_c REAL, outlet_c REAL, ambient_c REAL, setpoint_c REAL,
    power_sys1 REAL, power_sys2 REAL,
    heating INTEGER, status_word INTEGER
);
CREATE INDEX IF NOT EXISTS idx_samples_pump_ts ON samples(pump_id, ts);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    pump_id TEXT NOT NULL,
    ts REAL NOT NULL,
    type TEXT NOT NULL,          -- fault_on | fault_off | setpoint_write | comm
    code TEXT,                   -- raw fault code, or accepted/rejected for writes
    severity TEXT,
    message TEXT,
    detail TEXT                  -- JSON blob (fault key, old/new values, source, ...)
);
CREATE INDEX IF NOT EXISTS idx_events_pump_ts ON events(pump_id, ts);

CREATE TABLE IF NOT EXISTS comm_stats (
    id INTEGER PRIMARY KEY,
    pump_id TEXT NOT NULL,
    ts REAL NOT NULL,
    ok_polls INTEGER, error_polls INTEGER, timeouts INTEGER,
    io_errors INTEGER, exception_responses INTEGER, reconnects INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comm_pump_ts ON comm_stats(pump_id, ts);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY,
    pump_id TEXT NOT NULL,
    time_hhmm TEXT NOT NULL,     -- Pi-local wall time, "HH:MM"
    action TEXT NOT NULL,        -- on | off
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_date TEXT         -- "YYYY-MM-DD" of most recent firing (once per day)
);

CREATE TABLE IF NOT EXISTS span_samples (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    circuit_id TEXT,
    name TEXT NOT NULL,          -- SPAN circuit name, e.g. "Buffer Tank", "Air-Water 1"
    power_w REAL                 -- instantPowerW from SPAN's LAN-local API
);
CREATE INDEX IF NOT EXISTS idx_span_name_ts ON span_samples(name, ts);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        self._conn: sqlite3.Connection | None = None
        self._conn_lock = asyncio.Lock()

    async def open(self) -> None:
        def _open():
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            return conn
        self._conn = await asyncio.to_thread(_open)

    async def close(self) -> None:
        if self._conn:
            await asyncio.to_thread(self._conn.close)
            self._conn = None

    async def _exec(self, sql: str, params: tuple = ()) -> None:
        # one writer at a time: `with conn:` manages the CONNECTION-wide transaction,
        # so concurrent to_thread writers could roll back each other's work
        async with self._conn_lock:
            def _run():
                with self._conn:  # implicit transaction
                    self._conn.execute(sql, params)
            await asyncio.to_thread(_run)

    async def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        # reads MUST share the connection lock with writes — a single sqlite3 connection
        # is not safe for concurrent use across threads (a read racing a poller's write
        # raises "bad parameter or other API misuse"). _conn_lock is really the
        # connection-access lock.
        async with self._conn_lock:
            def _run():
                return [dict(r) for r in self._conn.execute(sql, params).fetchall()]
            return await asyncio.to_thread(_run)

    # --- writes ---------------------------------------------------------------
    async def add_sample(self, pump_id: str, snap: dict) -> None:
        await self._exec(
            "INSERT INTO samples (pump_id, ts, inlet_c, outlet_c, ambient_c, setpoint_c,"
            " power_sys1, power_sys2, heating, status_word)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pump_id, time.time(), snap["inlet_c"], snap["outlet_c"], snap["ambient_c"],
             snap["setpoint_c"], snap["power_sys1"], snap["power_sys2"],
             int(snap["heating"]), snap.get("status_word", 0)),
        )

    async def add_event(self, pump_id: str, type_: str, *, code: str | None = None,
                        severity: str | None = None, message: str | None = None,
                        detail: dict | None = None) -> None:
        await self._exec(
            "INSERT INTO events (pump_id, ts, type, code, severity, message, detail)"
            " VALUES (?,?,?,?,?,?,?)",
            (pump_id, time.time(), type_, code, severity, message,
             json.dumps(detail) if detail else None),
        )

    async def add_span_sample(self, ts: float, circuit_id: str | None,
                              name: str, power_w: float) -> None:
        await self._exec(
            "INSERT INTO span_samples (ts, circuit_id, name, power_w) VALUES (?,?,?,?)",
            (ts, circuit_id, name, power_w),
        )

    async def get_span_since(self, after_id: int, limit: int) -> list[dict]:
        """New span_samples for the analytics export — cursor = max id already shipped,
        exactly the durable-cursor pattern the exporter uses for events."""
        return await self._query(
            "SELECT id, ts, circuit_id, name, power_w FROM span_samples"
            " WHERE id > ? ORDER BY id LIMIT ?", (after_id, limit))

    async def add_comm_snapshot(self, pump_id: str, stats: dict) -> None:
        await self._exec(
            "INSERT INTO comm_stats (pump_id, ts, ok_polls, error_polls, timeouts,"
            " io_errors, exception_responses, reconnects) VALUES (?,?,?,?,?,?,?,?)",
            (pump_id, time.time(), stats["ok_polls"], stats["error_polls"],
             stats["timeouts"], stats["io_errors"], stats["exception_responses"],
             stats["reconnects"]),
        )

    # --- reads ----------------------------------------------------------------
    async def get_history(self, pump_id: str, hours: float) -> list[dict]:
        """Raw samples up to 48h; beyond that, 5-minute bucket averages."""
        since = time.time() - hours * 3600
        if hours <= 48:
            return await self._query(
                "SELECT ts, inlet_c, outlet_c, ambient_c, setpoint_c, power_sys1,"
                " power_sys2, heating FROM samples WHERE pump_id=? AND ts>=? ORDER BY ts",
                (pump_id, since),
            )
        return await self._query(
            "SELECT CAST(ts/300 AS INTEGER)*300 AS ts, AVG(inlet_c) AS inlet_c,"
            " AVG(outlet_c) AS outlet_c, AVG(ambient_c) AS ambient_c,"
            " AVG(setpoint_c) AS setpoint_c, AVG(power_sys1) AS power_sys1,"
            " AVG(power_sys2) AS power_sys2, MAX(heating) AS heating"
            " FROM samples WHERE pump_id=? AND ts>=? GROUP BY 1 ORDER BY 1",
            (pump_id, since),
        )

    async def get_events_since(self, cursor: int, limit: int = 200) -> list[dict]:
        """New events strictly after `cursor` (an event id), oldest-first, capped. Feeds the
        cloud mirror push (bridge/exporter.py); id ordering makes the cursor durable/resumable."""
        rows = await self._query(
            "SELECT id, pump_id, ts, type, code, severity, message, detail FROM events"
            " WHERE id > ? ORDER BY id ASC LIMIT ?",
            (cursor, limit),
        )
        for r in rows:
            r["detail"] = json.loads(r["detail"]) if r["detail"] else None
        return rows

    async def get_events(self, pump_id: str, days: float) -> list[dict]:
        since = time.time() - days * 86400
        rows = await self._query(
            "SELECT ts, type, code, severity, message, detail FROM events"
            " WHERE pump_id=? AND ts>=? ORDER BY ts DESC LIMIT 500",
            (pump_id, since),
        )
        for r in rows:
            r["detail"] = json.loads(r["detail"]) if r["detail"] else None
        return rows

    # --- schedules (daily on/off timers, superset of the wall controller's 2 groups) --
    async def list_schedules(self, pump_id: str) -> list[dict]:
        return await self._query(
            "SELECT id, time_hhmm, action, enabled FROM schedules WHERE pump_id=?"
            " ORDER BY time_hhmm", (pump_id,))

    async def add_schedule(self, pump_id: str, time_hhmm: str, action: str) -> None:
        await self._exec(
            "INSERT INTO schedules (pump_id, time_hhmm, action) VALUES (?,?,?)",
            (pump_id, time_hhmm, action))

    async def delete_schedule(self, pump_id: str, schedule_id: int) -> None:
        await self._exec("DELETE FROM schedules WHERE id=? AND pump_id=?",
                         (schedule_id, pump_id))

    async def due_schedules(self, hhmm: str, today: str) -> list[dict]:
        """Enabled rules at-or-before this wall-clock time that haven't fired today —
        <= (not ==) so a restart or a stalled tick spanning the exact minute still
        fires the rule late instead of silently skipping the whole day."""
        return await self._query(
            "SELECT id, pump_id, time_hhmm, action FROM schedules WHERE enabled=1"
            " AND time_hhmm<=? AND (last_fired_date IS NULL OR last_fired_date<>?)"
            " ORDER BY time_hhmm",
            (hhmm, today))

    async def delete_schedules_for_pump(self, pump_id: str) -> None:
        """On pump removal: pump ids are recycled, so orphaned timers would silently
        attach to a future pump."""
        await self._exec("DELETE FROM schedules WHERE pump_id=?", (pump_id,))

    async def mark_schedule_fired(self, schedule_id: int, today: str) -> None:
        await self._exec("UPDATE schedules SET last_fired_date=? WHERE id=?",
                         (today, schedule_id))

    # --- maintenance (run nightly by the scheduler) -----------------------------
    async def backup(self, dest: str) -> None:
        """Consistent online backup via SQLite's backup API — survives SD card death
        as long as yesterday's copy does. Under the connection lock (touches _conn)."""
        async with self._conn_lock:
            def _run():
                dst = sqlite3.connect(dest)
                try:
                    with dst:
                        self._conn.backup(dst)
                finally:
                    dst.close()
            await asyncio.to_thread(_run)

    async def prune(self, *, samples_days: float = 365, comm_days: float = 90) -> None:
        cutoff = time.time() - samples_days * 86400
        await self._exec("DELETE FROM samples WHERE ts < ?", (cutoff,))
        await self._exec("DELETE FROM comm_stats WHERE ts < ?",
                         (time.time() - comm_days * 86400,))

    async def get_open_faults(self, pump_id: str) -> dict[str, float]:
        """Rebuild {fault_key: onset_ts} for faults with fault_on but no later fault_off —
        keeps 'active since' honest across bridge restarts. Bounded to a year so startup
        cost can't grow without limit."""
        rows = await self._query(
            "SELECT ts, type, detail FROM events WHERE pump_id=? AND type IN"
            " ('fault_on','fault_off') AND ts>=? ORDER BY ts",
            (pump_id, time.time() - 365 * 86400),
        )
        open_faults: dict[str, float] = {}
        for r in rows:
            detail = json.loads(r["detail"]) if r["detail"] else {}
            key = detail.get("key")
            if not key:
                continue
            if r["type"] == "fault_on":
                open_faults.setdefault(key, r["ts"])
            else:
                open_faults.pop(key, None)
        return open_faults
