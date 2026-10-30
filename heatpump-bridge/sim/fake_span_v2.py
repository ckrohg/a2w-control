# @purpose: The SPAN panel's v2 LOCAL interface for tests (#199): a minimal MQTT 3.1.1 broker on a real TLS socket
# plus the panel publishing its Homie 5 eBus tree into it, so span_v2.SpanV2 runs unmodified (real paho, real TLS).
# Shapes come from the REAL panel, not a guess: span_v2_capture.json was recorded read-only from this house's panel
# (firmware r202639, 2026-10-29) — the panel, lugs and circuit $description documents and every property topic a
# circuit publishes (the register keys are the ones 6bb's span.mjs reads from this panel's real register answer). A /set is validated against the circuit's OWN published $description (the
# property must exist, be settable, and the payload must be in its enum) and is ignored + recorded in `rejected`
# otherwise — the v2 analog of the #200 lesson, where the v1 fake accepted a body the real panel refused.
# The circuit state is FakeSpan's own dict, so one fake serves both transports and every knob (ignore_writes,
# fail_closes/opens, down, dupes) means the same on both.
from __future__ import annotations

import copy
import json
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

CAPTURE = json.loads(Path(__file__).with_name("span_v2_capture.json").read_text())
SERIAL = CAPTURE["serial"]
BROKER_USER = SERIAL
BROKER_PASSWORD = "fake-broker-password"


def make_tls(tmp: str) -> tuple[str, ssl.SSLContext]:
    """A throwaway CA + server cert for 127.0.0.1 / localhost (openssl CLI). → (CA PEM, server context)."""
    d = Path(tmp)
    ext = d / "ext.cnf"
    ext.write_text("subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n")
    run = lambda *a: subprocess.run(a, check=True, capture_output=True, cwd=tmp)  # noqa: E731
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=fake-span-ca",
        "-keyout", "ca.key", "-out", "ca.pem")
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
        "-keyout", "srv.key", "-out", "srv.csr")
    run("openssl", "x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
        "-days", "2", "-extfile", str(ext), "-out", "srv.pem")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(d / "srv.pem", d / "srv.key")
    return (d / "ca.pem").read_text(), ctx


_TLS: tuple[str, ssl.SSLContext] | None = None
LIVE: list["FakeEbus"] = []   # running fakes (tests/conftest.py flushes them before a v2 read)


def tls() -> tuple[str, ssl.SSLContext]:
    global _TLS
    if _TLS is None:
        _TLS = make_tls(tempfile.mkdtemp(prefix="fake-span-tls-"))
    return _TLS


# --- MQTT 3.1.1 wire helpers --------------------------------------------------------------
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b, n = n % 128, n // 128
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _str(s: bytes) -> bytes:
    return struct.pack("!H", len(s)) + s


def _packet(first: int, body: bytes) -> bytes:
    return bytes([first]) + _varint(len(body)) + body


def _read_exact(sock, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def _read_packet(sock) -> tuple[int, bytes]:
    first = _read_exact(sock, 1)[0]
    mult, length = 1, 0
    while True:
        b = _read_exact(sock, 1)[0]
        length += (b & 0x7F) * mult
        mult *= 128
        if not b & 0x80:
            break
    return first, _read_exact(sock, length)


def topic_matches(flt: str, topic: str) -> bool:
    f, t = flt.split("/"), topic.split("/")
    for i, part in enumerate(f):
        if part == "#":
            return True
        if i >= len(t) or (part != "+" and part != t[i]):
            return False
    return len(f) == len(t)


class FakeEbus:
    """Broker + simulated panel. `fake` is the FakeSpan whose circuits dict is the truth."""

    def __init__(self, fake):
        self.fake = fake
        self.ca_pem, self._srv_ctx = tls()
        self.retained: dict[str, bytes] = {}
        self.sessions: list[dict] = []          # {sock, subs, lock}
        self.connects: list[dict] = []          # every CONNECT seen: {username, password_ok}
        self.sets: list[tuple[str, str, int]] = []   # every /set the panel received: (topic, payload, qos)
        self.rejected: list[tuple[str, str]] = []   # /sets the panel's own $description does not allow
        self.password = BROKER_PASSWORD
        self.silent = False                     # the panel stops publishing (stale tree) but the session lives
        self.hold_retained = False              # a new SUBSCRIBE gets its SUBACK but no retained tree (yet)
        self.refuse_all = False                 # every CONNECT is refused "not authorised", whatever the creds
        self._published: dict[str, bytes] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._srv: socket.socket | None = None
        self.port: int | None = None
        LIVE.append(self)

    # --- lifecycle --------------------------------------------------------------------
    def start(self) -> int:
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(16)
        self._srv.settimeout(0.2)
        self.port = self._srv.getsockname()[1]
        self._publish_tree(initial=True)
        threading.Thread(target=self._accept_loop, daemon=True).start()
        threading.Thread(target=self._panel_loop, daemon=True).start()
        return self.port

    def stop(self) -> None:
        if self in LIVE:
            LIVE.remove(self)
        self._stop.set()
        self.drop_sessions()
        if self._srv:
            self._srv.close()

    def drop_sessions(self) -> None:
        with self._lock:
            sessions, self.sessions = self.sessions, []
        for s in sessions:
            try:
                s["sock"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s["sock"].close()

    # --- the panel ----------------------------------------------------------------------
    def _circuit_topics(self, cid: str, name: str, c: dict) -> dict[str, bytes]:
        """Every topic the real panel publishes for a circuit (from the capture), with this circuit's values."""
        tpl = CAPTURE["circuit"]
        desc = copy.deepcopy(tpl["$description"])
        desc["name"] = cid             # as the real panel does: the human name is only in info/name
        out = {f"ebus/5/{cid}/$description": json.dumps(desc).encode(),
               f"ebus/5/{cid}/$state": b"ready"}
        for prop, sample in tpl["properties"].items():
            out[f"ebus/5/{cid}/{prop}"] = str(sample).encode()
        relay = c.get("relayState")
        power = c.get("instantPowerW")
        out[f"ebus/5/{cid}/info/name"] = name.encode()
        out[f"ebus/5/{cid}/switch/relay"] = (relay or "").encode()
        out[f"ebus/5/{cid}/switch/relay-controllable"] = b"true" if c.get("isUserControllable") else b"false"
        # a missing / non-numeric v1 instantPowerW → an empty value (Homie: no value), never a made-up 0
        out[f"ebus/5/{cid}/meter/active-power"] = (
            repr(float(power)).encode() if isinstance(power, (int, float)) and not isinstance(power, bool) else b"")
        if c.get("_v2_state") is not None:
            out[f"ebus/5/{cid}/$state"] = c["_v2_state"].encode()
        return out

    def _tree(self) -> dict[str, bytes]:
        f = self.fake
        with f.lock:
            circuits = [(c["id"], n, dict(c)) for n, c in f.circuits.items()]
            circuits += [(cid, n, {**c, "id": cid}) for cid, (n, c) in f.dupes.items()]
        panel = copy.deepcopy(CAPTURE["panel"]["$description"])
        lugs = CAPTURE["lugs"]["ids"]
        panel["children"] = lugs + [cid for cid, _, _ in circuits]   # the real panel lists its lugs first
        out = {f"ebus/5/{SERIAL}/$description": json.dumps(panel).encode(),
               f"ebus/5/{SERIAL}/$state": b"ready"}
        for lid in lugs:
            out[f"ebus/5/{lid}/$description"] = json.dumps({**CAPTURE["lugs"]["$description"], "name": lid}).encode()
            out[f"ebus/5/{lid}/$state"] = b"ready"
        for prop, sample in CAPTURE["panel"]["properties"].items():
            out[f"ebus/5/{SERIAL}/{prop}"] = str(sample).encode()
        for cid, n, c in circuits:
            out.update(self._circuit_topics(cid, n, c))
        return out

    def _publish_tree(self, initial: bool = False) -> None:
        with self._lock:
            self._publish_tree_locked(initial)

    def _publish_tree_locked(self, initial: bool) -> None:
        tree = self._tree()
        for topic, payload in tree.items():
            if initial or self._published.get(topic) != payload:
                self._published[topic] = payload
                self._route(topic, payload, retain=True)
        # the real panel streams power continuously: a heartbeat keeps the tree fresh while nothing changes
        hb = f"ebus/5/{SERIAL}/{CAPTURE['panel']['heartbeat']}"
        self._route(hb, str(time.time()).encode(), retain=True)

    def flush(self, client) -> None:
        """Test hook: publish any change to FakeSpan's dict NOW and wait until `client` (a span_v2.SpanV2) has
        received it. The real panel publishes a change as it happens; this fake polls a Python dict every 20 ms,
        and a test that mutates the dict and reads at once must not race that tick."""
        if client._client is None or self.silent:
            return
        if self.fake.down:   # let the client notice the dropped session before it reads
            deadline = time.monotonic() + 2.0
            with client._cv:
                while client._connected and time.monotonic() < deadline:
                    client._cv.wait(0.05)
            return
        with self._lock:
            self._publish_tree()
            self._sync_seq = getattr(self, "_sync_seq", 0) + 1
            seq = str(self._sync_seq)
            self._route(f"ebus/5/{SERIAL}/fake/sync", seq.encode(), retain=True)
        deadline = time.monotonic() + 2.0
        with client._cv:
            while (client.tree.devs.get(SERIAL) or {}).get("props", {}).get("fake/sync") != seq:
                if time.monotonic() > deadline or not client._connected:
                    return
                client._cv.wait(0.05)

    def _panel_loop(self) -> None:
        while not self._stop.wait(0.02):
            if self.fake.down:
                if self.sessions:
                    self.drop_sessions()
            elif not self.silent:
                self._publish_tree()

    def _on_set(self, topic: str, payload: bytes, qos: int = 0) -> None:
        parts = topic.split("/")    # ebus/5/<id>/<node>/<prop>/set
        val = payload.decode("utf-8", "replace")
        self.sets.append((topic, val, qos))
        cid, node, prop = parts[2], parts[3], parts[4]
        desc = json.loads(self._published.get(f"ebus/5/{cid}/$description", b"null") or b"null") or {}
        spec = (((desc.get("nodes") or {}).get(node) or {}).get("properties") or {}).get(prop)
        allowed = (spec or {}).get("format", "").split(",") if (spec or {}).get("datatype") == "enum" else None
        if not spec or not spec.get("settable") or (allowed is not None and val not in allowed):
            self.rejected.append((topic, val))
            return
        f = self.fake
        with f.lock:
            name = next((n for n, c in f.circuits.items() if c["id"] == cid), None)
            if name is None or (node, prop) != ("switch", "relay"):
                self.rejected.append((topic, val))
                return
            f.writes.append((name, val))
            if not f.circuits[name].get("isUserControllable"):
                return
            if val == "CLOSED" and f.fail_closes > 0:
                f.fail_closes -= 1
                return
            if val == "OPEN" and f.fail_opens > 0:
                f.fail_opens -= 1
                return
            if not f.ignore_writes:
                f.circuits[name]["relayState"] = val

    # --- the broker ---------------------------------------------------------------------
    def _send_retained(self, s: dict, filters: list[str]) -> None:
        with self._lock:
            retained = list(self.retained.items())
        for topic, payload in retained:
            if any(topic_matches(flt, topic) for flt in filters):
                self._send(s, _packet(0x31, _str(topic.encode()) + payload))

    def resend_retained(self) -> None:
        """Release a held retained tree to every live session (hold_retained=False first)."""
        with self._lock:
            sessions = list(self.sessions)
        for s in sessions:
            self._send_retained(s, s["subs"])

    def _route(self, topic: str, payload: bytes, *, retain: bool) -> None:
        with self._lock:
            if retain:
                if payload:
                    self.retained[topic] = payload
                else:
                    self.retained.pop(topic, None)
            sessions = list(self.sessions)
        pkt = _packet(0x30, _str(topic.encode()) + payload)
        for s in sessions:
            if any(topic_matches(flt, topic) for flt in s["subs"]):
                self._send(s, pkt)

    def _send(self, s: dict, data: bytes) -> None:
        try:
            with s["lock"]:
                s["sock"].sendall(data)
        except OSError:
            pass

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            try:
                raw, _ = self._srv.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(raw,), daemon=True).start()

    def _serve(self, raw: socket.socket) -> None:
        try:
            raw.settimeout(5)
            sock = self._srv_ctx.wrap_socket(raw, server_side=True)
            sock.settimeout(None)
        except (OSError, ssl.SSLError):
            raw.close()
            return
        s = {"sock": sock, "subs": [], "lock": threading.Lock()}
        try:
            first, body = _read_packet(sock)
            if first >> 4 != 1:
                return
            user, pw = self._parse_connect(body)
            ok = user == BROKER_USER and pw == self.password.encode() and not self.refuse_all
            self.connects.append({"username": user, "password_ok": ok})
            if self.fake.down:
                return
            self._send(s, _packet(0x20, bytes([0, 0 if ok else 5])))
            if not ok:
                return
            with self._lock:
                self.sessions.append(s)
            while not self._stop.is_set():
                first, body = _read_packet(sock)
                kind = first >> 4
                if kind == 8:      # SUBSCRIBE
                    pid, rest, filters = body[:2], body[2:], []
                    while rest:
                        n = struct.unpack("!H", rest[:2])[0]
                        filters.append(rest[2:2 + n].decode())
                        rest = rest[3 + n:]
                    s["subs"] += filters
                    if not self.silent:
                        self._publish_tree()   # the retained tree reflects the panel as of this moment
                    self._send(s, _packet(0x90, pid + bytes(len(filters))))
                    if not self.hold_retained:
                        self._send_retained(s, filters)
                elif kind == 3:    # PUBLISH
                    qos = (first >> 1) & 3
                    n = struct.unpack("!H", body[:2])[0]
                    topic, i = body[2:2 + n].decode(), 2 + n
                    if qos:
                        self._send(s, _packet(0x40, body[i:i + 2]))
                        i += 2
                    if topic.endswith("/set"):
                        self._on_set(topic, body[i:], qos)
                elif kind == 12:   # PINGREQ
                    self._send(s, _packet(0xD0, b""))
                elif kind == 10:   # UNSUBSCRIBE
                    self._send(s, _packet(0xB0, body[:2]))
                elif kind == 14:   # DISCONNECT
                    return
        except (ConnectionError, OSError, ssl.SSLError, struct.error):
            pass
        finally:
            with self._lock:
                if s in self.sessions:
                    self.sessions.remove(s)
            try:
                sock.close()
            except OSError:
                pass

    @staticmethod
    def _parse_connect(body: bytes) -> tuple[str | None, bytes | None]:
        n = struct.unpack("!H", body[:2])[0]
        i = 2 + n + 1                 # protocol name, level
        flags = body[i]
        i += 1 + 2                    # flags, keepalive

        def field(i):
            m = struct.unpack("!H", body[i:i + 2])[0]
            return body[i + 2:i + 2 + m], i + 2 + m

        _cid, i = field(i)
        if flags & 0x04:              # will topic + message
            _, i = field(i)
            _, i = field(i)
        user = pw = None
        if flags & 0x80:
            u, i = field(i)
            user = u.decode()
        if flags & 0x40:
            pw, i = field(i)
        return user, pw
