# @purpose #212 (owner decision 2026-10-19): the 6bb app and the SPAN app can switch the Air-Water 1/2 breakers
# independently of A2W, and the panel reports the relay requester as USER for both, so A2W cannot see WHO switched.
# What it can see is its OWN breaker actions: A2W only ever leaves a heat-pump circuit OPEN inside a power cycle it is
# running (or a failed re-close it keeps retrying), and span_control.BreakerController knows both. So a heat-pump
# circuit that a FRESH panel read shows OPEN, with no A2W action on it in progress or in the last ATTRIBUTION_S, is a
# DELIBERATE STOP by a person, not a failure (measured 2026-10-19: with Air-Water 2 open its pump's Modbus times out,
# i.e. the pump simply reads "offline"):
#   - one email once it has stayed off CONFIRM_S ("Air-Water 2 was switched off outside A2W at 3:12 PM"), then quiet
#     until it is back (a record-only note). A 6bb power cycle (>= 60 s off, then on) is only an event;
#   - self-heal never acts on that pump; the OTHER pump's guards still count it as down, so the one pump left is never
#     power-cycled; the poller's offline escalation stands down for it;
#   - the hub state frame carries it per pump (`deliberate_stop`), so the planner's stage watch, "no heat" check and
#     pump health don't page it as a fault, and the planner sends the one reminder when it is still off hours later
#     while the HBX calls its stage (the Pi cannot see the HBX call).
# A stale panel read changes nothing: the last verdict holds, so a Pi network drop neither starts nor ends a stop.
# But a held verdict is only IN FORCE (what stopped() reports to the guards, the poller and the planner) while it is
# backed by a panel read at most VERDICT_MAX_AGE_S old, and while the pump itself is silent: a switched-off pump cannot
# answer Modbus (measured 2026-10-19), so a fresh online poll means the breaker is back on whatever the last read said.
# Both fail LOUD — without them a dead SPAN stream would keep a pump that failed after being switched back on
# "deliberately stopped" for ever, silencing its offline escalation, self-heal and the planner's stage episodes.
# since/announced are persisted next to the DB, so a bridge restart never re-announces a stop.
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path

from . import notify

log = logging.getLogger(__name__)

TICK_S = 30.0
SPAN_FRESH_S = 120.0       # a panel read older than this is not evidence (self-heal's rule)
ATTRIBUTION_S = 10 * 60.0  # an OPEN this soon after A2W switched the circuit is A2W's (panel/read-back lag margin)
CONFIRM_S = 3 * 60.0       # off this long before the email: a 6bb power cycle (60 s min) never announces itself
VERDICT_MAX_AGE_S = 10 * 60.0  # a held stop older than its last fresh panel read by this is no longer in force
FRESH_POLL_S = 90.0        # a pump snapshot this fresh and online is a pump with power (self-heal's freshness rule)
STATE_FILE = "deliberate-stops.json"
EVENT_PUMP_ID = "span"     # events.pump_id for breaker-related rows (mirrored like pump events)
EVENT_TYPE = "deliberate_stop"


def _hhmm(ts: float) -> str:
    return time.strftime("%-I:%M %p", time.localtime(ts))


class DeliberateStops:
    def __init__(self, breakers, circuits: dict[str, str], pollers: dict, store, *, notify_cfg=None,
                 state_dir: str | None = None, clock=time.time, mono=time.monotonic):
        self.breakers = breakers        # span_control.BreakerController
        self.circuits = dict(circuits)  # pump id -> SPAN circuit name (self_heal.circuits)
        self.pollers = pollers
        self.store = store
        self.notify_cfg = notify_cfg
        self._clock = clock
        self._mono = mono
        self._path = Path(state_dir) / STATE_FILE if state_dir else None
        # pump id -> {"since": wall, "announced": bool}; "seen" (monotonic, in-process) times the confirmation
        self._stops: dict[str, dict] = self._load()
        for st in self._stops.values():
            st["seen"] = self._mono()   # across a restart the confirmation restarts (announced stays announced)
        self._events: list[tuple] = []  # transitions observed synchronously, flushed (audit + notify) by tick()
        self._read_mono: float | None = None   # when the last FRESH panel read was taken (monotonic)
        self._task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()

    # --- lifecycle --------------------------------------------------------------
    def start(self) -> None:
        if self.breakers is not None and self.circuits:
            self._task = asyncio.create_task(self._run(), name="deliberate-stops")

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
            except Exception:  # noqa: BLE001 — never take the bridge down
                log.exception("deliberate-stop tick failed")
            await asyncio.sleep(TICK_S)

    # --- what the rest of the bridge asks ---------------------------------------
    def stopped(self, pid: str) -> dict | None:
        """{"circuit", "since", "announced"} while `pid`'s circuit is deliberately OFF, else None. Re-judged on the
        controller's current panel read, so a guard asking right before acting never sees a 30-s-old verdict."""
        self._observe()
        st = self._stops.get(pid)
        if st is None or not self._in_force(pid):
            return None
        return {"circuit": self.circuits[pid], "since": st["since"], "announced": bool(st.get("announced"))}

    def _in_force(self, pid: str) -> bool:
        """A held stop counts only while a recent panel read backs it and the pump is silent (header)."""
        if self._read_mono is None or self._mono() - self._read_mono > VERDICT_MAX_AGE_S:
            return False
        snap = getattr(self.pollers.get(pid), "snapshot", None) or {}
        mono = snap.get("last_poll_mono")
        answers = (snap.get("online") is True and isinstance(mono, (int, float))
                   and 0 <= self._mono() - float(mono) < FRESH_POLL_S)
        return not answers

    def describe(self, pid: str) -> str | None:
        """'was switched off outside A2W at 3:12 PM' — for the other modules' reasons; None when not stopped."""
        s = self.stopped(pid)
        return None if s is None else f"was switched off outside A2W at {_hhmm(s['since'])} ('{s['circuit']}' OFF)"

    def status(self) -> dict:
        self._observe()
        return {"attribution_min": ATTRIBUTION_S / 60, "confirm_min": CONFIRM_S / 60,
                "pumps": {pid: ({"circuit": c, "since": self._stops[pid]["since"],
                                 "announced": bool(self._stops[pid].get("announced")),
                                 "in_force": self._in_force(pid)}
                                if pid in self._stops else None)
                          for pid, c in self.circuits.items()}}

    # --- the judgement ------------------------------------------------------------
    def _fresh_relays(self) -> dict[str, str | None] | None:
        """circuit name -> relay state from the controller's last panel read, or None when that read is not fresh."""
        snap = self.breakers.snapshot()
        mono, ts = snap.get("mono"), snap.get("ts")
        if isinstance(mono, (int, float)):
            age = self._mono() - mono
        elif ts is not None:
            age = self._clock() - ts
        else:
            return None
        if not (0 <= age < SPAN_FRESH_S):
            return None
        return {c["name"]: c.get("relay_state") for c in snap["circuits"] if c.get("found")}

    def _observe(self) -> None:
        if self.breakers is None:
            return
        relays = self._fresh_relays()
        if relays is None:
            return                       # no fresh evidence: the last verdict holds
        self._read_mono = self._mono()
        changed = False
        for pid, circuit in self.circuits.items():
            relay = relays.get(circuit)
            own = self.breakers.own_switching(circuit, ATTRIBUTION_S)
            st = self._stops.get(pid)
            if relay == "OPEN" and own is None:
                if st is None:
                    self._stops[pid] = {"since": self._clock(), "announced": False, "seen": self._mono()}
                    self._events.append(("began", pid, dict(self._stops[pid])))
                    changed = True
            elif st is not None and relay == "CLOSED":
                del self._stops[pid]
                self._events.append(("ended", pid, st))
                changed = True
            # OPEN but A2W's own (a power cycle, a re-close it keeps retrying), or no relay reading: nothing changes
        if changed:
            self._save()

    async def tick(self) -> None:
        self._observe()
        now = self._mono()
        for pid, st in self._stops.items():
            if not st.get("announced") and now - st["seen"] >= CONFIRM_S and self._in_force(pid):
                st["announced"] = True
                self._save()
                self._events.append(("announced", pid, dict(st)))
        events, self._events = self._events, []
        for kind, pid, st in events:
            await self._report(kind, pid, st)

    async def _report(self, kind: str, pid: str, st: dict) -> None:
        circuit = self.circuits[pid]
        pump = self.pollers[pid].cfg.name if pid in self.pollers else pid
        at = _hhmm(st["since"])
        off_min = (self._clock() - st["since"]) / 60
        if kind == "began":
            await self._audit(pid, "began", "info",
                              f"{circuit} ({pump}) is OFF at the panel and A2W did not switch it — treated as a "
                              f"deliberate stop: self-heal stands down for it and it is not paged as a fault.")
            return
        if kind == "announced":
            msg = (f"The '{circuit}' breaker ({pump}) is OFF at the SPAN panel and A2W did not switch it (6bb app, "
                   f"SPAN app or the panel itself). A2W treats it as a deliberate stop: self-heal won't touch "
                   f"{pump}, and it is not reported as a fault. You'll hear once more only if it is still off hours "
                   f"from now while the HBX is calling for it.")
            await self._audit(pid, "announced", "info", msg)
            self._alert(pid, f"{circuit} was switched off outside A2W at {at}", msg, tier="attention",
                        action=f"Nothing, if you meant it. Otherwise switch '{circuit}' back ON (6bb app, SPAN app, "
                               f"or the breaker in the panel).",
                        facts=[("Circuit", circuit), ("Pump", pump), ("Off since", at)])
            return
        # ended
        dur = f"{off_min / 60:.1f} h" if off_min >= 90 else f"{off_min:.0f} min"
        msg = f"'{circuit}' ({pump}) is back ON at the panel after {dur} off (switched off outside A2W at {at})."
        await self._audit(pid, "ended", "info", msg)
        if st.get("announced"):
            # the all-clear of an attention alert: record-only by the owner policy (notify.route)
            self._alert(pid, f"{circuit} is back on", msg, tier="attention", resolved=True)

    async def _audit(self, pid: str, code: str, severity: str, message: str) -> None:
        log.info("deliberate stop [%s] %s: %s", pid, code, message)
        try:
            await self.store.add_event(EVENT_PUMP_ID, EVENT_TYPE, code=code, severity=severity, message=message,
                                       detail={"pump": pid, "circuit": self.circuits[pid]})
        except Exception as exc:  # noqa: BLE001
            log.warning("deliberate-stop audit failed: %s", exc)

    def _alert(self, pid: str, title: str, message: str, *, tier: str, resolved: bool = False, action: str | None = None,
               facts: list[tuple[str, str]] | None = None) -> None:
        t = asyncio.create_task(notify.alert(self.notify_cfg, tier=tier, title=title, message=message,
                                             priority="default", tags="electric_plug", resolved=resolved,
                                             tag=f"a2w-pi-deliberate-stop-{pid}", action=action,
                                             facts=facts))
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # --- persistence --------------------------------------------------------------
    def _load(self) -> dict[str, dict]:
        if not self._path:
            return {}
        try:
            data = json.loads(self._path.read_bytes())
            out = {}
            for pid, st in (data.get("stops") or {}).items():
                if pid in self.circuits and isinstance(st, dict) and isinstance(st.get("since"), (int, float)):
                    out[pid] = {"since": float(st["since"]), "announced": bool(st.get("announced"))}
            return out
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, AttributeError) as exc:
            # unknown history: start clean. Worst case a stop still in force is announced a second time.
            log.warning("deliberate-stop state unreadable (%s) — starting clean", exc)
            return {}

    def _save(self) -> None:
        if not self._path:
            return
        data = {"v": 1, "stops": {pid: {"since": st["since"], "announced": bool(st.get("announced"))}
                                  for pid, st in self._stops.items()}}
        tmp = self._path.with_suffix(".tmp")
        try:
            with open(tmp, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path)
        except OSError as exc:
            log.warning("deliberate-stop state write failed: %s", exc)
