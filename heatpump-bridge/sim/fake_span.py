# @purpose: In-process fake of the SPAN panel's LOCAL API for tests — the three endpoints the
# bridge uses (POST /api/v1/auth/register, GET /api/v1/circuits, POST /api/v1/circuits/{id}
# with relayStateIn) on a real HTTP socket, so SpanClient runs unmodified. Knobs simulate the
# failure modes breaker control must survive: writes the panel ignores (read-back mismatch),
# CLOSE requests that fail N times, a panel that stops answering, non-controllable circuits.
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeSpan:
    TOKEN = "fake-span-token"

    def __init__(self, circuits: dict[str, dict] | None = None):
        # name -> {id, relayState, isUserControllable, instantPowerW}
        self.circuits = circuits or {
            "Air-Water 1": {"id": "c-aw1", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": 2400.0},
            "Air-Water 2": {"id": "c-aw2", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": 108.0},
            "Buffer Tank": {"id": "c-bt", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": 0.0},
            "Kitchen": {"id": "c-k", "relayState": "CLOSED", "isUserControllable": True,
                        "instantPowerW": 50.0},
        }
        self.writes: list[tuple[str, str]] = []     # (circuit name, relayStateIn) in order
        self.fail_closes = 0          # next N CLOSE writes answer 500 and change nothing
        self.fail_opens = 0           # next N OPEN writes answer 500 and change nothing
        self.auth_fail_writes = 0     # next N writes answer 401 (token rejected) and change nothing
        self.ignore_writes = False    # 200 to every write, relay never changes (mismatch)
        self.down = False             # every request answers 503
        self.dupes: dict[str, tuple[str, dict]] = {}   # extra circuits {id: (name, fields)} on the wire
        self.lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None

    # --- lifecycle -----------------------------------------------------------
    def start(self) -> str:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _send(self, code: int, obj) -> None:
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authed(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {FakeSpan.TOKEN}"

            def do_GET(self):
                if fake.down:
                    return self._send(503, {"detail": "down"})
                if self.path != "/api/v1/circuits":
                    return self._send(404, {"detail": "nope"})
                if not self._authed():
                    return self._send(401, {"detail": "auth"})
                with fake.lock:
                    body = {"circuits": {c["id"]: {**c, "name": n} for n, c in fake.circuits.items()}}
                    for cid, (n, c) in fake.dupes.items():
                        body["circuits"][cid] = {**c, "id": cid, "name": n}
                return self._send(200, body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if fake.down:
                    return self._send(503, {"detail": "down"})
                if self.path == "/api/v1/auth/register":
                    return self._send(200, {"accessToken": FakeSpan.TOKEN})
                if not self.path.startswith("/api/v1/circuits/"):
                    return self._send(404, {"detail": "nope"})
                if not self._authed():
                    return self._send(401, {"detail": "auth"})
                with fake.lock:
                    if fake.auth_fail_writes > 0:
                        fake.auth_fail_writes -= 1
                        return self._send(401, {"detail": "token expired"})
                cid = self.path.rsplit("/", 1)[1]
                want = body.get("relayStateIn")
                with fake.lock:
                    name = next((n for n, c in fake.circuits.items() if c["id"] == cid), None)
                    if name is None:
                        return self._send(404, {"detail": "no circuit"})
                    fake.writes.append((name, want))
                    if want == "CLOSED" and fake.fail_closes > 0:
                        fake.fail_closes -= 1
                        return self._send(500, {"detail": "relay busy"})
                    if want == "OPEN" and fake.fail_opens > 0:
                        fake.fail_opens -= 1
                        return self._send(500, {"detail": "relay busy"})
                    if not fake.ignore_writes:
                        fake.circuits[name]["relayState"] = want
                    state = fake.circuits[name]["relayState"]
                return self._send(200, {"relayState": state})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return f"127.0.0.1:{self._server.server_address[1]}"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    # --- helpers -------------------------------------------------------------
    def relay(self, name: str) -> str:
        with self.lock:
            return self.circuits[name]["relayState"]

    def set(self, name: str, **fields) -> None:
        with self.lock:
            self.circuits[name].update(fields)
