# @purpose: In-process fake of the SPAN panel's LOCAL API for tests — the three endpoints the
# bridge uses (POST /api/v1/auth/register, GET /api/v1/circuits, POST /api/v1/circuits/{id}
# with relayStateIn) on a real HTTP socket, so SpanClient runs unmodified. Relay writes are
# validated against the panel's OWN published schema (span_set_circuit_state.openapi.json, cut
# from the real panel's /api/openapi.json) and refused with 422 exactly as the panel does — the
# fake once accepted a flat {"relayStateIn": "OPEN"} the real panel rejects. Knobs simulate the
# failure modes breaker control must survive: writes the panel ignores (read-back mismatch),
# CLOSE requests that fail N times, a panel that stops answering, non-controllable circuits.
# v2 (#199): FakeSpan(v2=True) also serves POST /api/v2/auth/register + GET /api/v2/certificate/ca and runs the
# eBus MQTT broker + panel (sim/fake_span_v2.py) over the SAME circuit state; v1=False removes the v1 endpoints
# (404), i.e. the panel after 2026-12-31.
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = json.loads((Path(__file__).with_name("span_set_circuit_state.openapi.json")).read_text())
_BODY_REF = SPEC["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"]


def schema_errors(value, schema: dict, loc: str = "body") -> list[str]:
    """Just enough JSON Schema for the panel's request models: $ref, object properties +
    required, string/boolean, enum. Unknown keys are ignored, as the panel's pydantic does."""
    if "$ref" in schema:
        return schema_errors(value, SPEC["schemas"][schema["$ref"].rsplit("/", 1)[1]], loc)
    if "enum" in schema:
        return [] if value in schema["enum"] else [f"{loc}: {value!r} not one of {schema['enum']}"]
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return [f"{loc}: value is not a valid dict"]
        errs = [f"{loc}.{k}: field required" for k in schema.get("required", []) if k not in value]
        for k, sub in schema.get("properties", {}).items():
            if k in value:
                errs += schema_errors(value[k], sub, f"{loc}.{k}")
        return errs
    if kind == "string" and not isinstance(value, str):
        return [f"{loc}: str type expected"]
    if kind == "boolean" and not isinstance(value, bool):
        return [f"{loc}: value could not be parsed to a boolean"]
    return []


class FakeSpan:
    TOKEN = "fake-span-token"
    V2_TOKEN = "fake-v2-jwt"

    # tests/conftest.py's span_transport fixture flips these to run a whole suite against a v2-only panel
    DEFAULT_V1 = True
    DEFAULT_V2 = False

    def __init__(self, circuits: dict[str, dict] | None = None, *, v1: bool | None = None, v2: bool | None = None):
        v1 = self.DEFAULT_V1 if v1 is None else v1
        v2 = self.DEFAULT_V2 if v2 is None else v2
        # name -> {id, relayState, isUserControllable, instantPowerW}. Like the real panel,
        # consumption is NEGATIVE (Air-Water 2 heating read -5694 W on 2026-10-19).
        self.circuits = circuits or {
            "Air-Water 1": {"id": "c-aw1", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": -2400.0},
            "Air-Water 2": {"id": "c-aw2", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": -108.0},
            "Buffer Tank": {"id": "c-bt", "relayState": "CLOSED", "isUserControllable": True,
                            "instantPowerW": 0.0},
            "Kitchen": {"id": "c-k", "relayState": "CLOSED", "isUserControllable": True,
                        "instantPowerW": -50.0},
        }
        self.writes: list[tuple[str, str]] = []     # (circuit name, relayState) in order
        self.rejected: list[dict] = []                # bodies refused with 422 (schema-invalid)
        self.fail_closes = 0          # next N CLOSE writes answer 500 and change nothing
        self.fail_opens = 0           # next N OPEN writes answer 500 and change nothing
        self.auth_fail_writes = 0     # next N writes answer 401 (token rejected) and change nothing
        self.ignore_writes = False    # 200 to every write, relay never changes (mismatch)
        self._down = False            # every request answers 503 (v2: the broker drops + refuses sessions)
        self.dupes: dict[str, tuple[str, dict]] = {}   # extra circuits {id: (name, fields)} on the wire
        self.lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self.v1 = v1
        self.ebus = None
        if v2:
            from .fake_span_v2 import FakeEbus
            self.ebus = FakeEbus(self)
        self.v2_registrations: list[dict] = []        # every v2 register body
        self.v2_clients: dict[str, dict] = {}         # the panel's client list (name -> Client), v1 + v2 share it
        self.v2_deleted: list[str] = []               # every DELETE /api/v2/auth/clients/{name}
        self.v1_requests: list[tuple[str, str]] = []  # every v1 request (method, path) that reached the panel
        self.passphrase: str | None = None            # None: any passphrase registers

    @property
    def down(self) -> bool:
        return self._down

    @down.setter
    def down(self, value: bool) -> None:
        self._down = bool(value)
        if self._down and self.ebus is not None:
            self.ebus.drop_sessions()   # at once, as a dead panel's sockets would be

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
                if self.path == "/api/v2/certificate/ca" and fake.ebus is not None:
                    data = fake.ebus.ca_pem.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-pem-file")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    return self.wfile.write(data)
                if self.path == "/api/v2/auth/clients" and fake.ebus is not None:
                    if self.headers.get("Authorization") != f"Bearer {FakeSpan.V2_TOKEN}":
                        return self._send(401, {"detail": "auth"})
                    with fake.lock:
                        return self._send(200, {"clients": dict(fake.v2_clients)})
                if self.path.startswith("/api/v1/"):
                    fake.v1_requests.append(("GET", self.path))
                if self.path != "/api/v1/circuits" or not fake.v1:
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
                if self.path == "/api/v2/auth/register" and fake.ebus is not None:
                    from .fake_span_v2 import BROKER_USER, CAPTURE, SERIAL
                    with fake.lock:
                        fake.v2_registrations.append(body)
                    if fake.passphrase is not None and body.get("hopPassphrase") != fake.passphrase:
                        return self._send(401, {"detail": "invalid passphrase"})
                    # exactly the keys the real panel answers with (span_v2_capture.json)
                    vals = {"accessToken": FakeSpan.V2_TOKEN, "tokenType": "bearer", "iatMs": 0, "serialNumber": SERIAL,
                            "hostname": f"span-{SERIAL}.local", "ebusBrokerHost": f"span-{SERIAL}.local",
                            "ebusBrokerUsername": BROKER_USER, "ebusBrokerPassword": fake.ebus.password,
                            "ebusBrokerMqttsPort": fake.ebus.port, "ebusBrokerWsPort": 80, "ebusBrokerWssPort": 443}
                    with fake.lock:
                        fake.v2_clients[body.get("name")] = {"description": body.get("description", ""),
                                                             "issued_at": len(fake.v2_clients)}
                    return self._send(200, {k: vals.get(k) for k in CAPTURE["register_keys"]})
                if self.path.startswith("/api/v1/"):
                    fake.v1_requests.append(("POST", self.path))
                if not fake.v1:
                    return self._send(404, {"detail": "Not Found"})
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
                errs = schema_errors(body, {"$ref": _BODY_REF})
                if errs:
                    with fake.lock:
                        fake.rejected.append(body)
                    return self._send(422, {"detail": "; ".join(errs)})   # ErrorOut
                want = (body.get("relayStateIn") or {}).get("relayState")
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

        def do_DELETE(handler):
            from urllib.parse import unquote
            prefix = "/api/v2/auth/clients/"
            if fake.ebus is None or not handler.path.startswith(prefix):
                return handler._send(404, {"detail": "Not Found"})
            if handler.headers.get("Authorization") != f"Bearer {FakeSpan.V2_TOKEN}":
                return handler._send(401, {"detail": "auth"})
            name = unquote(handler.path[len(prefix):])
            with fake.lock:
                fake.v2_deleted.append(name)
                c = fake.v2_clients.pop(name, None)
            return handler._send(200, c) if c is not None else handler._send(422, {"detail": "no such client"})
        Handler.do_DELETE = do_DELETE

        if self.ebus is not None:
            self.ebus.start()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return f"127.0.0.1:{self._server.server_address[1]}"

    def stop(self) -> None:
        if self.ebus is not None:
            self.ebus.stop()
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
