# @purpose: Shared fixtures. `span_transport` (#199) runs a SPAN suite twice: against the v1 REST fake, and against a
# panel with v1 REMOVED that only speaks v2 (MQTT eBus, sim/fake_span_v2.py) — the panel after 2026-12-31. The v1
# run uses the shipped default (transport "v1"); the v2 run uses the config the owner flips to later ("auto"). The
# same assertions on both prove the flip changes no behaviour. Tests about v1's wire format are marked `v1_only`.
# `backup_source` (#319) records — and can hold mid-copy — Store.backup's own read-only connection.
from __future__ import annotations

import sqlite3
import threading
from types import SimpleNamespace

import pytest

from bridge import span_local, span_v2
from sim import fake_span_v2
from sim.fake_span import FakeSpan


def pytest_configure(config):
    config.addinivalue_line("markers", "v1_only: exercises the v1 REST wire format; skipped on the v2 panel")


@pytest.fixture(params=["v1", "v2"])
def span_transport(request, monkeypatch):
    if request.param == "v2":
        if request.node.get_closest_marker("v1_only"):
            pytest.skip("v1 REST wire format")
        monkeypatch.setattr(FakeSpan, "DEFAULT_V1", False)
        monkeypatch.setattr(FakeSpan, "DEFAULT_V2", True)
        real_fetch = span_v2.SpanV2.fetch

        def fetch(self, wait=True):
            # the fake polls FakeSpan's dict every 20 ms; a test that mutates it and reads at once must not race that
            for ebus in list(fake_span_v2.LIVE):
                if self.broker and self.broker.endswith(f":{ebus.port}"):
                    ebus.flush(self)
            return real_fetch(self, wait)
        monkeypatch.setattr(span_v2.SpanV2, "fetch", fetch)
        real_init = span_local.SpanClient.__init__

        def init(self, *a, transport=None, **kw):   # every client in the suite runs the post-flip config
            real_init(self, *a, transport="auto", **kw)
        monkeypatch.setattr(span_local.SpanClient, "__init__", init)
    # a /set the fake panel ignores must not cost every test the production echo wait
    monkeypatch.setattr(span_v2, "ECHO_WAIT_S", 0.5)
    return request.param


@pytest.fixture
def backup_source(monkeypatch):
    """Every connection Store.backup opens on its source (the only uri=True connect) is
    recorded in `.sources`. With `.hold = True` its copy is made slow the honest way: it
    pins its read snapshot (BEGIN + a read), records `.snapshot_rows` (samples), sets
    `.started`, waits for `.release`, then runs the real one-step backup inside that same
    snapshot — exactly what a long copy looks like to writers. `.fail_after_copy` raises
    once the copy is written. `.closed` counts close() calls: the connection belongs to the
    worker thread (check_same_thread), so no other thread can ask it whether it is closed.
    No production code sleeps."""
    state = SimpleNamespace(sources=[], hold=False, fail_after_copy=False, snapshot_rows=None,
                            closed=0, started=threading.Event(), release=threading.Event())
    real_connect = sqlite3.connect

    class Source(sqlite3.Connection):
        def backup(self, target, *a, **kw):
            if state.hold:
                self.execute("BEGIN")
                state.snapshot_rows = self.execute("SELECT count(*) FROM samples").fetchone()[0]
                state.started.set()
                assert state.release.wait(10), "test never released the held backup"
            super().backup(target, *a, **kw)
            if state.fail_after_copy:
                raise sqlite3.OperationalError("disk I/O error")

        def close(self):
            super().close()
            state.closed += 1

    def connect(database, *a, **kw):
        if not kw.get("uri"):
            return real_connect(database, *a, **kw)
        conn = real_connect(database, *a, factory=Source, **kw)
        state.sources.append(conn)
        return conn

    monkeypatch.setattr(sqlite3, "connect", connect)
    yield state
    state.release.set()     # never leave a worker thread parked on a failed test
