# @purpose: Regression guard for #94 — Store's asyncio.Lock cannot guard a sqlite3 connection
# across two event loops. asyncio.Lock serialises tasks within ONE loop and provides no
# exclusion against a second. CI ran the app's loop alongside a test's anyio blocking portal,
# both sides passed the asyncio guard, both called asyncio.to_thread, and two OS threads then
# used the same check_same_thread=False connection concurrently — segfaulting the interpreter
# (exit 139) instead of raising. Practical rule: a red bridge-tests on a PR touching no Python
# is this bug until proven otherwise; re-run before investigating.
#
# WHAT IS NOT TESTED HERE, AND WHY. A faithful reproduction needs anyio's blocking portal
# specifically — driving two plain asyncio.run() loops instead makes the threads block on the
# cross-loop asyncio.Lock and time out rather than reaching the racing sqlite call. A test
# whose failure mode is "segfault the CI runner, intermittently" is worse than no test: it is
# indistinguishable from the bug it guards. So the invariant is pinned STRUCTURALLY instead —
# every worker that touches the connection must take the threading.Lock. That is deterministic,
# runs in milliseconds, and fails loudly the moment someone "simplifies" the guard away.
#
# The one runtime case below is safe to run for real: since #319, backup() on an on-disk store
# takes no store lock and uses only its own private connection, so a second plain asyncio.run()
# loop running it never meets the first loop's asyncio.Lock or the shared connection at all.
import ast
import asyncio
import pathlib
import sqlite3
import threading

from bridge.store import Store

STORE_SRC = pathlib.Path(__file__).resolve().parents[1] / "bridge" / "store.py"


def test_store_holds_a_thread_lock_not_only_an_asyncio_lock():
    """Pins the mechanism: an asyncio.Lock alone cannot serialise across event loops."""
    s = Store(":memory:")
    assert isinstance(s._thread_lock, type(threading.Lock())), (
        "Store must guard its sqlite3 connection with a threading.Lock taken INSIDE the "
        "to_thread worker — an asyncio.Lock is per-loop and lapses when two loops are alive (#94)."
    )


def _worker_functions(tree: ast.AST) -> list[ast.FunctionDef]:
    """Every nested `def _run()` — the bodies handed to asyncio.to_thread."""
    return [n for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "_run"]


def test_no_to_thread_call_touches_the_connection_directly():
    """The blind spot that let #94 survive its first fix. The original guard checked only
    nested `def _run()` workers -- but close() passed `self._conn.close` STRAIGHT to
    asyncio.to_thread with no worker at all, so it was invisible to that check and stayed
    unguarded. Closing is the most dangerous operation of the lot: it destroys the object
    another thread may be mid-execute() on. Assert no to_thread argument is a bare
    self._conn.<attr>; it must be a worker that takes the lock."""
    tree = ast.parse(STORE_SRC.read_text())
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "to_thread"):
            continue
        for arg in node.args:
            # asyncio.to_thread(self._conn.close) -- bound method of the shared connection
            if (isinstance(arg, ast.Attribute) and isinstance(arg.value, ast.Attribute)
                    and arg.value.attr == "_conn"):
                offenders.append((node.lineno, f"self._conn.{arg.attr}"))
    assert not offenders, (
        f"asyncio.to_thread called directly on the shared connection at {offenders}. Wrap it "
        "in a worker that takes self._thread_lock -- a bare handoff is unguarded and can race "
        "another loop's in-flight query (#94)."
    )


def _touches_shared_conn(fn: ast.FunctionDef) -> bool:
    return any(isinstance(n, ast.Attribute) and n.attr == "_conn" for n in ast.walk(fn))


def _enclosing_methods(tree: ast.AST) -> dict[int, str]:
    """id(worker) -> name of the Store method it is nested in."""
    out = {}
    for meth in ast.walk(tree):
        if isinstance(meth, ast.AsyncFunctionDef | ast.FunctionDef) and meth.name != "_run":
            for fn in _worker_functions(meth):
                out[id(fn)] = meth.name
    return out


def test_every_to_thread_worker_takes_the_thread_lock():
    """The segfault needs only ONE unguarded worker, so assert on all of them rather than on
    the three that exist today — a fourth added later is caught for free. The one exemption
    is backup()'s on-disk worker, which never touches self._conn (it opens, uses and closes
    its own private connection), so there is no shared connection for it to race on; it
    must stay unlocked so the copy never holds up safety writes."""
    tree = ast.parse(STORE_SRC.read_text())
    workers = _worker_functions(tree)
    assert workers, "expected nested _run() workers in store.py — has the structure changed?"
    owner = _enclosing_methods(tree)

    unguarded = []
    for fn in workers:
        takes_lock = any(
            isinstance(node, ast.With)
            and any(
                isinstance(item.context_expr, ast.Attribute)
                and item.context_expr.attr == "_thread_lock"
                for item in node.items
            )
            for node in ast.walk(fn)
        )
        if takes_lock:
            continue
        if not _touches_shared_conn(fn) and owner.get(id(fn)) == "backup":
            continue
        unguarded.append(fn.lineno)

    assert not unguarded, (
        f"store.py has to_thread worker(s) at line(s) {unguarded} that do NOT take "
        "self._thread_lock. A single unguarded worker is enough to let two event loops use "
        "one sqlite3 connection concurrently and segfault the process (#94)."
    )


async def test_backup_on_a_second_loop_while_this_loop_reads_and_writes(tmp_path, backup_source):
    """A backup held mid-copy on another thread's event loop while this loop keeps writing and
    reading the same store: nothing waits, nothing crashes, and the copy is sound."""
    snap = {"inlet_c": 40.0, "outlet_c": 45.0, "ambient_c": 2.0, "setpoint_c": 48.0,
            "power_sys1": 1.2, "power_sys2": 0.0, "heating": True}
    store = Store(str(tmp_path / "bridge.db"))
    await store.open()
    try:
        for _ in range(30):
            await store.add_sample("p1", snap)
        dest = tmp_path / "out.db"
        backup_source.hold = True
        errors: list[BaseException] = []

        def other_loop():
            try:
                asyncio.run(store.backup(str(dest)))
            except BaseException as exc:        # surfaced to the assert below
                errors.append(exc)

        t = threading.Thread(target=other_loop)
        t.start()
        assert await asyncio.to_thread(backup_source.started.wait, 5)
        for i in range(20):
            await asyncio.wait_for(store.add_sample("p1", snap), 2)
            assert len(await asyncio.wait_for(store.get_history("p1", 1), 2)) == 31 + i
        backup_source.release.set()
        await asyncio.to_thread(t.join, 10)
        assert not t.is_alive() and not errors, errors

        conn = sqlite3.connect(dest)
        try:
            assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert conn.execute("SELECT count(*) FROM samples").fetchone()[0] == 30
        finally:
            conn.close()
    finally:
        backup_source.release.set()
        await store.close()
