"""Exporter cursors + the span_arm_desired echo, with a fake Store and a fake urlopen (no HTTP).

The three cursors decide whether telemetry is lost or re-sent; the echo can change the Pi's
backup-element arm intent (span-arm.json) from the cloud."""
import json
import urllib.request
from pathlib import Path

import pytest

from bridge.config import AnalyticsConfig
from bridge.exporter import Exporter

CURSOR_FILES = ("exporter-events-cursor", "exporter-span-cursor", "exporter-span-arm-cursor")


def _event(i):
    return {"id": i, "pump_id": "p1", "ts": 1000.0 + i, "type": "fault", "code": "E1",
            "severity": "warn", "message": f"m{i}", "detail": None}


def _span(i):
    return {"id": i, "ts": 1000.0 + i, "circuit_id": "c1", "name": "Air-Water 1",
            "power_w": 100.0 + i}


def _arm(i):
    return {"id": i, "ts": 1000.0 + i, "circuit_id": "c1", "relay_state": "CLOSED",
            "armed": 1, "live": 0, "action": "shadow_close", "detail": None}


class FakeStore:
    """Canned rows per feed; get_*_since returns rows with id > cursor and records the cursor."""

    def __init__(self, events=(), span=(), arm=(), system=None, fail=()):
        self.rows = {"events": list(events), "span": list(span), "arm": list(arm)}
        self.system = system
        self.fail = set(fail)
        self.calls = {"events": [], "span": [], "arm": []}

    def _since(self, feed, cursor, limit):
        self.calls[feed].append(cursor)
        if feed in self.fail:
            raise RuntimeError(f"{feed} read boom")
        return [r for r in self.rows[feed] if r["id"] > cursor][:limit]

    async def get_events_since(self, cursor, limit=200):
        return self._since("events", cursor, limit)

    async def get_span_since(self, cursor, limit=500):
        return self._since("span", cursor, limit)

    async def get_span_arm_since(self, cursor, limit=200):
        return self._since("arm", cursor, limit)

    async def get_system_latest(self):
        return self.system


class FakeResponse:
    def __init__(self, raw: bytes):
        self._raw = raw

    def read(self):
        return self._raw


class FakeUrlopen:
    """Stands in for urllib.request.urlopen: records each POSTed body, then either raises
    or returns `raw` as the response body."""

    def __init__(self, raw: bytes = b"{}", exc: Exception | None = None):
        self.raw = raw
        self.exc = exc
        self.bodies: list[dict] = []

    def __call__(self, req, timeout=None):
        self.bodies.append(json.loads(req.data))
        if self.exc is not None:
            raise self.exc
        return FakeResponse(self.raw)


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "bridge.db")


def _cfg():
    return AnalyticsConfig(endpoint_url="https://mirror.invalid/api/ingest", token="t")


def _exporter(store, db_path):
    return Exporter(_cfg(), {}, store, db_path=db_path)


def _cursors(ex):
    return (ex._cursor, ex._span_cursor, ex._span_arm_cursor)


def _cursor_file(db_path, name):
    return Path(db_path).parent / name


def _full_store():
    return FakeStore(events=[_event(3), _event(7), _event(5)],
                     span=[_span(11), _span(42)],
                     arm=[_arm(2), _arm(9)],
                     system={"cpu_pct": 5.0})


# (a) a failed POST moves no cursor, in memory or on disk ----------------------------------

async def test_failed_post_moves_no_cursor(db_path, monkeypatch):
    fake = FakeUrlopen(exc=OSError("network down"))
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    store = _full_store()
    ex = _exporter(store, db_path)

    await ex.push_once()

    assert len(fake.bodies) == 1          # the push was attempted with the rows...
    assert len(fake.bodies[0]["events"]) == 3
    assert _cursors(ex) == (0, 0, 0)      # ...but nothing advanced
    for name in CURSOR_FILES:
        assert not _cursor_file(db_path, name).exists()

    # the next push re-sends the same rows from cursor 0
    await ex.push_once()
    assert store.calls == {"events": [0, 0], "span": [0, 0], "arm": [0, 0]}


async def test_failed_post_keeps_existing_cursor_files(db_path, monkeypatch):
    for name, v in zip(CURSOR_FILES, (1, 10, 1)):
        _cursor_file(db_path, name).write_text(str(v))
    monkeypatch.setattr(urllib.request, "urlopen", FakeUrlopen(exc=OSError("boom")))
    ex = _exporter(_full_store(), db_path)

    await ex.push_once()

    assert _cursors(ex) == (1, 10, 1)
    for name, v in zip(CURSOR_FILES, ("1", "10", "1")):
        assert _cursor_file(db_path, name).read_text() == v


# (b) a 2xx advances every cursor to its max pushed id, persisted and resumable ------------

async def test_success_advances_and_persists_every_cursor(db_path, monkeypatch):
    fake = FakeUrlopen(raw=b"{}")
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    ex = _exporter(_full_store(), db_path)

    await ex.push_once()

    body = fake.bodies[0]
    assert sorted(e["source_id"] for e in body["events"]) == [3, 5, 7]
    assert sorted(s["source_id"] for s in body["span"]) == [11, 42]
    assert sorted(e["source_id"] for e in body["span_arm_events"]) == [2, 9]
    assert body["system"] == {"cpu_pct": 5.0}

    assert _cursors(ex) == (7, 42, 9)
    for name, v in zip(CURSOR_FILES, ("7", "42", "9")):
        assert _cursor_file(db_path, name).read_text() == v

    # a fresh Exporter on the same db_path resumes from the persisted cursors
    store2 = _full_store()
    ex2 = _exporter(store2, db_path)
    assert _cursors(ex2) == (7, 42, 9)
    await ex2.push_once()
    assert store2.calls == {"events": [7], "span": [42], "arm": [9]}
    body2 = fake.bodies[1]
    assert "events" not in body2 and "span" not in body2 and "span_arm_events" not in body2


async def test_success_with_no_new_rows_leaves_cursors(db_path, monkeypatch):
    for name, v in zip(CURSOR_FILES, (4, 4, 4)):
        _cursor_file(db_path, name).write_text(str(v))
    monkeypatch.setattr(urllib.request, "urlopen", FakeUrlopen())
    ex = _exporter(FakeStore(), db_path)

    await ex.push_once()

    assert _cursors(ex) == (4, 4, 4)
    for name in CURSOR_FILES:
        assert _cursor_file(db_path, name).read_text() == "4"


# (c) a corrupt or empty cursor file reads as 0 ---------------------------------------------

@pytest.mark.parametrize("content", ["", "   \n", "not-a-number", "12.5", "\x00\x00"])
async def test_corrupt_or_empty_cursor_reads_zero(db_path, content):
    for name in CURSOR_FILES:
        _cursor_file(db_path, name).write_text(content)
    ex = _exporter(FakeStore(), db_path)
    assert _cursors(ex) == (0, 0, 0)


async def test_missing_cursor_reads_zero(db_path):
    assert _cursors(_exporter(FakeStore(), db_path)) == (0, 0, 0)


# (d) a store read error in one feed still pushes and leaves only that cursor alone ---------

@pytest.mark.parametrize("bad, body_key, idx", [
    ("events", "events", 0),
    ("span", "span", 1),
    ("arm", "span_arm_events", 2),
])
async def test_one_feed_read_error_isolated(db_path, monkeypatch, bad, body_key, idx):
    fake = FakeUrlopen()
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    store = _full_store()
    store.fail = {bad}
    ex = _exporter(store, db_path)

    await ex.push_once()

    assert len(fake.bodies) == 1
    body = fake.bodies[0]
    assert body_key not in body
    expected = [7, 42, 9]
    expected[idx] = 0
    assert list(_cursors(ex)) == expected
    names = list(CURSOR_FILES)
    assert not _cursor_file(db_path, names.pop(idx)).exists()
    for name in names:
        assert _cursor_file(db_path, name).exists()


async def test_system_read_error_still_pushes(db_path, monkeypatch):
    fake = FakeUrlopen()
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    store = _full_store()

    async def boom():
        raise RuntimeError("sys boom")
    store.get_system_latest = boom
    ex = _exporter(store, db_path)

    await ex.push_once()

    assert len(fake.bodies) == 1 and "system" not in fake.bodies[0]
    assert _cursors(ex) == (7, 42, 9)


# (e) span_arm_desired echo -----------------------------------------------------------------

def _arm_path(db_path):
    return _cursor_file(db_path, "span-arm.json")


# A sentinel key that write_arm_intent would never produce: if it survives, the file was
# not rewritten.
def _seed_arm(db_path, armed):
    _arm_path(db_path).write_text(json.dumps({"armed": armed, "sentinel": 1}))


@pytest.mark.parametrize("desired", [True, False])
async def test_echo_rewrites_when_different(db_path, monkeypatch, desired):
    _seed_arm(db_path, not desired)
    monkeypatch.setattr(urllib.request, "urlopen",
                        FakeUrlopen(raw=json.dumps({"span_arm_desired": desired}).encode()))
    await _exporter(FakeStore(), db_path).push_once()
    assert json.loads(_arm_path(db_path).read_text()) == {"armed": desired}


@pytest.mark.parametrize("desired", [True, False])
async def test_echo_leaves_file_when_same(db_path, monkeypatch, desired):
    _seed_arm(db_path, desired)
    monkeypatch.setattr(urllib.request, "urlopen",
                        FakeUrlopen(raw=json.dumps({"span_arm_desired": desired}).encode()))
    await _exporter(FakeStore(), db_path).push_once()
    assert json.loads(_arm_path(db_path).read_text()) == {"armed": desired, "sentinel": 1}


@pytest.mark.parametrize("desired", [True, False])
async def test_echo_creates_missing_file(db_path, monkeypatch, desired):
    monkeypatch.setattr(urllib.request, "urlopen",
                        FakeUrlopen(raw=json.dumps({"span_arm_desired": desired}).encode()))
    await _exporter(FakeStore(), db_path).push_once()
    assert json.loads(_arm_path(db_path).read_text()) == {"armed": desired}


@pytest.mark.parametrize("raw", [
    b'{"span_arm_desired": null}',
    b'{}',
    b'{"ok": true}',
    b'{"span_arm_desired": "true"}',
    b'{"span_arm_desired": "false"}',
    b'{"span_arm_desired": 1}',
    b'{"span_arm_desired": 0}',
    b'[{"span_arm_desired": true}]',
    b'true',
    b'null',
    b'',
    b'not json at all',
])
@pytest.mark.parametrize("seeded", [True, False])
async def test_echo_ignores_non_bool_or_non_dict(db_path, monkeypatch, raw, seeded):
    _seed_arm(db_path, seeded)
    before = _arm_path(db_path).read_text()
    monkeypatch.setattr(urllib.request, "urlopen", FakeUrlopen(raw=raw))
    ex = _exporter(_full_store(), db_path)

    await ex.push_once()

    assert _arm_path(db_path).read_text() == before
    assert _cursors(ex) == (7, 42, 9)   # still a 2xx: cursors advance regardless of the body


async def test_echo_ignored_without_file_does_not_create_it(db_path, monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen",
                        FakeUrlopen(raw=b'{"span_arm_desired": null}'))
    await _exporter(FakeStore(), db_path).push_once()
    assert not _arm_path(db_path).exists()


async def test_echo_write_error_is_swallowed(db_path, monkeypatch):
    import bridge.exporter as exporter_mod

    def boom(path, armed):
        raise OSError("read-only fs")
    monkeypatch.setattr(exporter_mod, "write_arm_intent", boom)
    monkeypatch.setattr(urllib.request, "urlopen",
                        FakeUrlopen(raw=b'{"span_arm_desired": true}'))
    ex = _exporter(_full_store(), db_path)

    await ex.push_once()   # no exception = pass

    assert not _arm_path(db_path).exists()
    assert _cursors(ex) == (7, 42, 9)


# (f) the echo is never applied on a failed POST --------------------------------------------

async def test_echo_not_applied_on_failed_post(db_path, monkeypatch):
    _seed_arm(db_path, False)
    before = _arm_path(db_path).read_text()

    class RaisesAfterRead(FakeUrlopen):
        # the response body would say "arm", but reading it fails mid-way
        def __call__(self, req, timeout=None):
            self.bodies.append(json.loads(req.data))

            class Resp:
                def read(self_inner):
                    raise OSError("connection reset")
            return Resp()

    for fake in (FakeUrlopen(raw=b'{"span_arm_desired": true}', exc=OSError("down")),
                 RaisesAfterRead(raw=b'{"span_arm_desired": true}')):
        monkeypatch.setattr(urllib.request, "urlopen", fake)
        ex = _exporter(FakeStore(), db_path)
        await ex.push_once()
        assert len(fake.bodies) == 1
        assert _arm_path(db_path).read_text() == before
