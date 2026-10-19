# @purpose: Self-heal (#189, owner decision 2026-10-18): when a heat pump sits in an equipment
# fault a breaker power cycle is known to clear (E21 by default) for >= grace (10 min), power-
# cycle its SPAN circuit through span_control.BreakerController (OFF >= 60 s, CLOSE in a
# finally), then verify recovery within 15 min. Runs on the Pi, so it works with the cloud down.
# Guards: never during defrost, never while the pump is heating, never if the other pump is also
# down (page instead), at most max_attempts per window per pump (then escalate to a human), one
# breaker action at a time (the controller's global lock). Default SHADOW: logs and pages what it
# WOULD do and touches nothing until the owner sets self_heal.live = true.
# Trigger scope: FAULT ONLY. The issue's second trigger ("stage N called, pump N not heating")
# needs the HBX stage call, which the Pi cannot see today — the HBX calls the pumps by dry contact,
# and the switch-word bit the poller logs as "remote_contact" was never verified to be that
# contact (a Phase 1 commissioning item). That trigger stays planner-side (#185) until it is.
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path

from . import notify
from .faults import Severity
from .span_control import BreakerRefused

log = logging.getLogger(__name__)

TICK_S = 30.0
FRESH_POLL_S = 90.0          # a snapshot older than this is not evidence of anything
RUNNING_QUIET_S = 120.0      # "not heating" = no compressor seen for this long (anti-short-cycle)
DEFROST_QUIET_S = 300.0      # and no defrost for this long
CLEAR_HOLD_S = 180.0         # a fault must stay cleared this long to count as recovered
STATE_FILE = "self-heal.json"
EVENT_TYPE = "self_heal"


class SelfHealer:
    def __init__(self, cfg, pollers: dict, breakers, store, *, notify_cfg=None,
                 state_dir: str | None = None, clock=time.time):
        self.cfg = cfg                  # SelfHealConfig
        self.pollers = pollers
        self.breakers = breakers        # span_control.BreakerController | None
        self.store = store
        self.notify_cfg = notify_cfg
        self._clock = clock
        self._path = Path(state_dir) / STATE_FILE if state_dir else None
        self._task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        persisted = self._load()
        self._pumps: dict[str, dict] = {}
        for pid in self.cfg.circuits:
            p = persisted.get(pid, {}) if isinstance(persisted.get(pid), dict) else {}
            self._pumps[pid] = {
                "attempts": [float(t) for t in p.get("attempts", []) if isinstance(t, (int, float))],
                "phase": "idle",            # idle | verifying
                "status": "starting",
                "verify": None,             # {cycle_at, until, shadow, code, cleared_since}
                "paged": set(),             # one page per episode per kind
                "last_running": None, "last_defrost": None,
                "last_outcome": p.get("last_outcome"),
            }

    # --- lifecycle ------------------------------------------------------------
    def start(self) -> None:
        if self.cfg.enabled and self.cfg.circuits:
            self._task = asyncio.create_task(self._run(), name="self-heal")

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
            except Exception:  # noqa: BLE001 — self-heal must never take the bridge down
                log.exception("self-heal tick failed")
            await asyncio.sleep(TICK_S)

    def status(self) -> dict:
        now = self._clock()
        window = self.cfg.window_h * 3600
        return {
            "enabled": self.cfg.enabled, "live": self.cfg.live,
            "mode": "off" if not self.cfg.enabled else "live" if self.cfg.live else "shadow",
            "trigger": {"fault_codes": list(self.cfg.fault_codes), "grace_min": self.cfg.grace_min,
                        "stage_call": "unavailable on the Pi (HBX stage call not visible) — fault trigger only"},
            "breaker_control": self.breakers is not None,
            "pumps": {pid: {"circuit": self.cfg.circuits[pid], "status": st["status"],
                            "phase": st["phase"],
                            "attempts_in_window": sum(1 for t in st["attempts"] if now - t < window),
                            "max_attempts": self.cfg.max_attempts,
                            "last_outcome": st["last_outcome"]}
                      for pid, st in self._pumps.items()},
        }

    # --- the decision -----------------------------------------------------------
    async def tick(self) -> None:
        now = self._clock()
        for pid, st in self._pumps.items():
            poller = self.pollers.get(pid)
            if poller is None:
                st["status"] = "pump not configured"
                continue
            snap = poller.snapshot
            fresh = bool(snap.get("online")) and snap.get("last_poll_ts") is not None \
                and now - float(snap["last_poll_ts"]) < FRESH_POLL_S
            if fresh and snap.get("running"):
                st["last_running"] = now
            if fresh and (snap.get("defrosting") or snap.get("state") == "defrost"):
                st["last_defrost"] = now
            if st["phase"] == "verifying":
                await self._verify(pid, poller, st, now, fresh)
                continue
            fault = self._target_fault(snap)
            if fault is None:
                st["paged"].clear()     # episode over: the next one pages afresh
                st["status"] = "no target fault"
                continue
            await self._consider(pid, poller, st, fault, now, fresh)

    def _target_fault(self, snap: dict) -> dict | None:
        codes = {c.upper() for c in self.cfg.fault_codes}
        hits = [f for f in snap.get("active_faults", []) if str(f.get("code", "")).upper() in codes]
        return min(hits, key=lambda f: f.get("since") or 0) if hits else None

    def _other_down(self, pid: str, now: float) -> str | None:
        for oid, other in self.pollers.items():
            if oid == pid:
                continue
            s = other.snapshot
            name = other.cfg.name
            if not s.get("online") or s.get("last_poll_ts") is None \
                    or now - float(s["last_poll_ts"]) >= FRESH_POLL_S:
                return f"{name} is offline"
            bad = [f for f in s.get("active_faults", []) if f.get("severity") != Severity.INFO
                   and f.get("severity") != "info"]
            if bad:
                return f"{name} is faulted ({', '.join(str(f.get('code')) for f in bad)})"
        if self.breakers is not None:
            for c in self.breakers.snapshot()["circuits"]:
                if c["heat_pump"] and c["name"] != self.cfg.circuits[pid] \
                        and c["relay_state"] not in ("CLOSED", None):
                    return f"{c['name']} is not ON at the panel"
        return None

    def _span_unknown(self) -> bool:
        """No fresh SPAN read yet (just booted, or the panel is unreachable)."""
        if self.breakers is None:
            return False
        snap = self.breakers.snapshot()
        return snap["ts"] is None or any(c["heat_pump"] and c["relay_state"] is None
                                         for c in snap["circuits"])

    async def _consider(self, pid, poller, st, fault, now, fresh) -> None:
        name, code = poller.cfg.name, fault.get("code")
        circuit = self.cfg.circuits[pid]
        age_min = (now - float(fault.get("since") or now)) / 60
        if not fresh:
            st["status"] = f"{code} active but {name} is offline/stale — waiting"
            return
        if age_min < self.cfg.grace_min:
            st["status"] = f"{code} active {age_min:.0f} min (< {self.cfg.grace_min:g} min grace)"
            return
        if snap_running(poller.snapshot) or (st["last_running"] is not None
                                             and now - st["last_running"] < RUNNING_QUIET_S):
            st["status"] = f"{code} active but {name} is heating — not cycling"
            return
        if poller.snapshot.get("defrosting") or poller.snapshot.get("state") == "defrost" or (
                st["last_defrost"] is not None and now - st["last_defrost"] < DEFROST_QUIET_S):
            st["status"] = f"{code} active but {name} is in/just out of defrost — waiting"
            return
        window = self.cfg.window_h * 3600
        st["attempts"] = [t for t in st["attempts"] if now - t < window]
        if len(st["attempts"]) >= self.cfg.max_attempts:
            st["status"] = (f"escalated: {code} persists after {len(st['attempts'])} power cycles "
                            f"in {self.cfg.window_h:g} h")
            if "escalated" not in st["paged"]:
                st["paged"].add("escalated")
                await self._step(pid, "escalated", "critical",
                                 f"{name}: {code} persists after {len(st['attempts'])} "
                                 f"{'(shadow) ' if not self.cfg.live else ''}power cycles in "
                                 f"{self.cfg.window_h:g} h — A2W stops trying. Needs a human: check "
                                 f"the unit, or power-cycle the '{circuit}' breaker at the SPAN panel.",
                                 {"code": code, "attempts": st["attempts"]},
                                 title=f"URGENT: {name} {code} not self-healing", priority="urgent")
            return
        if self.cfg.live and self._span_unknown():
            # Live needs the panel's view of both heat-pump circuits before switching anything.
            # (The controller re-reads the panel itself; this just avoids paging on a cold cache.)
            st["status"] = f"{code} active — waiting for a SPAN panel read"
            return
        other = self._other_down(pid, now)
        if other:
            st["status"] = f"{code} active but {other} — not cycling (paged)"
            if "both_down" not in st["paged"]:
                st["paged"].add("both_down")
                await self._step(pid, "both_down", "critical",
                                 f"{name}: {code} for {age_min:.0f} min AND {other}. A2W will not "
                                 f"power-cycle while the other pump is down — check both units; "
                                 f"'{circuit}' can be cycled at the SPAN panel by hand.",
                                 {"code": code, "other": other},
                                 title=f"URGENT: both heat pumps down", priority="urgent")
            return
        power = self._circuit_power(pid)
        if power is not None and power >= self.cfg.running_power_w:
            # The pump says it is not heating, yet its mapped circuit draws compressor-level
            # power: either self_heal.circuits is swapped (we'd cycle the HEALTHY pump) or the
            # readings disagree. Never act on that — ask a human.
            st["status"] = f"refusing: '{circuit}' draws {power:.0f} W while {name} reports idle"
            if "mapping" not in st["paged"]:
                st["paged"].add("mapping")
                await self._step(pid, "mapping_suspect", "critical",
                                 f"{name}: {code} {age_min:.0f} min, but '{circuit}' draws {power:.0f} W "
                                 f"while {name} reports no compressor running — the pump↔circuit "
                                 f"mapping (self_heal.circuits) may be wrong. Not cycling.",
                                 {"code": code, "circuit": circuit, "circuit_power_w": power},
                                 title=f"A2W self-heal: {name} mapping check failed", priority="high")
            return
        detail = {"code": code, "fault_age_min": round(age_min, 1), "circuit": circuit,
                  "off_s": self.cfg.off_s}
        if not self.cfg.live:
            st["attempts"].append(now)
            self._save()
            st["status"] = f"SHADOW: would power-cycle '{circuit}' ({code} {age_min:.0f} min)"
            await self._step(pid, "would_cycle", "warning",
                             f"{name}: {code} active {age_min:.0f} min, not heating — WOULD power-cycle "
                             f"'{circuit}' ({self.cfg.off_s:g} s off). Shadow mode: nothing switched.",
                             detail, title=f"A2W self-heal (shadow): would cycle {name}")
            st["phase"], st["verify"] = "verifying", {"cycle_at": now, "shadow": True, "code": code,
                                                      "until": now + self.cfg.verify_min * 60,
                                                      "cleared_since": None}
            return
        if self.breakers is None:
            st["status"] = "live, but SPAN breaker control is not configured"
            if "no_breakers" not in st["paged"]:
                st["paged"].add("no_breakers")
                await self._step(pid, "cycle_refused", "critical",
                                 f"{name}: {code} {age_min:.0f} min — self-heal is LIVE but SPAN local "
                                 f"control is not configured. Power-cycle '{circuit}' at the panel by hand.",
                                 detail, title=f"URGENT: {name} {code} — manual power cycle needed",
                                 priority="urgent")
            return
        if self.breakers.snapshot()["busy"]:
            st["status"] = "waiting: another breaker action is running"
            return
        st["attempts"].append(now)     # counted BEFORE acting: a crash mid-cycle still uses budget
        self._save()
        st["status"] = f"power-cycling '{circuit}'"
        await self._step(pid, "cycle_start", "warning",
                         f"{name}: {code} active {age_min:.0f} min, not heating — power-cycling "
                         f"'{circuit}' ({self.cfg.off_s:g} s off), attempt {len(st['attempts'])}/"
                         f"{self.cfg.max_attempts}.", detail,
                         title=f"A2W self-heal: power-cycling {name}")
        try:
            result = await self.breakers.execute(circuit, "power_cycle", off_s=self.cfg.off_s,
                                                 source="self-heal")
        except BreakerRefused as exc:
            if exc.status_code == 409 and "one at a time" in str(exc):
                st["attempts"].pop()      # someone else is switching: not an attempt
                self._save()
                st["status"] = "waiting: another breaker action is running"
                return
            st["status"] = f"cycle refused: {exc}"
            self._record_outcome(st, "refused", str(exc))
            await self._step(pid, "cycle_refused", "critical",
                             f"{name}: self-heal could not power-cycle '{circuit}': {exc}. Do it by "
                             f"hand: switch '{circuit}' OFF at the SPAN panel, wait a minute, switch it ON.",
                             {**detail, "reason": str(exc)},
                             title=f"URGENT: {name} {code} — manual power cycle needed", priority="urgent")
            return
        if not result.get("ok"):
            # The controller already paged a failed CLOSE (urgent, with the manual step).
            st["status"] = f"cycle failed: {result.get('detail')}"
            self._record_outcome(st, "cycle_failed", result.get("detail", ""))
            await self._step(pid, "cycle_failed", "critical",
                             f"{name}: power cycle of '{circuit}' did not complete cleanly: "
                             f"{result.get('detail')}.", {**detail, "result": result},
                             title=f"A2W self-heal: {name} power cycle failed", priority="high")
            return
        st["status"] = f"cycled; verifying recovery (≤ {self.cfg.verify_min:g} min)"
        st["phase"], st["verify"] = "verifying", {"cycle_at": self._clock(), "shadow": False,
                                                  "code": code, "cleared_since": None,
                                                  "until": self._clock() + self.cfg.verify_min * 60}

    async def _verify(self, pid, poller, st, now, fresh) -> None:
        v = st["verify"]
        name, code = poller.cfg.name, v["code"]
        snap = poller.snapshot
        active = any(str(f.get("code", "")).upper() == str(code).upper()
                     for f in snap.get("active_faults", []))
        if fresh and not active:
            v["cleared_since"] = v["cleared_since"] or now
        elif active:
            v["cleared_since"] = None
        power = self._circuit_power(pid)
        running = bool(snap.get("running"))
        consistent = (not running) or (power is not None and power >= self.cfg.running_power_w)
        recovered = (fresh and v["cleared_since"] is not None
                     and now - v["cleared_since"] >= CLEAR_HOLD_S and consistent)
        facts = {"code": code, "fault_active": active, "online": fresh, "running": running,
                 "circuit_power_w": power, "shadow": v["shadow"],
                 "minutes_since_cycle": round((now - v["cycle_at"]) / 60, 1)}
        if v["shadow"]:
            if recovered or now >= v["until"]:
                outcome = "cleared on its own" if recovered else "still active (nothing was switched)"
                self._record_outcome(st, "shadow_" + ("cleared" if recovered else "active"), outcome)
                await self._audit(pid, "shadow_verify", "info",
                                  f"{name}: shadow verification — {code} {outcome}", facts)
                st["phase"], st["verify"] = "idle", None
            else:
                st["status"] = "SHADOW: watching what a cycle would have had to fix"
            return
        if recovered:
            st["phase"], st["verify"] = "idle", None
            st["paged"].clear()
            self._record_outcome(st, "recovered", f"{code} cleared")
            st["status"] = "recovered"
            how = f"running, circuit {power:.0f} W" if running and power is not None else "idle, no call"
            await self._step(pid, "recovered", "info",
                             f"{name}: recovered after the power cycle — {code} cleared ({how}).",
                             facts, title=f"A2W self-heal: {name} recovered", priority="default")
            return
        if now >= v["until"]:
            st["phase"], st["verify"] = "idle", None
            why = (f"{code} still active" if active else "offline" if not fresh
                   else f"power inconsistent with running ({power} W)" if not consistent
                   else f"{code} not cleared for {CLEAR_HOLD_S / 60:g} min")
            self._record_outcome(st, "not_recovered", why)
            st["status"] = f"not recovered: {why}"
            await self._step(pid, "not_recovered", "critical",
                             f"{name}: NOT recovered {self.cfg.verify_min:g} min after the power cycle — "
                             f"{why}.", facts, title=f"A2W self-heal: {name} did not recover",
                             priority="high")
            return
        st["status"] = f"verifying recovery ({facts['minutes_since_cycle']} min since cycle)"

    def _circuit_power(self, pid: str) -> float | None:
        if self.breakers is None:
            return None
        for c in self.breakers.snapshot()["circuits"]:
            if c["name"] == self.cfg.circuits[pid]:
                return c["power_w"]
        return None

    # --- audit / alerts / persistence -----------------------------------------
    def _record_outcome(self, st, outcome: str, detail: str) -> None:
        st["last_outcome"] = {"outcome": outcome, "detail": detail, "ts": self._clock()}
        self._save()

    async def _audit(self, pid, code, severity, message, detail) -> None:
        try:
            await self.store.add_event(pid, EVENT_TYPE, code=code, severity=severity,
                                       message=message, detail=detail)
        except Exception as exc:  # noqa: BLE001
            log.warning("self-heal audit failed: %s", exc)

    async def _step(self, pid, code, severity, message, detail, *, title: str,
                    priority: str = "high") -> None:
        """Audit + push + email one step (owner: every self-heal step is visible)."""
        log.info("self-heal [%s] %s: %s", pid, code, message)
        await self._audit(pid, code, severity, message, detail)
        tags = "rotating_light" if priority == "urgent" else "wrench"
        for coro in (notify.ntfy(self.notify_cfg, title=title, message=message,
                                 priority=priority, tags=tags),
                     notify.email(self.notify_cfg, subject=title, body=message)):
            t = asyncio.create_task(coro)
            self._bg.add(t)
            t.add_done_callback(self._bg.discard)

    def _load(self) -> dict:
        if not self._path:
            return {}
        try:
            data = json.loads(self._path.read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        if not self._path:
            return
        data = {pid: {"attempts": st["attempts"], "last_outcome": st["last_outcome"]}
                for pid, st in self._pumps.items()}
        tmp = self._path.with_suffix(".tmp")
        try:  # atomic: the attempt budget must survive a power blip
            with open(tmp, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path)
        except OSError as exc:
            log.warning("self-heal state write failed: %s", exc)


def snap_running(snap: dict) -> bool:
    return bool(snap.get("running"))
