# @purpose: SPAN local-API poller for high-resolution circuit power — the "Buffer Tank" backup
# element (Gap B) plus the "Air-Water 1/2" heat-pump circuits (ground truth for the Modbus power
# calibration, Gap A). LAN-only instant power (instantPowerW), complementing spanwatch's
# hourly-cloud energy backbone (the hybrid: cloud is the always-there record, this is the
# best-effort high-res layer). Resilient by design:
#   - mints its own bearer token from the stored home-owner passphrase and AUTO-RE-REGISTERS on
#     ANY auth failure (401/403/412). The fragility of the manual "On-premise" link was its
#     session needing a human re-login; a headless re-mint eliminates that failure mode.
#   - addresses the panel by mDNS hostname with an IP fallback, so a DHCP lease change or a
#     stale IP does not break polling.
#   - best-effort: a SPAN outage gaps THIS series only — control, the bridge, and the
#     hourly-cloud record are all unaffected. urllib in a thread (no new dependency).
# Relay writes are CLOSE-ONLY unless the caller holds an OpenPermit, which only the guarded
# breaker controller (span_control.py) mints — see SpanClient._set_relay_sync.
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

# SPAN rejects a duplicate client name ("Name already exists"), so every registration uses a
# fresh unique name. Registration is rare — the minted token is long-lived and persisted, so we
# re-register only when a token is genuinely dead, rate-limited by _REREGISTER_COOLDOWN_S so a
# bad passphrase can never spam the panel's client list.
_CLIENT_PREFIX = "a2w-bridge"
_REREGISTER_COOLDOWN_S = 600.0


def _detail(payload) -> str:
    """The panel's error text for a log line: ErrorOut is {"detail": "<message>"}; FastAPI's own
    request-validation 422 is {"detail": [{"loc": …, "msg": …}, …]}. Bounded, never raises."""
    detail = payload.get("detail") if isinstance(payload, dict) else payload
    if not detail:
        return ""
    if isinstance(detail, list):
        detail = "; ".join(
            f"{'.'.join(str(x) for x in d.get('loc', []))}: {d.get('msg')}" if isinstance(d, dict)
            else str(d) for d in detail)
    return f" — {str(detail)[:300]}"


class SpanAuthError(Exception):
    """Register failed for a reason a retry won't fix (bad passphrase, proximity required)."""


class SpanClient:
    """SPAN local client: reuses a persisted long-lived bearer token, re-mints from the
    passphrase ONLY when the token is dead (rare). Addressing tries `host` (mDNS name) then
    `ip_fallback`. All network calls run in a thread (urllib) so they never block the loop."""

    def __init__(self, host: str, passphrase: str, *, ip_fallback: str | None = None,
                 token: str | None = None, token_path: str | None = None, timeout_s: float = 8.0):
        self.host = host
        self.ip_fallback = ip_fallback
        self.passphrase = passphrase
        self.timeout_s = timeout_s
        self.token_path = token_path
        self._token = token or self._load_token()
        self._base: str | None = None       # last base URL that worked (host or ip)
        self._last_register = 0.0            # cooldown clock for re-registration
        # One panel conversation at a time: the poll loop and the breaker controller share this
        # client from worker threads, and a token re-mint mutates _token/_base and the token file.
        self._lock = threading.RLock()

    # --- token persistence (survive restarts so we almost never re-register) --
    def _load_token(self) -> str | None:
        if not self.token_path:
            return None
        try:
            return Path(self.token_path).read_text().strip() or None
        except OSError:
            return None

    def _persist_token(self, token: str) -> None:
        if not self.token_path:
            return
        tmp = Path(self.token_path).with_suffix(".tmp")
        try:  # atomic write — a half-written token at this power-outage-prone site is useless
            with open(tmp, "w") as f:
                f.write(token)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.token_path)
        except OSError as e:
            log.warning("span token persist failed: %s", e)

    # --- addressing -----------------------------------------------------------
    def _candidates(self) -> list[str]:
        hosts = [self.host] + ([self.ip_fallback] if self.ip_fallback else [])
        # prefer whichever base last worked, so we don't re-pay a dead-host timeout every poll
        if self._base and self._base in [f"http://{h}" for h in hosts]:
            hosts.sort(key=lambda h: 0 if f"http://{h}" == self._base else 1)
        return [f"http://{h}" for h in hosts if h]

    def _request(self, base: str, path: str, *, method: str = "GET",
                 body: dict | None = None, token: str | None = None) -> tuple[int, dict | None]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{base}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            payload = None
            try:
                payload = json.loads(e.read() or b"null")
            except Exception:  # noqa: BLE001
                payload = None
            return e.code, payload

    # --- auth -----------------------------------------------------------------
    def _register_sync(self) -> str:
        # Rate-limit: a genuinely bad passphrase must not create a new panel client every poll.
        since = time.time() - self._last_register
        if since < _REREGISTER_COOLDOWN_S:
            raise ConnectionError(f"re-register on cooldown ({_REREGISTER_COOLDOWN_S - since:.0f}s left)")
        self._last_register = time.time()
        # Unique name every time — SPAN rejects a duplicate ("Name already exists"). A random
        # suffix is collision-proof (a timestamp can repeat within a second on a fast LAN).
        body = {"name": f"{_CLIENT_PREFIX}-{os.urandom(4).hex()}",
                "description": "A2W bridge — circuit power logging",
                "hopPassphrase": self.passphrase}
        last_err = "no reachable base"
        for base in self._candidates():
            try:
                status, payload = self._request(base, "/api/v1/auth/register",
                                                method="POST", body=body)
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                last_err = f"{base}: {e}"
                continue
            if status == 200 and payload and payload.get("accessToken"):
                self._base = base
                self._persist_token(payload["accessToken"])
                return payload["accessToken"]
            detail = (payload or {}).get("detail", f"HTTP {status}")
            # a bad passphrase / proximity requirement won't be fixed by retrying another base
            raise SpanAuthError(f"register rejected: {detail}")
        raise ConnectionError(f"register: panel unreachable ({last_err})")

    # --- reads ----------------------------------------------------------------
    def _circuits_sync(self, token: str) -> dict:
        last_err = "no reachable base"
        for base in self._candidates():
            try:
                status, payload = self._request(base, "/api/v1/circuits", token=token)
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                last_err = f"{base}: {e}"
                continue
            if status == 200 and payload is not None:
                self._base = base
                return payload.get("circuits", payload)
            if status in (401, 403, 412):
                raise PermissionError(f"circuits auth failed: HTTP {status}")
            last_err = f"{base}: HTTP {status}"
        raise ConnectionError(f"circuits: {last_err}")

    def _fetch_sync(self) -> dict:
        """Return {circuits} with a valid token, re-registering ONCE on an auth failure."""
        if not self._token:
            self._token = self._register_sync()
        try:
            return self._circuits_sync(self._token)
        except PermissionError:
            log.info("span local token rejected — auto-re-registering from passphrase")
            self._token = self._register_sync()  # the resilience keystone
            return self._circuits_sync(self._token)

    def _fetch_locked(self) -> dict:
        with self._lock:
            return self._fetch_sync()

    async def fetch_circuits(self) -> dict:
        return await asyncio.to_thread(self._fetch_locked)

    # --- writes: CLOSE-ONLY by default (the safety keystone) ------------------
    def _set_relay_sync(self, circuit_id: str, want: str, *,
                        open_permit: "OpenPermit | None" = None) -> str:
        # HARD invariant: without an OpenPermit, A2W may only CLOSE a circuit (make it
        # AVAILABLE), never OPEN it. That property is what makes the backup-element arm safe —
        # it can never disable the failsafe, and never switches a live load off. Enforced here
        # so NO caller can bypass it. (See knowledge/reference/span-backup-arm-spec.md.)
        # The ONE exception (owner decision 2026-10-18): span_control.BreakerController mints a
        # short-lived OpenPermit for exactly one circuit after every guard has passed (allowlist,
        # per-circuit OFF opt-in, controllable, global lock, never two heat pumps off). The arm
        # path never holds a permit, so it stays close-only by construction.
        if want == "OPEN":
            if not isinstance(open_permit, OpenPermit):
                raise ValueError("set_relay is CLOSE-ONLY — refused 'OPEN' (no open permit)")
            open_permit.check(circuit_id)
        elif want != "CLOSED":
            raise ValueError(f"set_relay: unknown relay state {want!r}")
        if not self._token:
            self._token = self._register_sync()
        # The panel's schema (OpenAPI Body_set_circuit_state…: relayStateIn → RelayStateIn) nests
        # the state: {"relayStateIn": {"relayState": "OPEN"}}. A flat {"relayStateIn": "OPEN"}
        # fails validation with HTTP 422 — the 2026-10-19 Air-Water 2 power-cycle test.
        body = {"relayStateIn": {"relayState": want}}
        last_err = "no reachable base"
        maybe_sent = False   # an OPEN POST went out and was not definitively rejected
        for base in self._candidates():
            for attempt in (1, 2):  # one transparent re-auth on an auth failure
                if want == "OPEN":
                    # The guard + expiry hold for EVERY OPEN POST, retries included. If a
                    # previous POST may have landed, a refusal now is NOT "nothing sent".
                    try:
                        open_permit.recheck()
                    except OpenAborted as exc:
                        if maybe_sent:
                            raise ConnectionError(f"OPEN retry aborted after a possibly-delivered "
                                                  f"OPEN: {exc}") from exc
                        raise
                try:
                    status, payload = self._request(
                        base, f"/api/v1/circuits/{circuit_id}", method="POST", body=body, token=self._token)
                except (urllib.error.URLError, OSError, TimeoutError) as e:
                    maybe_sent = maybe_sent or want == "OPEN"   # may have reached the panel
                    last_err = f"{base}: {e}"; break
                if status == 200:
                    self._base = base
                    return (payload or {}).get("relayState", want)
                if status in (401, 403, 412) and attempt == 1:
                    # a definitive auth rejection: THIS post was not applied (earlier ones keep
                    # whatever maybe_sent already says)
                    self._token = self._register_sync(); continue
                maybe_sent = maybe_sent or want == "OPEN"       # any other answer: unknown
                last_err = f"{base}: HTTP {status}{_detail(payload)}"; break
        raise ConnectionError(f"set_relay: {last_err}")

    async def set_relay(self, circuit_id: str, want: str = "CLOSED", *,
                        open_permit: "OpenPermit | None" = None) -> str:
        def _locked():
            with self._lock:
                return self._set_relay_sync(circuit_id, want, open_permit=open_permit)
        return await asyncio.to_thread(_locked)


class OpenAborted(Exception):
    """The permit's guard refused at the dispatch boundary: NOTHING was sent to the panel."""


class OpenPermit:
    """Capability to OPEN one SPAN circuit, once, within a few seconds. Minted only by
    span_control.BreakerController after its guards pass; SpanClient refuses OPEN without one.
    Single-use so a stray reference can never be replayed into a second OFF. An optional
    `guard()` runs LAST — in the worker, under the client lock, immediately before the POST — and
    aborts with OpenAborted if it returns a reason (callers' last-moment re-validation)."""

    TTL_S = 30.0

    def __init__(self, circuit_id: str, name: str, reason: str, guard=None):
        self.circuit_id = circuit_id
        self.name = name
        self.reason = reason
        self.guard = guard
        self._expires = time.monotonic() + self.TTL_S
        self._used = False

    def check(self, circuit_id: str) -> None:
        if self._used:
            raise ValueError(f"open permit for '{self.name}' already used")
        if circuit_id != self.circuit_id:
            raise ValueError(f"open permit is for '{self.name}', not circuit {circuit_id!r}")
        if time.monotonic() > self._expires:
            raise ValueError(f"open permit for '{self.name}' expired")
        self._used = True   # the guard runs before each POST (recheck), not here

    def recheck(self) -> None:
        """Expiry + guard, run before each OPEN POST (check() has already consumed the permit)."""
        if time.monotonic() > self._expires:
            raise OpenAborted(f"open permit for '{self.name}' expired")
        if self.guard is not None:
            why = self.guard()
            if why:
                raise OpenAborted(why)


def extract_powers(circuits: dict, names: list[str]) -> list[dict]:
    """Pick the named circuits out of a /circuits response → [{circuit_id, name, power_w}]."""
    by_name = {(c.get("name") or "").strip(): c for c in circuits.values()}
    out = []
    for name in names:
        c = by_name.get(name)
        if c is not None:
            out.append({"circuit_id": c.get("id"), "name": name,
                        "power_w": float(c.get("instantPowerW") or 0.0)})
    return out


def _power_or_none(v) -> float | None:
    """instantPowerW as reported, or None when the panel gave none: an unknown draw is not 0 W (the backup fallback and
    the element-open guard must be able to tell them apart). Every consumer of power_w is None-safe."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def extract_relay(circuits: dict, name: str) -> dict | None:
    """Find the named circuit's relay state → {circuit_id, name, relay_state, controllable, power_w (None = unknown)}."""
    for c in circuits.values():
        if (c.get("name") or "").strip() == name:
            return {"circuit_id": c.get("id"), "name": name,
                    "relay_state": c.get("relayState"),  # "OPEN" (off) | "CLOSED" (available)
                    "controllable": bool(c.get("isUserControllable")),
                    "power_w": _power_or_none(c.get("instantPowerW"))}
    return None


def house_load_w(circuits: dict) -> float | None:
    """#241: the whole-house draw from one /circuits read — every circuit's |instantPowerW| (consumption is negative on
    this panel; abs also counts any producing circuit as load, the safe side) EXCEPT the backup element's own, which the
    generator budget adds at its full rating. None (= unknown, the element stays locked out) when ANY other circuit has
    no power reading: summing the rest would read a 7 kW EV charger whose value is missing (a v2 session still filling
    in after a reconnect, #239) as 0 W. Loads not on a SPAN circuit (none known) are what generator_margin_w is for."""
    from .config import BACKUP_ELEMENT_CIRCUIT
    total = 0.0
    seen = 0
    for c in circuits.values():
        if (c.get("name") or "").strip() == BACKUP_ELEMENT_CIRCUIT:
            continue
        v = c.get("instantPowerW")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        total += abs(float(v))
        seen += 1
    return round(total, 1) if seen else None


# --- arm intent: owner-set, persisted on the bridge (default DISARMED) --------
def read_arm_intent(path: str | None, default: bool) -> bool:
    """Read the owner's ARM intent. Missing/unreadable file → the config default (fail-safe:
    the bridge never 'wakes up armed' on its own — default is DISARMED)."""
    if not path:
        return default
    try:
        return bool(json.loads(Path(path).read_text()).get("armed", default))
    except (OSError, ValueError):
        return default


def write_arm_intent(path: str, armed: bool) -> None:
    tmp = Path(path).with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump({"armed": bool(armed)}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class SpanLocalPoller:
    """Polls the configured circuits' instantPowerW every ~interval and persists each to the
    store. Never raises into the event loop; tracks last-success for a down-alert."""

    def __init__(self, cfg, store, *, notify=None, token_path: str | None = None,
                 arm_state_path: str | None = None):
        self.cfg = cfg
        self.store = store
        self.notify = notify
        self.client = SpanClient(cfg.host, cfg.passphrase, ip_fallback=cfg.ip_fallback,
                                 token_path=token_path)
        self.arm_state_path = arm_state_path
        self._task: asyncio.Task | None = None
        self._last_ok = 0.0
        self._down_alerted = False
        self._last_arm_action = 0.0
        # Latest arm/relay snapshot for the exporter + /api/span/arm (in-memory; cheap).
        self.latest_arm: dict = {}
        # Latest relay/power of every allowlisted breaker circuit (span_control + /api/span/circuits
        # + the hub state frame). Refreshed every poll and after every breaker read-back.
        self.latest_circuits: dict[str, dict | None] = {}
        self.latest_circuits_ts: float | None = None
        self.latest_circuits_mono: float | None = None   # same read, monotonic (freshness checks)

    def start(self) -> None:
        if self.cfg and self.cfg.host and self.cfg.passphrase:
            self._task = asyncio.create_task(self._run(), name="span-local")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def poll_once(self) -> list[dict]:
        circuits = await self.client.fetch_circuits()
        rows = extract_powers(circuits, self.cfg.circuits)
        ts = time.time()
        self.note_circuits(circuits, ts)
        for r in rows:
            await self.store.add_span_sample(ts, r["circuit_id"], r["name"], r["power_w"])
        await self._evaluate_arm(circuits, ts)
        self._last_ok = ts
        if self._down_alerted:
            self._down_alerted = False
            if self.notify:
                await self.notify("SPAN local recovered", "Instant circuit power logging is back.", tier="attention", resolved=True)
        return rows

    def note_circuits(self, circuits: dict, ts: float, mono: float | None = None) -> None:
        """Cache the allowlisted breakers' relay/power from a fresh /circuits read."""
        self.latest_circuits = {b.name: extract_relay(circuits, b.name)
                                for b in getattr(self.cfg, "breakers", [])}
        self.latest_house_w = house_load_w(circuits)
        self.latest_circuits_ts = ts
        self.latest_circuits_mono = time.monotonic() if mono is None else mono

    async def _evaluate_arm(self, circuits: dict, ts: float) -> None:
        """Backup-element ARM decision. Phase 1 = SHADOW (logs would-arm, toggles NOTHING).
        CLOSE-ONLY and DISARMED-by-default; never opens, never acts against the owner's intent."""
        name = getattr(self.cfg, "arm_circuit", None) or ""
        circ = extract_relay(circuits, name) if name else None
        armed = read_arm_intent(self.arm_state_path, bool(getattr(self.cfg, "arm", False)))
        live = bool(getattr(self.cfg, "arm_live", False))
        self.latest_arm = {
            "circuit": name, "circuit_id": circ["circuit_id"] if circ else None,
            "relay_state": circ["relay_state"] if circ else None,
            "controllable": circ["controllable"] if circ else None,
            "armed": armed, "live": live, "ts": ts,
        }
        if self.arm_state_path:  # persist for the exporter/portal (live relay + intent)
            try:
                lp = Path(self.arm_state_path).with_name("span-arm-latest.json")
                tmp = lp.with_suffix(".tmp")
                with open(tmp, "w") as f:
                    json.dump(self.latest_arm, f); f.flush(); os.fsync(f.fileno())
                os.replace(tmp, lp)
            except OSError:
                pass
        # Nothing to do unless ARMED and the element is currently OPEN (unavailable).
        if not circ or not circ["circuit_id"] or not armed or circ["relay_state"] != "OPEN":
            return
        # Anti-flap: at most one arm action per cooldown (a toggle war can't thrash the relay).
        if ts - self._last_arm_action < float(getattr(self.cfg, "arm_cooldown_s", 300.0)):
            return
        self._last_arm_action = ts
        if not live:  # SHADOW — record what we WOULD do; touch nothing on SPAN.
            await self.store.add_span_arm_event(
                ts, circ["circuit_id"], circ["relay_state"], armed, False, "would_arm",
                "armed + backup-element relay OPEN → WOULD close it to make the failsafe available (shadow)")
            log.info("span-arm SHADOW: would close '%s' (relay OPEN, armed)", name)
            return
        # LIVE (Phase 2): close-only.
        try:
            new = await self.client.set_relay(circ["circuit_id"], "CLOSED")
            await self.store.add_span_arm_event(
                ts, circ["circuit_id"], new, armed, True, "armed",
                f"closed backup-element relay → {new} (was OPEN)")
            if self.notify:
                await self.notify(
                    "A2W armed the backup element",
                    "Closed the SPAN backup-element relay — the element is now AVAILABLE (the HBX still "
                    "decides when it runs). Disarm in the a2w portal if you meant to keep it off.", "high", tier="attention",
                    action="Nothing, if it is cold enough to need the element. Otherwise disarm it in the A2W portal.")
        except Exception as e:  # noqa: BLE001 — an arm failure must never break the poller
            await self.store.add_span_arm_event(
                ts, circ["circuit_id"], circ["relay_state"], armed, True, "arm_failed", f"set_relay failed: {e}")
            log.warning("span-arm live close failed: %s", e)

    async def _run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except SpanAuthError as e:  # passphrase/proximity — a retry won't help; alert once
                log.warning("span local auth error: %s", e)
                await self._maybe_alert_down(str(e))
            except Exception as e:  # noqa: BLE001 — a SPAN outage must never break the bridge
                log.warning("span local poll failed: %s", e)
                await self._maybe_alert_down(str(e))
            await asyncio.sleep(self.cfg.poll_interval_s)

    async def _maybe_alert_down(self, detail: str) -> None:
        down_for = time.time() - self._last_ok if self._last_ok else float("inf")
        if down_for >= self.cfg.down_alert_after_s and not self._down_alerted:
            self._down_alerted = True
            if self.notify:
                hrs = down_for / 3600 if self._last_ok else 0
                await self.notify(
                    "SPAN local link down",
                    f"Instant circuit-power logging has been down "
                    f"{'>' + format(hrs, '.1f') + 'h' if self._last_ok else 'since startup'} "
                    f"({detail}). Hourly-cloud energy is unaffected. Until it is back A2W cannot switch the "
                    f"Air-Water or backup breakers itself.", "high", tier="attention",
                    action="Check the SPAN panel is online in the SPAN app. If it asks, re-pair it with the Pi (door proximity button).")
