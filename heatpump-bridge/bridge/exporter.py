# @purpose: Read-only analytics mirror push. Every ~60s the Pi POSTs a compact state
# snapshot to a Vercel app (analytics-mirror/) which stores the time series for a hosted
# dashboard. Deliberately OUT of the control loop: best-effort, no retries, failures
# swallowed — if the cloud is down, control and the local dashboard are unaffected. No new
# dependencies (urllib in a thread). The Pi only ever pushes OUT; it never receives
# commands from the cloud (control stays on the Funnel/API path).
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import urllib.request
from pathlib import Path

from .config import AnalyticsConfig
from .poller import PumpPoller
from .store import Store

log = logging.getLogger(__name__)


# Every ~60s push carries the compact row; every FULL_SNAPSHOT_EVERY_S one push also
# attaches each pump's ENTIRE cached snapshot (parameters 2010-2039, per-stage details,
# status/switch words, comm stats — exactly what /api/pumps/{id}/status serves). The
# mirror stores latest-only per pump; this feeds the Advanced view + the A-6 register
# baseline without a second transport.
FULL_SNAPSHOT_EVERY_S = 300

# Max events attached to a single push (matches store.get_events_since default). A backlog
# drains a batch per cycle; the cursor only advances on an HTTP 2xx so nothing is dropped.
EVENTS_BATCH = 200


class Exporter:
    def __init__(self, cfg: AnalyticsConfig, pollers: dict[str, PumpPoller],
                 store: Store, *, db_path: str):
        self.cfg = cfg
        self.pollers = pollers
        self.store = store
        self._task: asyncio.Task | None = None
        self._last_full = 0.0
        # Durable "max event id pushed" cursor — a small file next to the DB (same dir as
        # gateway-overrides.json) so events aren't re-shipped from id 0 after a restart.
        # The cloud dedups on (pump_id, source_id) anyway, but this keeps pushes small.
        self._cursor_path = Path(db_path).parent / "exporter-events-cursor"
        self._cursor = self._read_cursor(self._cursor_path)
        self._span_cursor_path = Path(db_path).parent / "exporter-span-cursor"
        self._span_cursor = self._read_cursor(self._span_cursor_path)
        self._span_arm_cursor_path = Path(db_path).parent / "exporter-span-arm-cursor"
        self._span_arm_cursor = self._read_cursor(self._span_arm_cursor_path)
        # backup-element ARM intent files (shared with span_local.py via the DB dir)
        self._arm_intent_path = Path(db_path).parent / "span-arm.json"
        self._arm_latest_path = Path(db_path).parent / "span-arm-latest.json"

    def _read_cursor(self, path: Path) -> int:
        try:
            return int(path.read_text().strip())
        except (OSError, ValueError):
            return 0

    def _write_cursor(self, path: Path, value: int) -> None:
        # atomic write (same discipline as config._write_state) — a half-written cursor at
        # this power-outage-prone site must not corrupt the resume point
        tmp = path.with_suffix(".tmp")
        try:
            with open(tmp, "w") as f:
                f.write(str(value))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except OSError as exc:  # noqa: BLE001 — cursor persistence must never break a push
            log.warning("cursor persist failed (%s): %s", path.name, exc)

    def start(self) -> None:
        if self.cfg.endpoint_url and self.cfg.token:
            self._task = asyncio.create_task(self._run(), name="exporter")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while True:
            try:
                await self.push_once()
            except Exception:  # noqa: BLE001 — a mirror push must never break the bridge
                log.exception("analytics push failed")
            await asyncio.sleep(self.cfg.interval_s)

    def snapshot(self) -> dict:
        """Compact per-pump state for the cloud time series — no control-relevant fields.
        Periodically attaches the full cached snapshot per pump (see FULL_SNAPSHOT_EVERY_S)."""
        include_full = time.time() - self._last_full >= FULL_SNAPSHOT_EVERY_S
        pumps = []
        for p in self.pollers.values():
            s = p.snapshot
            entry = {
                "id": p.cfg.id,
                "name": p.cfg.name,
                "online": bool(s.get("online")),
                "state": s.get("state", "offline"),
                "mode_kind": s.get("mode_kind"),
                "setpoint_c": s.get("setpoint_c"),
                "inlet_c": s.get("inlet_c"),
                "outlet_c": s.get("outlet_c"),
                "ambient_c": s.get("ambient_c"),
                "power_w": (s.get("power_sys1") or 0) + (s.get("power_sys2") or 0),
                "active_faults": len(s.get("active_faults", [])),
                "error_rate": p.client.stats.as_dict()["error_rate"],
            }
            if include_full:
                entry["full"] = dict(s)  # the whole cached snapshot; JSON-safe (the API serves it)
            pumps.append(entry)
        if include_full:
            self._last_full = time.time()
        return {"ts": time.time(), "pumps": pumps}

    async def push_once(self) -> None:
        if not (self.cfg.endpoint_url and self.cfg.token):
            return
        body = self.snapshot()

        # New local events since the last successfully-pushed id. source_id = the Pi's own
        # event id (the cloud dedups on (pump_id, source_id)); cursor advances only on 2xx.
        max_id = 0
        try:
            new_events = await self.store.get_events_since(self._cursor, EVENTS_BATCH)
        except Exception as exc:  # noqa: BLE001 — never block/break the push on a read error
            log.warning("event read for export failed: %s", exc)
            new_events = []
        if new_events:
            body["events"] = [
                {"pump_id": e["pump_id"], "source_id": e["id"], "ts": e["ts"],
                 "type": e["type"], "code": e["code"], "severity": e["severity"],
                 "message": e["message"], "detail": e["detail"]}
                for e in new_events
            ]
            max_id = max(e["id"] for e in new_events)

        # New SPAN circuit-power samples since the last pushed id (cloud dedups on source_id).
        span_max = 0
        try:
            new_span = await self.store.get_span_since(self._span_cursor, 500)
        except Exception as exc:  # noqa: BLE001 — a span read error must never block the push
            log.warning("span read for export failed: %s", exc)
            new_span = []
        if new_span:
            body["span"] = [
                {"source_id": s["id"], "ts": s["ts"], "circuit_id": s["circuit_id"],
                 "name": s["name"], "power_w": s["power_w"]}
                for s in new_span
            ]
            span_max = max(s["id"] for s in new_span)

        # backup-element ARM: shadow/live decision events + current live snapshot (spec Phase 1).
        arm_max = 0
        try:
            new_arm = await self.store.get_span_arm_since(self._span_arm_cursor, 200)
        except Exception as exc:  # noqa: BLE001
            log.warning("span-arm read for export failed: %s", exc)
            new_arm = []
        if new_arm:
            body["span_arm_events"] = [
                {"source_id": e["id"], "ts": e["ts"], "circuit_id": e["circuit_id"],
                 "relay_state": e["relay_state"], "armed": bool(e["armed"]), "live": bool(e["live"]),
                 "action": e["action"], "detail": e["detail"]}
                for e in new_arm]
            arm_max = max(e["id"] for e in new_arm)
        try:  # current relay+intent snapshot for the portal card
            body["span_arm"] = json.loads(self._arm_latest_path.read_text())
        except (OSError, ValueError):
            pass

        payload = json.dumps(body).encode("utf-8")
        url, token = self.cfg.endpoint_url, self.cfg.token

        def _post():
            try:
                req = urllib.request.Request(
                    url, data=payload, method="POST",
                    headers={"Content-Type": "application/json",
                             "Authorization": f"Bearer {token}"})
                raw = urllib.request.urlopen(req, timeout=10).read()
                try:
                    return True, json.loads(raw or b"null")
                except Exception:  # noqa: BLE001
                    return True, None
            except Exception as exc:  # noqa: BLE001
                log.warning("analytics push failed: %s", exc)
                return False, None

        ok, resp = await asyncio.to_thread(_post)
        if ok and max_id > self._cursor:
            self._cursor = max_id
            self._write_cursor(self._cursor_path, max_id)
        if ok and span_max > self._span_cursor:
            self._span_cursor = span_max
            self._write_cursor(self._span_cursor_path, span_max)
        if ok and arm_max > self._span_arm_cursor:
            self._span_arm_cursor = arm_max
            self._write_cursor(self._span_arm_cursor_path, arm_max)
        # Apply the owner's desired ARM intent echoed back by the ingest (portal → Neon → here).
        # Safe on the analytics path: arm is CLOSE-ONLY, so a bad value can only make the failsafe
        # AVAILABLE, never disable it — and DISARM persists locally regardless (span-arm.json).
        if ok and isinstance(resp, dict) and isinstance(resp.get("span_arm_desired"), bool):
            self._apply_arm_intent(resp["span_arm_desired"])

    def _apply_arm_intent(self, armed: bool) -> None:
        try:
            try:
                cur = bool(json.loads(self._arm_intent_path.read_text()).get("armed"))
            except (OSError, ValueError):
                cur = None
            if cur == armed:
                return
            tmp = self._arm_intent_path.with_suffix(".tmp")
            with open(tmp, "w") as f:
                json.dump({"armed": bool(armed)}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._arm_intent_path)
            log.info("span-arm intent updated from portal: armed=%s", armed)
        except OSError as exc:  # noqa: BLE001
            log.warning("span-arm intent apply failed: %s", exc)
