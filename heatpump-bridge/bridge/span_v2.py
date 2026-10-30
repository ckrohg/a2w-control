# @purpose: SPAN panel v2 LOCAL transport (#199) — v1 REST is removed 2026-12-31. Register over HTTP
# (POST /api/v2/auth/register with the home-owner passphrase → eBus broker credentials), fetch the panel's CA
# (GET /api/v2/certificate/ca), then ONE persistent MQTT-over-TLS session to the broker on the panel, subscribed
# to ebus/5/# (Homie 5, parent/child data model). The live device tree is served to span_local.SpanClient in the
# v1 /circuits shape, so every consumer (breaker control, self-heal, the backup fallback, deliberate stops, the
# power log) is unchanged. Relay writes publish OPEN|CLOSED to ebus/5/<circuit>/switch/relay/set.
# Safety properties this module owns (the OpenPermit choke point stays in SpanClient._set_relay_sync):
#   - Writes are QoS 0, never 1: paho re-sends queued QoS>=1 publishes after a reconnect, so a "lost" OPEN could
#     land after the CLOSE that was meant to end it. At-most-once + read-back + CLOSE retries is the safe pairing.
#   - A write is NOT SENT (V2NotSent) only when paho refused it before it reached the socket; once handed over it
#     may have landed, and the caller must never fall back to v1 for that OPEN.
#   - Stale or partial data is never "down": a disconnected or silent session, a session whose retained tree has not
#     fully arrived since its latest (re)connect, or a circuit not "ready", reads as unknown (fetch raises, or
#     relayState/instantPowerW are None), never as OPEN or 0 W. The tree is rebuilt from scratch on every reconnect.
#   - Registration backs off exponentially (REGISTER_BACKOFF_MAX_S) and deletes this bridge's own stale
#     a2w-bridge-v2-* clients, so a broker that keeps refusing cannot fill the panel's client list.
from __future__ import annotations

import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

T_CIRCUIT = "energy.ebus.device.circuit"
T_PANEL = "energy.ebus.device.distribution-enclosure"
_CLIENT_PREFIX = "a2w-bridge"
_REREGISTER_COOLDOWN_S = 600.0     # the gap after the first registration that did not lead to a session…
REGISTER_BACKOFF_MAX_S = 6 * 3600.0  # …doubling per further one, capped (never ~144 new panel clients a day)
AUTH_ALARM_STRIKES = 3             # this many registrations without a session → /health + a record-tier event
CONNECT_WAIT_S = 15.0     # first use: how long a fetch waits for the session + the retained tree
TREE_GRACE_S = 5.0        # after a SUBACK: a declared property the panel never publishes is tolerated after this
STALE_AFTER_S = 90.0      # no message from the panel for this long → the tree is stale (unknown)
NEVER_UP_S = 60.0         # a session that never connected for this long is restarted (other address, fresh CA)
ECHO_WAIT_S = 5.0         # after a /set: wait this long for switch/relay to show the new state
CREDS_FILE = "span-v2-creds.json"
CA_FILE = "span-v2-ca.pem"
REGISTER_FILE = "span-v2-register.json"   # backoff state, so a restart does not reset it


class V2NotSent(ConnectionError):
    """The write never reached the socket: nothing can have landed on the panel."""


class V2AuthError(Exception):
    """The panel refused registration (bad passphrase, proximity required): a retry won't fix it."""


def canon_id(cid) -> str:
    """One spelling of a circuit id across transports: the v2 eBus id is the v1 id's UUID with dashes."""
    return str(cid or "").replace("-", "").lower()


def tls_context(ca_pem: str) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cadata=ca_pem)
    # Python 3.13 sets VERIFY_X509_STRICT by default, and the panel's certificate fails it ("Missing Authority Key
    # Identifier"). Chain + hostname verification against the panel's own CA still apply.
    ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    return ctx


class HomieTree:
    """The panel's ebus/5 device tree, fed one MQTT message at a time (thread-safe via the owner's lock)."""

    def __init__(self):
        self.devs: dict[str, dict] = {}

    def _dev(self, did: str) -> dict:
        return self.devs.setdefault(did, {"state": None, "desc": None, "props": {}})

    def apply(self, topic: str, payload: bytes) -> str | None:
        p = topic.split("/")
        if len(p) < 4 or p[0] != "ebus" or p[1] != "5" or not p[2]:
            return None
        v = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload or "")
        d = self._dev(p[2])
        if len(p) == 4 and p[3] == "$state":
            d["state"] = v or None
            return "$state"
        if len(p) == 4 and p[3] == "$description":
            try:
                d["desc"] = json.loads(v) if v else None
            except ValueError:
                d["desc"] = None
            return "$description"
        if len(p) == 5 and not p[3].startswith("$") and not p[4].startswith("$"):
            k = f"{p[3]}/{p[4]}"
            if v == "":
                d["props"].pop(k, None)   # Homie: an empty retained payload deletes the value
            else:
                d["props"][k] = v
            return k
        return None   # /set echoes, $-attributes

    def panel(self) -> dict | None:
        return next((d for d in self.devs.values() if (d["desc"] or {}).get("type") == T_PANEL), None)

    def circuits(self) -> dict:
        """v1 GET /circuits shape: {id: {id, name, relayState, isUserControllable, instantPowerW}}. A circuit
        that is not `ready` reports no relay and no power (unknown), never a guess."""
        out = {}
        for did, d in self.devs.items():
            if (d["desc"] or {}).get("type") != T_CIRCUIT:
                continue
            p, ready = d["props"], d["state"] == "ready"
            relay = p.get("switch/relay") if ready else None
            out[did] = {
                "id": did,
                "name": p.get("info/name") or (d["desc"] or {}).get("name") or "",
                "relayState": relay if relay in ("OPEN", "CLOSED") else None,
                "isUserControllable": ready and p.get("switch/relay-controllable") == "true",
                # same sign convention as v1 instantPowerW: a load reads NEGATIVE (compare magnitudes)
                "instantPowerW": _num(p.get("meter/active-power")) if ready else None,
            }
        return out


READS = ("switch/relay", "switch/relay-controllable", "meter/active-power")   # what circuits() consumes


def _declared(desc: dict, keys) -> list[str]:
    """The `node/property` keys among `keys` that a Homie $description declares."""
    nodes = desc.get("nodes") or {}
    return [k for k in keys if k.split("/")[1] in ((nodes.get(k.split("/")[0]) or {}).get("properties") or {})]


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


class SpanV2:
    """One persistent MQTT session to the panel's broker, started lazily on first use and kept by paho's network
    thread (auto-reconnect). All methods are blocking and meant for worker threads (SpanClient runs them under its
    own lock)."""

    def __init__(self, host: str, passphrase: str, *, ip_fallback: str | None = None,
                 state_dir: str | None = None, timeout_s: float = 8.0, mqtt_port: int | None = None):
        self.host = host
        self.ip_fallback = ip_fallback
        self.passphrase = passphrase
        self.state_dir = state_dir
        self.timeout_s = timeout_s
        self.mqtt_port = mqtt_port          # tests: override the port the panel advertises
        self.tree = HomieTree()
        self._cv = threading.Condition()    # guards tree + session flags; notified on every message
        self._good_session = False           # set by on_connect; consumed by _ensure_session (resets the backoff)
        self._client = None
        self._connected = False
        self._subscribed = False
        self._auth_failed = False
        self._last_msg: float | None = None  # monotonic
        self._subscribed_at = 0.0
        self._ever_connected = False         # this session has connected at least once
        self._starts = 0                     # sessions started (alternates host / ip_fallback)
        self._started_at = 0.0
        self._next_start = 0.0               # after a failed start, wait before trying again
        self._tree_complete = False          # this connection's retained tree has fully arrived (latched)
        self._reg = {"last": 0.0, "strikes": 0}   # registrations since the last good session (persisted)
        self._reg_loaded = False
        self._bg_lock = threading.Lock()     # one background start at a time (the soak)
        self._closed = False
        self._creds: dict | None = None
        self._ca: str | None = None
        self.last_error: str | None = None
        self.broker: str | None = None       # host:port of the live session (for /health)

    # --- persistence -------------------------------------------------------------
    def _path(self, name: str) -> Path | None:
        return Path(self.state_dir) / name if self.state_dir else None

    def _read(self, name: str) -> str | None:
        p = self._path(name)
        try:
            return p.read_text() if p else None
        except OSError:
            return None

    def _write(self, name: str, text: str, mode: int = 0o600) -> None:
        p = self._path(name)
        if not p:
            return
        tmp = p.with_suffix(".tmp")
        try:   # atomic: a half-written credential at this power-outage-prone site is useless
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
            with os.fdopen(fd, "w") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        except OSError as e:
            log.warning("span v2: persisting %s failed: %s", name, e)

    # --- HTTP: register + CA -------------------------------------------------------
    def _bases(self) -> list[str]:
        return [f"http://{h}" for h in (self.host, self.ip_fallback) if h]

    def _http(self, path: str, *, body: dict | None = None, method: str | None = None,
              token: str | None = None) -> tuple[int, bytes]:
        last = "no reachable base"
        for base in self._bases():
            data = json.dumps(body).encode() if body is not None else None
            headers = {"Content-Type": "application/json"} if body is not None else {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(f"{base}{path}", data=data, headers=headers,
                                         method=method or ("POST" if body is not None else "GET"))
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.read() or b""
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                last = f"{base}: {e}"
        raise ConnectionError(f"panel unreachable ({last})")

    def _load_reg(self) -> None:
        if self._reg_loaded:
            return
        self._reg_loaded = True
        try:
            r = json.loads(self._read(REGISTER_FILE) or "null") or {}
            self._reg = {"last": float(r.get("last", 0.0)), "strikes": int(r.get("strikes", 0))}
        except (ValueError, TypeError, AttributeError):
            pass

    def _save_reg(self) -> None:
        self._write(REGISTER_FILE, json.dumps(self._reg))

    def register_backoff_s(self) -> float:
        """Seconds until another registration is allowed (0 = now)."""
        self._load_reg()
        n = self._reg["strikes"]
        if n <= 0:
            return 0.0
        gap = min(_REREGISTER_COOLDOWN_S * 2 ** (n - 1), REGISTER_BACKOFF_MAX_S)
        return max(0.0, self._reg["last"] + gap - time.time())

    def _register(self) -> dict:
        left = self.register_backoff_s()
        if left > 0:
            raise ConnectionError(f"v2 re-register backing off ({left:.0f}s left, "
                                  f"{self._reg['strikes']} registrations without a session)")
        # counted BEFORE the attempt and cleared only by a good session: a broker that keeps refusing what the
        # panel just issued backs off exponentially instead of minting a new panel client every 10 minutes
        self._reg = {"last": time.time(), "strikes": self._reg["strikes"] + 1}
        self._save_reg()
        name = f"{_CLIENT_PREFIX}-v2-{os.urandom(4).hex()}"   # the panel refuses a duplicate name
        status, raw = self._http("/api/v2/auth/register", body={
            "name": name, "description": "A2W bridge — circuit power + breaker control",
            "hopPassphrase": self.passphrase})
        try:
            j = json.loads(raw or b"null") or {}
        except ValueError:
            j = {}
        if status == 404:
            raise ConnectionError("v2 not offered by this panel (HTTP 404 on /api/v2/auth/register)")
        if status != 200:
            raise V2AuthError(f"v2 register rejected: HTTP {status} {str(j.get('detail', ''))[:200]}".rstrip())
        if not j.get("ebusBrokerUsername") or not j.get("ebusBrokerPassword"):
            raise V2AuthError("v2 register returned no broker credentials")
        creds = {"name": name, "serial": j.get("serialNumber"), "username": j["ebusBrokerUsername"],
                 "password": j["ebusBrokerPassword"], "broker_host": j.get("ebusBrokerHost") or j.get("hostname"),
                 "port": int(j.get("ebusBrokerMqttsPort") or 8883), "registered_at": time.time(),
                 "token": j.get("accessToken")}
        self._write(CREDS_FILE, json.dumps(creds))
        log.info("span v2: registered with the panel as %s", name)
        self._delete_stale_clients(name, j.get("accessToken"))
        return creds

    def _delete_stale_clients(self, keep: str, token: str | None) -> None:
        """Delete this bridge's OWN earlier v2 clients (a2w-bridge-v2-*, never another prefix: not the v1 client,
        not 6bb's, not a probe) through the panel's DELETE /api/v2/auth/clients/{name}. Best effort."""
        if not token:
            return
        try:
            status, raw = self._http("/api/v2/auth/clients", token=token)
            names = list((json.loads(raw or b"null") or {}).get("clients", {})) if status == 200 else []
        except (ConnectionError, ValueError, AttributeError) as e:
            log.info("span v2: listing panel clients failed: %s", e)
            return
        for name in names:
            if name.startswith(f"{_CLIENT_PREFIX}-v2-") and name != keep:
                try:
                    status, _ = self._http(f"/api/v2/auth/clients/{urllib.parse.quote(name, safe='')}",
                                           method="DELETE", token=token)
                    log.info("span v2: deleted stale panel client %s (HTTP %s)", name, status)
                except ConnectionError as e:
                    log.info("span v2: deleting stale panel client %s failed: %s", name, e)

    def _ensure_creds(self) -> dict:
        if self._creds is None:
            try:
                c = json.loads(self._read(CREDS_FILE) or "null")
            except ValueError:
                c = None
            self._creds = c if isinstance(c, dict) and c.get("username") and c.get("password") else None
        if self._creds is None:
            self._creds = self._register()
        return self._creds

    def _ensure_ca(self) -> str:
        if self._ca is None:
            self._ca = self._read(CA_FILE)
        if not self._ca:
            status, raw = self._http("/api/v2/certificate/ca")
            pem = raw.decode("ascii", "replace")
            if status != 200 or "BEGIN CERTIFICATE" not in pem:
                raise ConnectionError(f"v2 panel CA unavailable (HTTP {status})")
            self._ca = pem
            self._write(CA_FILE, pem, 0o644)
        return self._ca

    # --- MQTT session -----------------------------------------------------------------
    def _start(self) -> None:
        import paho.mqtt.client as mqtt   # local: only the v2 path needs it

        creds, ca = self._ensure_creds(), self._ensure_ca()
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"a2w-{os.urandom(4).hex()}",
                        clean_session=True)
        c.username_pw_set(creds["username"], creds["password"])
        c.tls_set_context(tls_context(ca))
        c.reconnect_delay_set(1, 30)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_subscribe = self._on_subscribe
        c.on_message = self._on_message
        c.on_connect_fail = self._on_connect_fail
        port = self.mqtt_port or creds["port"]
        # Connect by the configured address (the panel's cert names its broker host AND its IP); a session that
        # never comes up rotates to the other one. An address may carry the HTTP port ("10.0.0.5:80"): MQTT uses
        # the port the panel advertised.
        hosts = [h.rsplit(":", 1)[0] if h.count(":") == 1 else h for h in (self.host, self.ip_fallback) if h]
        host = hosts[self._starts % len(hosts)]
        self._starts += 1
        self._started_at = time.monotonic()
        self.broker = f"{host}:{port}"
        with self._cv:
            self._connected = self._subscribed = self._auth_failed = self._ever_connected = False
            self._tree_complete = False
            self.tree = HomieTree()
            self._last_msg = None
        self._client = c
        c.connect_async(host, port, keepalive=30)
        c.loop_start()

    def _stop(self) -> None:
        c, self._client = self._client, None
        if c is not None:
            try:
                c.disconnect()
                c.loop_stop()
            except Exception:  # noqa: BLE001 — tearing it down anyway
                pass
        with self._cv:
            self._connected = self._subscribed = False
            self._cv.notify_all()

    def close(self) -> None:
        self._closed = True
        self._stop()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        with self._cv:
            if reason_code.is_failure:
                self.last_error = f"broker refused the session: {reason_code}"
                # 4/5 (bad credentials / not authorised) + their MQTT 5 spellings: the panel forgot us
                self._auth_failed = reason_code.value in (4, 5, 134, 135)
                self._cv.notify_all()
                return
            self._connected = self._ever_connected = True
            self.last_error = None
            # A new session starts from nothing: the tree, the message clock and the completeness latch from before
            # the outage must not pass for current between this SUBACK and the panel's retained re-send.
            self.tree = HomieTree()
            self._last_msg = None
            self._subscribed = self._tree_complete = False
            self._good_session = True
            self._cv.notify_all()
        client.subscribe("ebus/5/#", qos=0)

    def _on_connect_fail(self, client, userdata):
        with self._cv:
            self.last_error = "could not reach the panel broker (TCP/TLS)"
            self._cv.notify_all()

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        with self._cv:
            self._connected = self._subscribed = False
            if reason_code is not None and getattr(reason_code, "is_failure", False):
                self.last_error = f"broker session lost: {reason_code}"
            self._cv.notify_all()

    def _on_subscribe(self, client, userdata, mid, reason_codes, properties=None):
        with self._cv:
            self._subscribed = True
            self._subscribed_at = time.monotonic()
            self._cv.notify_all()

    def _on_message(self, client, userdata, msg):
        with self._cv:
            if self.tree.apply(msg.topic, msg.payload) is not None:
                self._last_msg = time.monotonic()
            self._cv.notify_all()

    # --- state ---------------------------------------------------------------------
    def _synced(self) -> bool:
        """The retained tree has arrived: subscribed, the panel device is `ready`, and every child it lists is
        described (a circuit child also has every property A2W reads that its own $description declares). A panel description without a children list falls
        back to a beat after the SUBACK (the broker sends the retained tree right behind it). Not a quiet-period
        test: the panel streams power continuously, so the burst never goes quiet."""
        if not (self._connected and self._subscribed):
            return False
        panel = self.tree.panel()
        if panel is None or panel["state"] != "ready":
            return False
        children = [str(x.get("id") if isinstance(x, dict) else x)
                    for x in ((panel["desc"] or {}).get("children") or [])]
        if not children:
            return time.monotonic() - self._subscribed_at >= 1.0
        for cid in children:
            d = self.tree.devs.get(cid)
            if d is None or d["desc"] is None or d["state"] is None:
                return False
            if d["desc"].get("type") == T_CIRCUIT and any(k not in d["props"] for k in _declared(d["desc"], READS)):
                return False
        return True

    def _usable_reason(self) -> str | None:
        if self._auth_failed:
            return self.last_error or "broker refused the credentials"
        if not self._connected:
            return self.last_error or "not connected to the panel broker"
        if not self._subscribed or self._last_msg is None or self.tree.panel() is None:
            return "panel tree not received yet on this connection"
        if not self._tree_complete:
            # latched per connection: once the retained tree is complete, a property that later goes away reads
            # as unknown on its circuit, it does not make the whole panel unreadable. A declared property the panel
            # never publishes is tolerated TREE_GRACE_S after this connection's SUBACK (the real retained burst
            # takes ~0.12 s).
            if self._synced() or time.monotonic() - self._subscribed_at >= TREE_GRACE_S:
                self._tree_complete = True
            else:
                return "panel tree still arriving on this connection"
        age = time.monotonic() - self._last_msg
        if age > STALE_AFTER_S:
            return f"no message from the panel for {age:.0f} s (stale)"
        return None

    def _ensure_session(self, wait: bool = True) -> None:
        """Start (or after an auth refusal, re-register and restart) the session; on a fresh start wait for the
        retained tree. Raises ConnectionError / V2AuthError when v2 cannot be started right now."""
        if self._good_session:          # a session came up: the registration that made it is good
            self._good_session = False
            self._load_reg()
            if self._reg["strikes"]:
                self._reg["strikes"] = 0
                self._save_reg()
        if self._client is not None and self._auth_failed:
            log.info("span v2: broker refused our credentials — re-registering from the passphrase")
            self._stop()
            self._creds = None
            p = self._path(CREDS_FILE)
            if p:
                p.unlink(missing_ok=True)
        elif (self._client is not None and not self._ever_connected
              and time.monotonic() - self._started_at > NEVER_UP_S):
            # Never came up: rotate to the other address, and re-fetch the CA (a firmware update may have
            # re-issued it; a stale cached CA would otherwise fail TLS forever).
            log.warning("span v2: no session on %s after %.0f s (%s) — restarting", self.broker, NEVER_UP_S,
                        self.last_error)
            self._stop()
            self._ca = None
            p = self._path(CA_FILE)
            if p:
                p.unlink(missing_ok=True)
        if self._client is None:
            if time.monotonic() < self._next_start:
                raise ConnectionError(f"v2: waiting to retry ({self.last_error})")
            try:
                self._start()
            except (V2AuthError, ConnectionError, OSError, ValueError, ssl.SSLError) as e:
                self.last_error = str(e)
                # a dead panel must not cost every poll a timeout; a registration backoff sets its own time
                self._next_start = time.monotonic() + (self.register_backoff_s() or 60.0)
                raise ConnectionError(f"v2: {e}") if not isinstance(e, V2AuthError) else e
            if not wait:
                return
            deadline = time.monotonic() + CONNECT_WAIT_S
            with self._cv:
                while self._usable_reason() is not None and not self._auth_failed:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    self._cv.wait(min(left, 0.25))

    def fetch(self, wait: bool = True) -> dict:
        """The tree in the v1 /circuits shape. wait=False (the soak) never blocks at all: starting, re-registering
        or restarting the session (HTTP to the panel, up to timeout_s per address) runs on a background thread, and
        until it has a complete tree the read raises."""
        if wait:
            self._ensure_session(True)
        else:
            self._kick()
        with self._cv:
            why = self._usable_reason()
            if why:
                raise ConnectionError(f"v2: {why}")
            return self.tree.circuits()

    def _kick(self) -> None:
        """Run _ensure_session on a daemon thread unless one is already running. Never blocks the caller."""
        if self._closed or not self._bg_lock.acquire(blocking=False):
            return

        def run():
            try:
                if not self._closed:
                    self._ensure_session(False)
            except Exception as e:  # noqa: BLE001 — reported through status()/the next read
                self.last_error = str(e)[:300]
            finally:
                if self._closed:
                    self._stop()
                self._bg_lock.release()
        threading.Thread(target=run, name="span-v2-start", daemon=True).start()

    def set_relay(self, circuit_id: str, want: str, before_send=None) -> str | None:
        """Publish OPEN|CLOSED, then wait up to ECHO_WAIT_S for switch/relay to show it. Returns the relay state
        seen (None = unknown). Raises V2NotSent when nothing can have reached the panel, ConnectionError when the
        write may have been delivered but the outcome is unknown. `before_send` (the OpenPermit recheck) runs last,
        immediately before the publish, outside every v2 lock; whatever it raises propagates with nothing sent."""
        try:
            self._ensure_session()
        except Exception as e:  # noqa: BLE001 — could not even start: nothing sent
            raise V2NotSent(str(e)) from e
        with self._cv:
            why = self._usable_reason()
            did = next((d for d in self.tree.devs if canon_id(d) == canon_id(circuit_id)), None)
        if why:
            raise V2NotSent(f"v2: {why}")
        if did is None:
            raise V2NotSent(f"v2: circuit {circuit_id!r} is not on the panel's eBus tree")
        if before_send is not None:
            before_send()
        info = self._client.publish(f"ebus/5/{did}/switch/relay/set", want, qos=0, retain=False)
        if info.rc != 0:
            raise V2NotSent(f"v2: publish refused before sending (rc={info.rc})")
        deadline = time.monotonic() + ECHO_WAIT_S
        with self._cv:
            while True:
                d = self.tree.devs.get(did) or {}
                state = (d.get("props") or {}).get("switch/relay")
                if state == want:
                    return state
                left = deadline - time.monotonic()
                if left <= 0:
                    return state if state in ("OPEN", "CLOSED") else None
                self._cv.wait(min(left, 0.25))

    def status(self) -> dict:
        self._load_reg()
        with self._cv:
            age = None if self._last_msg is None else round(time.monotonic() - self._last_msg, 1)
            strikes = self._reg["strikes"]
            return {"started": self._client is not None, "connected": self._connected,
                    "synced": self._synced() if self._client is not None else False,
                    "broker": self.broker, "last_message_age_s": age,
                    "serial": (self._creds or {}).get("serial"), "error": self.last_error,
                    "register_strikes": strikes, "register_backoff_s": round(self.register_backoff_s()),
                    "auth_alarm": strikes >= AUTH_ALARM_STRIKES}
