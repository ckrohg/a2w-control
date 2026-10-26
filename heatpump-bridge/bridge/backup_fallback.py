# @purpose The Pi-local fallback of the backup-element gate (owner rule 2026-10-19: "if a heat pump has failed or just
# totally cannot keep up, THEN we'd want it to kick on"). The planner's gate (planner/src/backupgate.ts) decides from
# the HBX tank and stage calls, which arrive through the SensorLinx cloud and reach the Pi through the hub; this one
# needs neither: when EVERY heat pump has been down continuously for hold_min (30 min), it CLOSES the "Buffer Tank"
# breaker so the HBX can fire the 16.5 kW element on its own backup call. It never opens anything (close-only by
# construction: it only calls BreakerController.execute(..., "close")).
# Per pump, one of: DOWN — a fresh snapshot with a blocking fault while not running, or Modbus-stale while a FRESH panel
# read shows no compressor draw on its circuit (a gateway outage with the pump still heating is NOT down — measured
# 2026-10-19: both gateways stale with SPAN reachable never lasted > 3.5 min in 97 d); OFF — switched off on purpose (on
# the unit, from 6bb, or its circuit OPEN at the panel — #212's deliberate stop), never a failure; UNKNOWN — stale with no fresh panel read, or no
# draw reading: a Pi Wi-Fi/LAN drop loses Modbus AND SPAN together, so it must never read as "every pump down" — any
# UNKNOWN pump resets the episode; UP — anything else.
# Default SHADOW: audit + EMAIL "would close" once per cooldown (never a phone push) and switch nothing until
# backup_fallback.live = true.
# Live, it acts regardless of the arm intent (going live IS the owner's opt-in for this one emergency case).
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from . import notify
from .config import BACKUP_ELEMENT_CIRCUIT
from .self_heal import _draw_w, _is_blocking

log = logging.getLogger(__name__)

TICK_S = 30.0
RETRY_S = 300.0              # a refused close is retried this often while every pump stays down
FRESH_POLL_S = 90.0          # a pump snapshot older than this is not evidence of anything
SPAN_FRESH_S = 120.0         # nor is a panel read older than this
EVENT_PUMP_ID = "span"
EVENT_TYPE = "backup_fallback"


class BackupFallback:
    def __init__(self, cfg, pollers: dict, breakers, store, *, notify_cfg=None, circuits: dict | None = None,
                 clock=time.time, mono=time.monotonic, stops=None):
        self.cfg = cfg                  # BackupFallbackConfig
        self.pollers = pollers
        self.breakers = breakers        # span_control.BreakerController | None
        self.store = store
        self.notify_cfg = notify_cfg
        # pump id -> SPAN circuit (self_heal.circuits; default Air-Water 1/2)
        self.circuits = circuits or {"pump1": "Air-Water 1", "pump2": "Air-Water 2"}
        self._clock = clock
        self._mono = mono
        self.stops = stops              # deliberate_stop.DeliberateStops | None: only words the reason (#212)
        self._task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        self._since: float | None = None          # monotonic: every pump down since
        self._since_wall: float | None = None
        self._next_ok: float | None = None        # monotonic: no decision before this (cooldown / retry)
        self._decided = False                     # one decision per all-down episode
        self._refusal_paged = False
        self.down: dict[str, str | None] = {}      # pump -> why it is DOWN (None: not down)
        self.pumps: dict[str, dict] = {}            # pump -> {state: down|off|unknown|up, why}
        self.last: dict | None = None

    # --- lifecycle --------------------------------------------------------------
    def start(self) -> None:
        if self.cfg.enabled and self.pollers:
            self._task = asyncio.create_task(self._run(), name="backup-fallback")

    async def stop(self) -> None:
        for t in [self._task, *self._bg]:
            if t:
                t.cancel()
        for t in [self._task, *self._bg]:
            if t:
                with contextlib.suppress(BaseException):
                    await t

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 — the fallback must never take the bridge down
                log.exception("backup fallback tick failed")
            await asyncio.sleep(TICK_S)

    def status(self) -> dict:
        held = None if self._since is None else round((self._mono() - self._since) / 60, 1)
        return {
            "enabled": self.cfg.enabled, "live": self.cfg.live,
            "mode": "off" if not self.cfg.enabled else "live" if self.cfg.live else "shadow",
            "hold_min": self.cfg.hold_min, "circuit": BACKUP_ELEMENT_CIRCUIT,
            "breaker_control": self.breakers is not None,
            "down": dict(self.down), "pumps": dict(self.pumps), "all_down_min": held,
            "all_down_since": self._since_wall,
            "relay": (self._backup() or {}).get("relay_state"),
            "last": self.last,
        }

    # --- inputs -----------------------------------------------------------------
    def _span(self) -> dict | None:
        """The controller's last panel read, if fresh (same rule as self-heal)."""
        if self.breakers is None:
            return None
        snap = self.breakers.snapshot()
        mono, ts = snap.get("mono"), snap.get("ts")
        if isinstance(mono, (int, float)):
            age = self._mono() - mono
        elif ts is not None:
            age = self._clock() - ts
        else:
            return None
        return snap if 0 <= age < SPAN_FRESH_S else None

    def _backup(self) -> dict | None:
        snap = self._span()
        return next((c for c in snap["circuits"] if c["name"] == BACKUP_ELEMENT_CIRCUIT), None) if snap else None

    def _fresh(self, snap: dict) -> bool:
        if not snap.get("online"):
            return False
        mono = snap.get("last_poll_mono")
        if isinstance(mono, (int, float)):
            age = self._mono() - float(mono)
        elif snap.get("last_poll_ts") is not None:
            age = self._clock() - float(snap["last_poll_ts"])
        else:
            return False
        return 0 <= age < FRESH_POLL_S

    def pump_state(self, pid: str, span: dict | None) -> tuple[str, str]:
        """(down | off | unknown | up, why) — see the header."""
        poller = self.pollers.get(pid)
        if poller is None:
            return "unknown", "has no telemetry on this bridge"
        circ = None
        if span is not None and self.circuits.get(pid):
            circ = next((c for c in span["circuits"] if c["name"] == self.circuits[pid]), None)
        if circ is not None and circ.get("relay_state") == "OPEN":
            why = self.stops.describe(pid) if self.stops is not None else None
            return "off", why or "is switched off at the panel (deliberate, or a self-heal power cycle)"
        s = poller.snapshot
        if self._fresh(s):
            if s.get("on") is False or s.get("state") == "off":
                return "off", "is switched off (deliberate)"
            bad = [str(f.get("code")) for f in s.get("active_faults", []) if _is_blocking(f)]
            if bad and not s.get("running"):
                return "down", f"is faulted ({', '.join(bad)})"
            return "up", "is up"
        # Modbus-stale: only a FRESH panel read can say whether the compressor still runs
        if circ is None:
            return "unknown", "is offline and there is no fresh panel read (Pi network?)"
        draw = _draw_w(circ.get("power_w"))
        if draw is None:
            return "unknown", "is offline and its circuit draw is unknown"
        if draw >= self.cfg.running_power_w:
            return "up", f"is offline but its circuit draws {draw:.0f} W (running)"
        return "down", f"is offline and its circuit draws {draw:.0f} W (not running)"

    # --- the decision -----------------------------------------------------------
    async def tick(self) -> None:
        if not self.cfg.enabled:
            return
        span = self._span()
        states = {pid: self.pump_state(pid, span) for pid in self.pollers}
        self.pumps = {pid: {"state": st, "why": why} for pid, (st, why) in states.items()}
        self.down = {pid: (why if st == "down" else None) for pid, (st, why) in states.items()}
        if not states or not all(st == "down" for st, _ in states.values()):
            if self._since is not None and self._decided:
                log.info("backup fallback: a heat pump is back — episode over")
            self._since = self._since_wall = None
            self._decided = False
            self._refusal_paged = False
            return
        now = self._mono()
        if self._since is None:
            self._since, self._since_wall = now, self._clock()
        held_min = (now - self._since) / 60
        if held_min < self.cfg.hold_min or self._decided:
            return
        if self._next_ok is not None and now < self._next_ok:
            return
        self._decided = True
        self._next_ok = now + self.cfg.cooldown_h * 3600
        why = "; ".join(f"{self.pollers[p].cfg.name if hasattr(self.pollers[p], 'cfg') else p} {d}"
                        for p, d in self.down.items())
        backup = self._backup()
        relay = (backup or {}).get("relay_state")
        if relay == "CLOSED":
            await self._decide("already_available", "info",
                               f"every heat pump down {held_min:.0f} min ({why}); the backup element breaker is "
                               "already ON — the HBX can fire the element.", relay, tier="record")
            return
        if not self.cfg.live:
            await self._decide("would_close", "high",
                               f"SHADOW — nothing was switched. Every heat pump has been down {held_min:.0f} min "
                               f"({why}). Live, A2W would close the '{BACKUP_ELEMENT_CIRCUIT}' breaker (now "
                               f"{relay or 'unknown'}) so the HBX can fire the 16.5 kW element. This runs on the Pi, "
                               "with no cloud.", relay,
                               title="Backup fallback (shadow): WOULD close the element breaker", tier="record")
            return
        if self.breakers is None:
            await self._decide("unavailable", "critical",
                               f"Every heat pump has been down {held_min:.0f} min ({why}) but this bridge has no "
                               f"breaker control. Switch the '{BACKUP_ELEMENT_CIRCUIT}' breaker ON at the SPAN panel.",
                               relay, title="URGENT: both heat pumps down — turn the element breaker ON",
                               priority="urgent", tier="page")
            return
        try:
            res = await self.breakers.execute(BACKUP_ELEMENT_CIRCUIT, "close", source="backup-fallback")
            ok = bool(res.get("ok"))
            await self._decide("closed" if ok else "close_unverified", "high" if ok else "critical",
                               f"Every heat pump has been down {held_min:.0f} min ({why}). A2W closed the "
                               f"'{BACKUP_ELEMENT_CIRCUIT}' breaker → {res.get('detail')}. The HBX can now fire the "
                               "element on its own backup call.", res.get("relay_state"),
                               title=("A2W closed the backup element breaker (both pumps down)" if ok
                                      else "URGENT: element breaker close NOT confirmed — both pumps down"),
                               priority="high" if ok else "urgent", tier="attention" if ok else "page")
        except Exception as exc:  # noqa: BLE001 — a refusal (BreakerRefused) or any error: retried, never latched
            # refused before anything was switched: retry in RETRY_S, page the first refusal of the episode
            self._decided = False
            self._next_ok = now + RETRY_S
            await self._decide("refused", "critical",
                               f"Every heat pump has been down {held_min:.0f} min ({why}) but closing the "
                               f"'{BACKUP_ELEMENT_CIRCUIT}' breaker was refused: {exc}. A2W retries every "
                               f"{RETRY_S / 60:g} min; switch it ON at the SPAN panel if you can.", relay,
                               title="URGENT: both heat pumps down — element breaker close refused",
                               priority="urgent", tier="record" if self._refusal_paged else "page")
            self._refusal_paged = True

    async def _decide(self, code: str, severity: str, message: str, relay, *, title: str | None = None,
                      priority: str = "high", tier: str) -> None:
        self.last = {"at": self._clock(), "outcome": code, "message": message, "relay_state": relay}
        log.warning("backup fallback %s: %s", code, message)
        try:
            await self.store.add_event(EVENT_PUMP_ID, EVENT_TYPE, code=code, severity=severity, message=message,
                                       detail={"down": dict(self.down), "relay_state": relay, "live": self.cfg.live})
        except Exception as exc:  # noqa: BLE001 — an audit failure never blocks the decision
            log.warning("backup fallback audit failed: %s", exc)
        # owner alert policy (alert-policy.md): shadow and already-on are record; A2W switching the element on
        # by itself is worth an email; both pumps down with the element still unavailable is a page
        task = asyncio.create_task(notify.alert(
            self.notify_cfg, tier=tier, title=title or "A2W backup fallback", message=message, priority=priority,
            tags="rotating_light" if priority == "urgent" else "fire", tag="a2w-pi-backup-fallback",
            action=("Switch the 'Buffer Tank' (backup element) breaker ON at the SPAN panel, then check both heat pumps."
                    if tier == "page" else "Nothing right now: the element is covering. Check why both heat pumps are down."
                    if tier == "attention" else None)))
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)
