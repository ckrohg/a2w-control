# @purpose: Self-heal (#189, owner decision 2026-10-18): when a heat pump sits in an equipment
# fault a breaker power cycle is known to clear (E21 by default) for >= grace (10 min), power-
# cycle its SPAN circuit through span_control.BreakerController (OFF >= 60 s, CLOSE in a
# finally), then verify recovery within 15 min. Runs on the Pi, so it works with the cloud down.
# Guards: never during defrost, never while the pump is heating, never if the other pump is also
# down (page instead), never on a pump whose gateway identity check failed, at most max_attempts
# per window per pump (then escalate to a human), one breaker action at a time (the controller's
# global lock), and every guard is re-checked on the fresh panel read immediately before the OPEN
# (BreakerController precheck). Default SHADOW: logs and pages what it WOULD do and touches
# nothing until the owner sets self_heal.live = true.
# Trigger scope: FAULT ONLY. The issue's second trigger ("stage N called, pump N not heating")
# needs the HBX stage call, which the Pi cannot see today — the HBX calls the pumps by dry contact,
# and the switch-word bit the poller logs as "remote_contact" was never verified to be that
# contact (a Phase 1 commissioning item). That trigger stays planner-side (#185) until it is.
# Time: in-process holds use the monotonic clock; the attempt budget is persisted with wall time
# + boot id + monotonic time, so a clock step can neither expire attempts early nor (within a
# boot) shorten a hold. Persisted history that can't be read counts as a spent budget.
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import time
from pathlib import Path

from . import notify
from .span_control import BreakerRefused, read_boot_id

log = logging.getLogger(__name__)

TICK_S = 30.0
FRESH_POLL_S = 90.0          # a pump snapshot older than this is not evidence of anything
SPAN_FRESH_S = 120.0         # nor is a SPAN panel read older than this
SPAN_WAIT_PAGE_S = 600.0     # live, eligible, but no usable panel read for this long -> page
RUNNING_QUIET_S = 120.0      # "not heating" = no compressor seen for this long (anti-short-cycle)
DEFROST_QUIET_S = 300.0      # and no defrost for this long
CLEAR_HOLD_S = 180.0         # recovered = no blocking fault, observed fresh, continuously this long
ALL_DOWN_PAGE_S = 300.0      # every pump down this long (debounces a bridge restart) -> page
OBS_GAP_S = 90.0             # verification ticks further apart than this break the continuity
STATE_FILE = "self-heal.json"
EVENT_TYPE = "self_heal"


def _is_blocking(f: dict) -> bool:
    # Real snapshots carry faults.Severity members (str-mixin Enum: str() is "Severity.INFO", so
    # compare the VALUE). P17 anti-freeze etc. are INFO and never count.
    sev = f.get("severity", "")
    return str(getattr(sev, "value", sev)).lower() != "info"


class SelfHealer:
    def __init__(self, cfg, pollers: dict, breakers, store, *, notify_cfg=None, span_cfg=None,
                 state_dir: str | None = None, clock=time.time, mono=time.monotonic,
                 boot_id: str | None = None):
        self.cfg = cfg                  # SelfHealConfig
        self.pollers = pollers
        self.breakers = breakers        # span_control.BreakerController | None
        self.store = store
        self.notify_cfg = notify_cfg
        self.span_cfg = span_cfg if span_cfg is not None else getattr(breakers, "cfg", None)
        self._clock = clock
        self._mono = mono
        self._boot_id = boot_id if boot_id is not None else read_boot_id()
        self._path = Path(state_dir) / STATE_FILE if state_dir else None
        self._task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        self.config_errors = self._check_config()
        persisted, self.history_problem = self._load()
        self._pumps: dict[str, dict] = {}
        for pid in self.cfg.circuits:
            p = persisted.get(pid, {})
            attempts = list(p.get("attempts", []))
            if self.history_problem:
                # Unknown history = assume the budget is spent for one window (fails closed,
                # and clears itself: the next save rewrites a valid file).
                attempts = [self._stamp() for _ in range(self.cfg.max_attempts)]
            self._pumps[pid] = {
                "attempts": attempts,
                "phase": "idle",            # idle | verifying
                "status": "starting",
                "verify": None,
                "paged": set(),             # one page per episode per kind
                "last_running": None, "last_defrost": None,   # monotonic
                "fault_seen": None,         # (code, monotonic first seen) for the grace
                "span_wait": None,          # monotonic: since when live waits for a panel read
                "last_outcome": p.get("last_outcome"),
            }
            pending = p.get("verify")
            if isinstance(pending, dict) and isinstance(pending.get("code"), str):
                # A cycle (or shadow decision) was in flight when the bridge stopped: verify
                # again from now, with a full window — never silently forget it.
                self._begin_verify(self._pumps[pid], pending["code"], shadow=bool(pending.get("shadow")))
                self._pumps[pid]["verify"]["restored"] = True
                self._pumps[pid]["status"] = "verifying (restored after a restart)"
        self._startup_paged = False
        self._both_down_paged = False          # one both-down page until a pump is back up
        self._all_down_since: float | None = None

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
        return {
            "enabled": self.cfg.enabled, "live": self.cfg.live,
            "mode": "off" if not self.cfg.enabled else "live" if self.cfg.live else "shadow",
            "trigger": {"fault_codes": list(self.cfg.fault_codes), "grace_min": self.cfg.grace_min,
                        "stage_call": "unavailable on the Pi (HBX stage call not visible) — fault trigger only"},
            "breaker_control": self.breakers is not None,
            "history_problem": self.history_problem,
            "pumps": {pid: {"circuit": self.cfg.circuits[pid], "status": st["status"],
                            "phase": st["phase"],
                            "unavailable": self.config_errors.get(pid),
                            "attempts_in_window": len(self._recent(st)),
                            "max_attempts": self.cfg.max_attempts,
                            "last_outcome": st["last_outcome"]}
                      for pid, st in self._pumps.items()},
        }

    # --- config / time helpers -------------------------------------------------
    def _check_config(self) -> dict[str, str]:
        """Problems that make a pump ineligible — reported, never a boot failure."""
        errs: dict[str, str] = {}
        span = self.span_cfg
        if span is None:
            return errs
        by_name = {b.name.strip(): b for b in span.breakers}
        names = [c.strip() for c in self.cfg.circuits.values()]
        for pid, circuit in self.cfg.circuits.items():
            if names.count(circuit.strip()) > 1:
                errs[pid] = f"'{circuit.strip()}' is mapped to more than one pump"
                continue
            b = by_name.get(circuit.strip())
            if b is None or not (b.allow_cycle and b.heat_pump):
                errs[pid] = f"'{circuit}' is not an allow_cycle heat-pump circuit in span.breakers"
            elif not (span.min_off_s <= self.cfg.off_s <= span.max_off_s):
                errs[pid] = (f"self_heal.off_s {self.cfg.off_s:g} is outside "
                             f"[{span.min_off_s:g}, {span.max_off_s:g}]")
        return errs

    def _stamp(self) -> dict:
        return {"wall": self._clock(), "mono": self._mono(), "boot": self._boot_id}

    def _age(self, a: dict) -> float:
        if isinstance(a.get("mono"), (int, float)) and (a.get("boot") == self._boot_id):
            return self._mono() - a["mono"]        # this boot (or rebased into it): no wall steps
        return self._clock() - float(a["wall"])     # future-dated (negative) still counts as recent

    def _recent(self, st: dict) -> list[dict]:
        window = self.cfg.window_h * 3600
        return [a for a in st["attempts"] if self._age(a) < window]

    def _fresh(self, snap: dict) -> bool:
        """Fresh by the MONOTONIC poll stamp (wall-clock steps can't revive old data); a snapshot
        without one (older poller) falls back to the wall stamp."""
        if not snap.get("online"):
            return False
        mono = snap.get("last_poll_mono")
        if isinstance(mono, (int, float)):
            age = self._mono() - float(mono)
        elif snap.get("last_poll_ts") is not None:
            age = self._clock() - float(snap["last_poll_ts"])
        else:
            return False
        return 0 <= age < FRESH_POLL_S             # a future-dated poll is not fresh either

    def _span(self) -> dict | None:
        """The controller's last panel read, if it is fresh; else None."""
        if self.breakers is None:
            return None
        snap = self.breakers.snapshot()
        ts = snap.get("ts")
        if ts is None or not (0 <= self._clock() - ts < SPAN_FRESH_S):
            return None
        if any(c["heat_pump"] and c["relay_state"] is None for c in snap["circuits"]):
            return None
        return snap

    def _circuit_power(self, pid: str) -> float | None:
        snap = self._span()
        if snap is None:
            return None
        for c in snap["circuits"]:
            if c["name"] == self.cfg.circuits[pid]:
                return c["power_w"]
        return None

    def _target_fault(self, snap: dict) -> dict | None:
        codes = {c.upper() for c in self.cfg.fault_codes}
        hits = [f for f in snap.get("active_faults", []) if str(f.get("code", "")).upper() in codes]
        return min(hits, key=lambda f: f.get("since") or 0) if hits else None

    def _other_down(self, pid: str, *, span: dict | None) -> str | None:
        for oid in self.cfg.circuits:     # every pump self-heal knows about must be visible
            if oid != pid and oid not in self.pollers:
                return f"{oid} has no telemetry on this bridge"
        for oid, other in self.pollers.items():
            if oid == pid:
                continue
            s, name = other.snapshot, other.cfg.name
            if not self._fresh(s):
                return f"{name} is offline"
            if s.get("identity_ok") is False:
                return f"{name}'s gateway identity check failed"
            if s.get("on") is False or s.get("state") == "off":
                return f"{name} is switched off"
            bad = [f for f in s.get("active_faults", []) if _is_blocking(f)]
            if bad:
                return f"{name} is faulted ({', '.join(str(f.get('code')) for f in bad)})"
        if span is not None:
            for c in span["circuits"]:
                if c["heat_pump"] and c["name"] != self.cfg.circuits[pid] and c["relay_state"] != "CLOSED":
                    return f"{c['name']} is not ON at the panel"
        return None

    def _heating_or_defrost(self, snap: dict, st: dict) -> str | None:
        now = self._mono()
        if snap.get("running") or (st["last_running"] is not None
                                   and now - st["last_running"] < RUNNING_QUIET_S):
            return "is heating (or just stopped)"
        if snap.get("defrosting") or snap.get("state") == "defrost" or (
                st["last_defrost"] is not None and now - st["last_defrost"] < DEFROST_QUIET_S):
            return "is in (or just out of) defrost"
        return None

    # --- the decision -----------------------------------------------------------
    async def tick(self) -> None:
        if not self._startup_paged:
            self._startup_paged = True
            await self._startup_notes()
        await self._watch_all_down()
        pruned = False
        for st in self._pumps.values():
            recent = self._recent(st)
            if len(recent) != len(st["attempts"]):
                st["attempts"], pruned = recent, True
        if pruned:
            self._save()
        for pid, st in self._pumps.items():
            if pid in self.config_errors:
                st["status"] = f"unavailable: {self.config_errors[pid]}"
                continue
            poller = self.pollers.get(pid)
            if poller is None:
                st["status"] = "pump not configured"
                continue
            snap = poller.snapshot
            fresh = self._fresh(snap)
            if fresh and snap.get("running"):
                st["last_running"] = self._mono()
            if fresh and (snap.get("defrosting") or snap.get("state") == "defrost"):
                st["last_defrost"] = self._mono()
            if st["phase"] == "verifying":
                await self._verify(pid, poller, st, fresh)
                continue
            fault = self._target_fault(snap)
            if fault is None:
                st["paged"].clear()     # episode over: the next one pages afresh
                st["fault_seen"] = None
                st["span_wait"] = None
                st["status"] = "no target fault"
                continue
            key = (fault.get("code"), fault.get("since"))
            if st["fault_seen"] is None or st["fault_seen"][0] != key:
                st["fault_seen"] = (key, self._mono())   # a new onset restarts the in-process grace
            await self._consider(pid, poller, st, fault, fresh)

    def _pump_down(self, pid: str) -> str | None:
        poller = self.pollers.get(pid)
        if poller is None:
            return "no telemetry"
        s = poller.snapshot
        if not self._fresh(s):
            return "offline"
        if s.get("identity_ok") is False:
            return "gateway identity check failed"
        if s.get("on") is False or s.get("state") == "off":
            return "switched off"
        st = self._pumps.get(pid)
        recently_running = s.get("running") or (st is not None and st["last_running"] is not None
                                                and self._mono() - st["last_running"] < RUNNING_QUIET_S)
        bad = [str(f.get("code")) for f in s.get("active_faults", []) if _is_blocking(f)]
        if bad and not recently_running:
            return f"faulted ({', '.join(bad)})"
        return None

    async def _watch_all_down(self) -> None:
        """Independent of triggers and phases: every pump down for ALL_DOWN_PAGE_S pages once,
        and re-arms when any pump is back. (Shares its de-dup with the per-pump both-down page.)"""
        if not self.cfg.enabled or not self._pumps:
            return
        downs = {pid: self._pump_down(pid) for pid in self._pumps}
        if not all(downs.values()):
            self._all_down_since = None
            self._both_down_paged = False
            return
        self._all_down_since = self._all_down_since or self._mono()
        if self._mono() - self._all_down_since < ALL_DOWN_PAGE_S or self._both_down_paged:
            return
        self._both_down_paged = True
        why = "; ".join(f"{self.pollers[p].cfg.name if p in self.pollers else p}: {d}"
                        for p, d in downs.items())
        await self._step(next(iter(self._pumps)), "both_down", "critical",
                         f"Every heat pump is down ({why}). Self-heal will not power-cycle while "
                         f"the other pump is down — check both units now.",
                         {"pumps": downs}, title="URGENT: both heat pumps down", priority="urgent")

    async def _startup_notes(self) -> None:
        if not self.cfg.enabled:
            return
        if self.history_problem:
            await self._step(next(iter(self._pumps), "span"), "history_unreadable", "high",
                             f"self-heal history unreadable ({self.history_problem}) — treating the "
                             f"attempt budget as spent for {self.cfg.window_h:g} h.", {},
                             title="A2W self-heal: history unreadable", priority="high")
        if self.cfg.live and self.config_errors:
            for pid, why in self.config_errors.items():
                await self._step(pid, "unavailable", "high",
                                 f"self-heal is LIVE but unavailable for {pid}: {why}.", {"reason": why},
                                 title=f"A2W self-heal: {pid} unavailable", priority="high")

    async def _consider(self, pid, poller, st, fault, fresh) -> None:
        name, code = poller.cfg.name, fault.get("code")
        circuit = self.cfg.circuits[pid]
        snap = poller.snapshot
        if snap.get("identity_ok") is False:
            st["status"] = f"{code} active but {name}'s gateway identity check failed — not cycling"
            if "identity" not in st["paged"]:
                st["paged"].add("identity")
                await self._step(pid, "identity_mismatch", "critical",
                                 f"{name}: {code} active, but its gateway identity check failed — the "
                                 f"data may be another unit's. Self-heal will not cycle '{circuit}'.",
                                 {"code": code}, title=f"A2W self-heal: {name} identity check failed")
            return
        if not fresh:
            st["status"] = f"{code} active but {name} is offline/stale — waiting"
            other = self._other_down(pid, span=self._span())
            if other and not self._both_down_paged:
                # Nothing to cycle on stale data — but a pump offline with a last-known fault
                # AND its peer down is the both-down case, and it pages.
                self._both_down_paged = True
                await self._step(pid, "both_down", "critical",
                                 f"{name} is offline (last known: {code}) AND {other}. Check both "
                                 f"units; '{circuit}' can be power-cycled at the SPAN panel by hand.",
                                 {"code": code, "other": other, "target_offline": True},
                                 title="URGENT: both heat pumps down", priority="urgent")
            return
        age_wall = (self._clock() - float(fault.get("since") or self._clock())) / 60
        age_seen = (self._mono() - st["fault_seen"][1]) / 60
        age_min = min(age_wall, age_seen)     # both clocks must agree the grace has passed
        if age_min < self.cfg.grace_min:
            st["status"] = f"{code} active {age_min:.0f} min (< {self.cfg.grace_min:g} min grace)"
            return
        busy = self._heating_or_defrost(snap, st)
        if busy:
            st["status"] = f"{code} active but {name} {busy} — not cycling"
            return
        # Both-down comes BEFORE the budget: an escalated pump must still page when its peer
        # goes down afterwards (each kind is de-duplicated on its own).
        span = self._span()
        other = self._other_down(pid, span=span)
        if other:
            st["status"] = f"{code} active but {other} — not cycling (paged)"
            if not self._both_down_paged:
                self._both_down_paged = True
                await self._step(pid, "both_down", "critical",
                                 f"{name}: {code} for {age_min:.0f} min AND {other}. A2W will not "
                                 f"power-cycle while the other pump is down — check both units; "
                                 f"'{circuit}' can be cycled at the SPAN panel by hand.",
                                 {"code": code, "other": other},
                                 title="URGENT: both heat pumps down", priority="urgent")
            return
        recent = self._recent(st)
        if len(recent) >= self.cfg.max_attempts:
            st["status"] = (f"escalated: {code} persists after {len(recent)} power cycles "
                            f"in {self.cfg.window_h:g} h")
            if "escalated" not in st["paged"]:
                st["paged"].add("escalated")
                await self._step(pid, "escalated", "critical",
                                 f"{name}: {code} persists after {len(recent)} "
                                 f"{'(shadow) ' if not self.cfg.live else ''}power cycles in "
                                 f"{self.cfg.window_h:g} h"
                                 f"{' (history unreadable — budget treated as spent)' if self.history_problem else ''}"
                                 f" — A2W stops trying. Needs a human: check "
                                 f"the unit, or power-cycle the '{circuit}' breaker at the SPAN panel.",
                                 {"code": code, "attempts": recent},
                                 title=f"URGENT: {name} {code} not self-healing", priority="urgent")
            return
        if self.cfg.live:
            if self.breakers is None:
                st["status"] = "live, but SPAN breaker control is not configured"
                if "no_breakers" not in st["paged"]:
                    st["paged"].add("no_breakers")
                    await self._manual(pid, name, code, circuit, "SPAN local control is not configured")
                return
            if span is None:
                st["span_wait"] = st["span_wait"] or self._mono()
                waited = self._mono() - st["span_wait"]
                st["status"] = f"{code} active — waiting for a fresh SPAN panel read ({waited / 60:.0f} min)"
                if waited >= SPAN_WAIT_PAGE_S and "span_unknown" not in st["paged"]:
                    st["paged"].add("span_unknown")
                    await self._manual(pid, name, code, circuit, "the SPAN panel has not answered the Pi")
                return
            st["span_wait"] = None
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
            st["attempts"].append(self._stamp())
            self._save()
            st["status"] = f"SHADOW: would power-cycle '{circuit}' ({code} {age_min:.0f} min)"
            await self._step(pid, "would_cycle", "warning",
                             f"{name}: {code} active {age_min:.0f} min, not heating — WOULD power-cycle "
                             f"'{circuit}' ({self.cfg.off_s:g} s off). Shadow mode: nothing switched.",
                             detail, title=f"A2W self-heal (shadow): would cycle {name}")
            self._begin_verify(st, code, shadow=True)
            self._save()
            return
        if self.breakers.snapshot()["busy"]:
            st["status"] = "waiting: another breaker action is running"
            return
        st["attempts"].append(self._stamp())
        self._begin_verify(st, code, shadow=False)   # persisted with the attempt: a restart
        if not self._save():   # counted durably BEFORE acting, or not at all
            st["attempts"].pop()
            st["phase"], st["verify"] = "idle", None
            st["status"] = "refusing: cannot persist the attempt budget"
            if "persist" not in st["paged"]:
                st["paged"].add("persist")
                await self._manual(pid, name, code, circuit, "the bridge cannot persist its attempt budget")
            return
        st["status"] = f"power-cycling '{circuit}'"
        await self._step(pid, "cycle_start", "warning",
                         f"{name}: {code} active {age_min:.0f} min, not heating — power-cycling "
                         f"'{circuit}' ({self.cfg.off_s:g} s off), attempt {len(self._recent(st))}/"
                         f"{self.cfg.max_attempts}.", detail,
                         title=f"A2W self-heal: power-cycling {name}")
        try:
            episode = (code, fault.get("since"), st["fault_seen"])
            result = await self.breakers.execute(
                circuit, "power_cycle", off_s=self.cfg.off_s, source="self-heal",
                precheck=lambda circ: self._precheck(pid, episode, circ))
        except BreakerRefused as exc:
            text = str(exc)
            if text.startswith("precheck:") or "one at a time" in text:
                # Conditions changed at the last moment (or a human is switching): nothing was
                # switched, so it is not an attempt. The next tick re-evaluates from scratch.
                st["attempts"].pop()
                st["phase"], st["verify"] = "idle", None
                self._save()
                st["status"] = f"aborted before switching: {text}"
                await self._step(pid, "cycle_aborted", "info",
                                 f"{name}: power cycle aborted before anything was switched — {text}.",
                                 {**detail, "reason": text},
                                 title=f"A2W self-heal: {name} cycle aborted", priority="default")
                return
            st["status"] = f"cycle refused: {text}"
            st["phase"], st["verify"] = "idle", None
            self._record_outcome(st, "refused", text)
            if "refused" not in st["paged"]:
                st["paged"].add("refused")
                await self._manual(pid, name, code, circuit, text)
            return
        if not result.get("ok"):
            # The controller already paged a failed CLOSE (urgent, with the manual step).
            st["status"] = f"cycle failed: {result.get('detail')}"
            st["phase"], st["verify"] = "idle", None
            self._record_outcome(st, "cycle_failed", result.get("detail", ""))
            await self._step(pid, "cycle_failed", "critical",
                             f"{name}: power cycle of '{circuit}' did not complete cleanly: "
                             f"{result.get('detail')}.", {**detail, "result": result},
                             title=f"A2W self-heal: {name} power cycle failed", priority="high")
            return
        st["status"] = f"cycled; verifying recovery (≤ {self.cfg.verify_min:g} min)"
        self._begin_verify(st, code, shadow=False)   # the window starts after the cycle

    def _precheck(self, pid: str, episode: tuple, circ: dict) -> str | None:
        """Re-run the pump guards on the CURRENT snapshots and the controller's FRESH panel read.
        Called twice by the controller: on the fresh read, and again in the worker immediately
        before the POST (OpenPermit guard). The fault must still be the SAME episode that earned
        the grace — same code, same onset — and still past the grace on both clocks."""
        code, since, seen = episode
        poller = self.pollers.get(pid)
        if poller is None:
            return "pump not configured"
        snap, st = poller.snapshot, self._pumps[pid]
        if not self._fresh(snap):
            return f"{poller.cfg.name} telemetry is stale"
        if snap.get("identity_ok") is False:
            return f"{poller.cfg.name}'s gateway identity check failed"
        busy = self._heating_or_defrost(snap, st)
        if busy:
            return f"{poller.cfg.name} {busy}"
        f = self._target_fault(snap)
        if f is None:
            return f"{code} cleared on its own"
        if f.get("code") != code or f.get("since") != since:
            return f"the fault episode changed ({f.get('code')} since {f.get('since')})"
        if seen is None or min((self._clock() - float(since or self._clock())) / 60,
                               (self._mono() - seen[1]) / 60) < self.cfg.grace_min:
            return "the fault is inside its grace period"
        other = self._other_down(pid, span=None)   # the controller itself checks the relays
        if other:
            return other
        if circ.get("power_w") is not None and circ["power_w"] >= self.cfg.running_power_w:
            return f"'{circ.get('name')}' draws {circ['power_w']:.0f} W while the pump reports idle"
        return None

    def _begin_verify(self, st: dict, code: str, *, shadow: bool) -> None:
        now = self._mono()
        st["phase"] = "verifying"
        st["verify"] = {"cycle": now, "until": now + self.cfg.verify_min * 60, "shadow": shadow,
                        "code": code, "cleared_since": None}

    async def _verify(self, pid, poller, st, fresh) -> None:
        v = st["verify"]
        name, code = poller.cfg.name, v["code"]
        snap = poller.snapshot
        now = self._mono()
        blocking = [f for f in snap.get("active_faults", []) if _is_blocking(f)]
        target_active = any(str(f.get("code", "")).upper() == str(code).upper() for f in blocking)
        switched_off = snap.get("on") is False or snap.get("state") == "off"
        clear_now = (fresh and snap.get("identity_ok") is not False and not blocking
                     and not switched_off)
        # the hold only counts FRESH, clear, CONTINUOUSLY observed time: a fault, stale data, or
        # an unobserved stretch between verification ticks (e.g. the loop was busy cycling the
        # other pump) restarts it
        gap = v.get("last_obs") is not None and now - v["last_obs"] > OBS_GAP_S
        v["last_obs"] = now
        v["cleared_since"] = (v["cleared_since"] or now) if clear_now and not gap else (
            now if clear_now else None)
        power = self._circuit_power(pid)
        running = bool(snap.get("running"))
        consistent = (not running) or (power is not None and power >= self.cfg.running_power_w)
        recovered = clear_now and now - v["cleared_since"] >= CLEAR_HOLD_S and consistent
        facts = {"code": code, "target_fault_active": target_active,
                 "blocking_faults": [str(f.get("code")) for f in blocking], "online": fresh,
                 "running": running, "circuit_power_w": power, "shadow": v["shadow"],
                 "minutes_since_cycle": round((now - v["cycle"]) / 60, 1)}
        if v["shadow"]:
            if recovered or now >= v["until"]:
                outcome = "cleared on its own" if recovered else "still active (nothing was switched)"
                st["phase"], st["verify"] = "idle", None
                self._record_outcome(st, "shadow_" + ("cleared" if recovered else "active"), outcome)
                await self._audit(pid, "shadow_verify", "info",
                                  f"{name}: shadow verification — {code} {outcome}", facts)
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
                             f"{name}: recovered after the power cycle — {code} cleared, no other "
                             f"fault ({how}).", facts, title=f"A2W self-heal: {name} recovered",
                             priority="default")
            return
        if now >= v["until"]:
            st["phase"], st["verify"] = "idle", None
            others = [str(f.get("code")) for f in blocking if str(f.get("code", "")).upper() != str(code).upper()]
            why = (f"{code} still active" if target_active
                   else f"replaced by {', '.join(others)}" if others
                   else "offline/stale" if not fresh
                   else "switched off" if switched_off
                   else f"power inconsistent with running ({power} W)" if not consistent
                   else f"not observed clear for {CLEAR_HOLD_S / 60:g} min")
            self._record_outcome(st, "not_recovered", why)
            st["status"] = f"not recovered: {why}"
            await self._step(pid, "not_recovered", "critical",
                             f"{name}: NOT recovered {self.cfg.verify_min:g} min after the power cycle — "
                             f"{why}.", facts, title=f"A2W self-heal: {name} did not recover",
                             priority="high")
            return
        st["status"] = f"verifying recovery ({facts['minutes_since_cycle']} min since cycle)"

    # --- audit / alerts / persistence -----------------------------------------
    async def _manual(self, pid, name, code, circuit, why) -> None:
        await self._step(pid, "cycle_refused", "critical",
                         f"{name}: {code} — self-heal could not power-cycle '{circuit}': {why}. Do it "
                         f"by hand: switch '{circuit}' OFF at the SPAN panel, wait a minute, switch it ON.",
                         {"code": code, "circuit": circuit, "reason": why},
                         title=f"URGENT: {name} {code} — manual power cycle needed", priority="urgent")

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

    def _load(self) -> tuple[dict, str | None]:
        """(pumps, problem). A missing file is a clean start; anything unreadable or not exactly
        the expected shape is a problem (the caller then treats the budget as spent).
        Attempts from ANOTHER boot are rebased to now: across a reboot neither clock can say how
        long ago they were, so each counts for a full window from this start (conservative; the
        file only ever holds attempts that were inside the window when it was last written)."""
        if not self._path:
            return {}, None
        try:
            data = json.loads(self._path.read_bytes())
        except FileNotFoundError:
            return {}, None
        except (OSError, ValueError) as exc:
            return {}, f"{type(exc).__name__}: {exc}"
        try:
            if not isinstance(data, dict) or data.get("v") != 2:
                raise ValueError("unknown version")
            pumps = data["pumps"]
            if not isinstance(pumps, dict):
                raise ValueError("pumps is not an object")
            missing = [pid for pid in self.cfg.circuits if pid not in pumps]
            if missing:   # an existing file that lacks a pump's budget is not "zero attempts"
                raise ValueError(f"no history for {', '.join(missing)}")
            out: dict = {}
            for pid, p in pumps.items():
                if not isinstance(p, dict) or not isinstance(p.get("attempts"), list):
                    raise ValueError(f"{pid}: bad entry")
                attempts = []
                for a in p["attempts"]:
                    wall, mono = a["wall"], a.get("mono")
                    if isinstance(wall, bool) or not isinstance(wall, (int, float)) or not math.isfinite(wall):
                        raise ValueError(f"{pid}: bad attempt time {wall!r}")
                    if mono is not None and (isinstance(mono, bool) or not isinstance(mono, (int, float))
                                             or not math.isfinite(mono)):
                        raise ValueError(f"{pid}: bad attempt mono {mono!r}")
                    if not (self._boot_id and a.get("boot") == self._boot_id and mono is not None):
                        a = {"wall": wall, "mono": self._mono(), "boot": self._boot_id, "rebased": True}
                    attempts.append({"wall": wall, "mono": a["mono"], "boot": a["boot"],
                                     **({"rebased": True} if a.get("rebased") else {})})
                lo, vf = p.get("last_outcome"), p.get("verify")
                out[pid] = {"attempts": attempts, "last_outcome": lo if isinstance(lo, dict) else None,
                            "verify": vf if isinstance(vf, dict) else None}
            return out, None
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            return {}, f"malformed history: {exc}"

    def _save(self) -> bool:
        if not self._path:
            return False
        data = {"v": 2, "pumps": {
            pid: {"attempts": st["attempts"], "last_outcome": st["last_outcome"],
                  "verify": ({"code": st["verify"]["code"], "shadow": st["verify"]["shadow"]}
                             if st["phase"] == "verifying" and st["verify"] else None)}
            for pid, st in self._pumps.items()}}
        tmp = self._path.with_suffix(".tmp")
        try:  # durable: the attempt budget must survive a power blip
            with open(tmp, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path)
            dfd = os.open(str(self._path.parent), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
            return True
        except OSError as exc:
            log.warning("self-heal state write failed: %s", exc)
            return False
