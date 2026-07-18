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
from __future__ import annotations

import asyncio
import json
import logging
import os
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

    async def fetch_circuits(self) -> dict:
        return await asyncio.to_thread(self._fetch_sync)


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


class SpanLocalPoller:
    """Polls the configured circuits' instantPowerW every ~interval and persists each to the
    store. Never raises into the event loop; tracks last-success for a down-alert."""

    def __init__(self, cfg, store, *, notify=None):
        self.cfg = cfg
        self.store = store
        self.notify = notify
        self.client = SpanClient(cfg.host, cfg.passphrase, ip_fallback=cfg.ip_fallback,
                                 token=cfg.token)
        self._task: asyncio.Task | None = None
        self._last_ok = 0.0
        self._down_alerted = False

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
        for r in rows:
            await self.store.add_span_sample(ts, r["circuit_id"], r["name"], r["power_w"])
        self._last_ok = ts
        if self._down_alerted:
            self._down_alerted = False
            if self.notify:
                await self.notify("SPAN local recovered", "Instant circuit power logging is back.")
        return rows

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
                    f"({detail}). Hourly-cloud energy is unaffected.", "high")
