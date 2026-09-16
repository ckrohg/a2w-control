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
import ast
import pathlib
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


def test_every_to_thread_worker_takes_the_thread_lock():
    """The segfault needs only ONE unguarded worker, so assert on all of them rather than on
    the three that exist today — a fourth added later is caught for free."""
    tree = ast.parse(STORE_SRC.read_text())
    workers = _worker_functions(tree)
    assert workers, "expected nested _run() workers in store.py — has the structure changed?"

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
        if not takes_lock:
            unguarded.append(fn.lineno)

    assert not unguarded, (
        f"store.py has to_thread worker(s) at line(s) {unguarded} that do NOT take "
        "self._thread_lock. A single unguarded worker is enough to let two event loops use "
        "one sqlite3 connection concurrently and segfault the process (#94)."
    )
