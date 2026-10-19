# @purpose: Guarded remote breaker control over the SPAN panel's LOCAL API (owner decision
# 2026-10-18). The SPAN app's cloud path cannot switch circuits at this house, so the dashboard
# reaches the panel through hub -> Pi -> LAN instead. Three actions on an allowlist from config:
#   close        — turn a circuit ON. Every allowlisted circuit.
#   power_cycle  — OPEN, hold >= min_off_s (floor 60 s), CLOSE in a `finally` with retries.
#                  Only circuits with allow_cycle (Air-Water 1/2 by default). A failed CLOSE pages
#                  urgent with the manual instruction and keeps retrying in the background.
#   open         — turn a circuit OFF and leave it off. Only circuits with allow_open (none by
#                  default), so nothing here can leave a heat pump off indefinitely.
# Guards: allowlist, isUserControllable, ONE action at a time (global lock), never two heat-pump
# circuits off at once, read-back of relayState after every write. Every attempt — accepted or
# refused — is an audit event (mirrored to the cloud) plus a push + email line. The only code
# that can OPEN a relay is here: it mints a single-use span_local.OpenPermit after the guards.
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
from .span_local import OpenPermit, extract_relay

log = logging.getLogger(__name__)

ACTIONS = ("power_cycle", "close", "open")
EVENT_PUMP_ID = "span"       # events.pump_id for breaker audit rows (mirrored like pump events)
EVENT_TYPE = "span_breaker"
READBACK_TRIES = 3           # the panel can lag a write by a beat; re-read before calling it a mismatch
READBACK_GAP_S = 1.0
STOP_GRACE_S = 75.0          # on shutdown, let a running cycle finish its hold rather than cut it short
CYCLE_FILE = "span-breaker-cycle.json"


class BreakerRefused(Exception):
    """A guard said no before anything was switched. status_code is the HTTP mapping."""

    def __init__(self, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.status_code = status_code


class BreakerController:
    def __init__(self, cfg, client, store, *, notify_cfg=None, cache=None,
                 state_dir: str | None = None, sleep=asyncio.sleep, clock=time.time):
        self.cfg = cfg                  # SpanConfig
        self.client = client            # span_local.SpanClient (or a test double)
        self.store = store
        self.notify_cfg = notify_cfg
        self.cache = cache              # SpanLocalPoller: latest_circuits shared with the poll loop
        self._cycle_path = Path(state_dir) / CYCLE_FILE if state_dir else None
        self._sleep = sleep             # injectable: tests hold 60 s without waiting 60 s
        self._clock = clock
        self._busy: dict | None = None  # the ONE action in flight (global lock)
        self._task: asyncio.Task | None = None
        self._pending_close: dict[str, asyncio.Task] = {}   # circuit name -> background re-close
        self._opened_at: dict[str, float] = {}              # circuit name -> when A2W opened it
        self._bg: set[asyncio.Task] = set()
        self.last: dict | None = None

    # --- public ---------------------------------------------------------------
    def snapshot(self) -> dict:
        """Allowlist + live relay state for /api/span/circuits and the hub state frame."""
        latest = getattr(self.cache, "latest_circuits", {}) or {}
        circuits = []
        for b in self.cfg.breakers:
            c = latest.get(b.name)
            circuits.append({
                "name": b.name, "found": c is not None,
                "circuit_id": c["circuit_id"] if c else None,
                "relay_state": c["relay_state"] if c else None,
                "controllable": c["controllable"] if c else None,
                "power_w": c["power_w"] if c else None,
                "allow_cycle": b.allow_cycle, "allow_open": b.allow_open, "heat_pump": b.heat_pump,
            })
        return {
            "ts": getattr(self.cache, "latest_circuits_ts", None),
            "circuits": circuits,
            "busy": dict(self._busy) if self._busy else None,
            "pending_close": sorted(self._pending_close),
            "last": self.last,
            "min_off_s": self.cfg.min_off_s,
            "max_off_s": self.cfg.max_off_s,
        }

    async def execute(self, circuit, action, *, off_s=None, source: str = "ui") -> dict:
        """Run one breaker action. Raises BreakerRefused when a guard says no (nothing was
        switched); otherwise returns the outcome with the READ-BACK relay state. The work runs in
        a controller-owned task behind a shield, so a caller that goes away (a closed browser
        tab, a dropped hub link) can never abandon a circuit half-way through a cycle."""
        name = circuit.strip() if isinstance(circuit, str) else ""
        label = name or repr(circuit)
        try:
            spec, hold = self._validate(name, action, off_s)
            if self._busy is not None:
                b = self._busy
                raise BreakerRefused(
                    f"another breaker action is running ({b['action']} on '{b['circuit']}') — "
                    "one at a time", 409)
            if self._pending_close and action != "close":
                raise BreakerRefused(
                    f"'{', '.join(sorted(self._pending_close))}' has not been verified back ON yet — "
                    "only 'close' is allowed until it is", 409)
        except BreakerRefused as exc:
            await self._refused(label, action, source, str(exc))
            raise
        # check-and-set with no await in between: atomic on the event loop
        self._busy = {"circuit": spec.name, "action": action, "source": source,
                      "started": self._clock(), "off_s": hold}
        self._task = asyncio.create_task(self._run(spec, action, hold, source),
                                         name=f"span-breaker-{action}")
        return await asyncio.shield(self._task)

    async def recover(self) -> None:
        """Startup: a cycle file means a previous process opened a circuit and may not have
        closed it (crash, power loss, a stop that outlasted its grace). Finish that cycle: wait
        out the rest of the minimum off time, then CLOSE with the same retries and paging."""
        rec = self._read_cycle_file()
        if rec is None:
            return
        name, cid = rec.get("name"), rec.get("circuit_id")
        if not isinstance(name, str) or not isinstance(cid, str):
            # We cannot tell WHICH circuit was left off — say so loudly rather than guess.
            log.warning("span breaker: unreadable cycle record — paging: %r", rec)
            self._clear_cycle_file()
            await self._audit_raw("cycle_record_unreadable", "critical",
                                  "an interrupted power cycle left an unreadable record — check that "
                                  "every Air-Water circuit is ON", {"record": repr(rec)[:200]})
            self._alert("URGENT: check the Air-Water breakers",
                        "A bridge restart interrupted a power cycle and its record is unreadable. "
                        "Check that the Air-Water 1 and Air-Water 2 circuits are ON at the SPAN panel.",
                        "urgent")
            return
        hold = float(rec.get("off_s") or self.cfg.min_off_s)
        remaining = (float(rec.get("opened_at") or 0) + hold) - self._clock()
        remaining = min(max(remaining, 0.0), hold)   # a clock jump at boot can't stretch it
        self._busy = {"circuit": name, "action": "recover_close", "source": "restart",
                      "started": self._clock(), "off_s": hold}
        self._task = asyncio.create_task(self._recover(name, cid, remaining),
                                         name="span-breaker-recover")

    async def stop(self) -> None:
        task = self._task
        if task and not task.done():
            # Let the hold finish (min off time) and the CLOSE land; only then give up.
            try:
                await asyncio.wait_for(asyncio.shield(task), STOP_GRACE_S)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
        for t in list(self._pending_close.values()) + list(self._bg):
            t.cancel()
        for t in list(self._pending_close.values()) + list(self._bg):
            with contextlib.suppress(BaseException):
                await t

    # --- guards ---------------------------------------------------------------
    def _validate(self, name: str, action, off_s):
        if action not in ACTIONS:
            raise BreakerRefused(f"unknown breaker action {action!r} (power_cycle | close | open)", 422)
        spec = next((b for b in self.cfg.breakers if b.name.strip() == name), None)
        if spec is None:
            raise BreakerRefused(f"'{name}' is not on the breaker allowlist", 403)
        if action == "power_cycle" and not spec.allow_cycle:
            raise BreakerRefused(f"power cycle is not allowed for '{name}'", 403)
        if action == "open" and not spec.allow_open:
            raise BreakerRefused(
                f"'{name}' may not be switched off and left off "
                f"({'power cycle only' if spec.allow_cycle else 'close-only'})", 403)
        hold = 0.0
        if action == "power_cycle":
            hold = self.cfg.min_off_s if off_s is None else off_s
            if isinstance(hold, bool) or not isinstance(hold, (int, float)) or not math.isfinite(hold):
                raise BreakerRefused(f"invalid off_s {off_s!r}", 422)
            hold = float(hold)
            if hold < self.cfg.min_off_s:
                raise BreakerRefused(
                    f"off_s {hold:g} is below the minimum off time {self.cfg.min_off_s:g} s", 422)
            if hold > self.cfg.max_off_s:
                raise BreakerRefused(f"off_s {hold:g} exceeds max_off_s {self.cfg.max_off_s:g}", 422)
        return spec, hold

    async def _read_panel(self) -> dict:
        circuits = await self.client.fetch_circuits()
        if self.cache is not None and hasattr(self.cache, "note_circuits"):
            self.cache.note_circuits(circuits, self._clock())
        return circuits

    # --- the run --------------------------------------------------------------
    async def _run(self, spec, action: str, hold: float, source: str) -> dict:
        try:
            try:
                circuits = await self._read_panel()
            except Exception as exc:  # noqa: BLE001 — nothing switched yet: a clean refusal
                raise BreakerRefused(f"SPAN panel unreachable on the LAN: {exc}", 503) from exc
            circ = extract_relay(circuits, spec.name)
            if circ is None or not circ["circuit_id"]:
                raise BreakerRefused(f"'{spec.name}' was not found on the panel", 404)
            if not circ["controllable"]:
                raise BreakerRefused(f"'{spec.name}' reports isUserControllable=false", 409)
            if action in ("power_cycle", "open") and spec.heat_pump:
                off = [b.name for b in self.cfg.breakers
                       if b.heat_pump and b.name != spec.name
                       and (extract_relay(circuits, b.name) or {}).get("relay_state") != "CLOSED"]
                if off:
                    raise BreakerRefused(
                        f"'{', '.join(off)}' is not confirmed ON — never two heat pumps off at once", 409)
            if action == "close":
                return await self._do_close(spec, circ, source)
            if circ["relay_state"] != "CLOSED":
                raise BreakerRefused(
                    f"'{spec.name}' is already {circ['relay_state'] or 'in an unknown state'} — "
                    "use On to restore it", 409)
            if action == "open":
                return await self._do_open(spec, circ, source)
            return await self._do_cycle(spec, circ, hold, source)
        except BreakerRefused as exc:
            await self._refused(spec.name, action, source, str(exc))
            raise
        finally:
            self._busy = None
            self._task = None

    async def _do_close(self, spec, circ, source: str) -> dict:
        name, cid = spec.name, circ["circuit_id"]
        opened = self._opened_at.get(name)
        if opened is not None and self._clock() - opened < self.cfg.min_off_s:
            left = self.cfg.min_off_s - (self._clock() - opened)
            raise BreakerRefused(
                f"'{name}' was switched off {self._clock() - opened:.0f} s ago — minimum off time "
                f"is {self.cfg.min_off_s:g} s ({left:.0f} s left)", 409)
        state, err = await self._close_once(cid, name)
        ok = state == "CLOSED"
        if ok:
            self._opened_at.pop(name, None)
            self._finish_pending(name)
        result = self._result(name, "close", ok, state, "CLOSED", source,
                              "ON (verified)" if ok else f"read-back {state or 'unavailable'}"
                              + (f" ({err})" if err else ""))
        await self._audit("closed" if ok else "verify_mismatch", "info" if ok else "high", result)
        self._alert(f"A2W breaker: {name} {'ON' if ok else 'NOT confirmed ON'}",
                    f"{name}: switch ON ({source}) → {result['detail']}.",
                    "default" if ok else "high")
        return result

    async def _do_open(self, spec, circ, source: str) -> dict:
        name, cid = spec.name, circ["circuit_id"]
        err = None
        try:
            await self.client.set_relay(cid, "OPEN", open_permit=OpenPermit(cid, name, f"open ({source})"))
        except Exception as exc:  # noqa: BLE001 — the request may still have landed; read back
            err = str(exc)
        self._opened_at[name] = self._clock()   # min-off guard even if the read-back is unsure
        state = await self._readback(cid, name, "OPEN")
        ok = state == "OPEN"
        detail = "OFF (verified)" if ok else f"read-back {state or 'unavailable'}" + (f" ({err})" if err else "")
        result = self._result(name, "open", ok, state, "OPEN", source, detail)
        await self._audit("opened" if ok else "verify_mismatch", "warning" if ok else "high", result)
        self._alert(f"A2W breaker: {name} {'OFF' if ok else 'switch-off NOT confirmed'}",
                    f"{name}: switch OFF ({source}) → {detail}. It stays off until someone turns it on.",
                    "high")
        return result

    async def _do_cycle(self, spec, circ, hold: float, source: str) -> dict:
        name, cid = spec.name, circ["circuit_id"]
        started = self._clock()
        self._write_cycle_file({"name": name, "circuit_id": cid, "opened_at": started,
                                "off_s": hold, "source": source})
        open_state: str | None = None
        open_err: str | None = None
        held = cancelled = False
        try:
            try:
                await self.client.set_relay(cid, "OPEN",
                                            open_permit=OpenPermit(cid, name, f"power_cycle ({source})"))
            except Exception as exc:  # noqa: BLE001 — may have landed anyway; the read-back decides
                open_err = str(exc)
            self._opened_at[name] = started
            open_state = await self._readback(cid, name, "OPEN")
            await self._audit_raw("cycle_opened" if open_state == "OPEN" else "cycle_open_unconfirmed",
                                  "warning" if open_state == "OPEN" else "high",
                                  f"{name}: power cycle — OFF {'(verified)' if open_state == 'OPEN' else 'NOT confirmed: read-back ' + str(open_state)}"
                                  f"{' (' + open_err + ')' if open_err else ''}; holding {hold:g} s ({source})",
                                  {"circuit": name, "relay_state": open_state, "off_s": hold, "source": source})
            if open_state == "CLOSED" and open_err:
                held = True   # the OPEN demonstrably never landed: nothing to hold, just confirm ON
            else:
                await self._sleep(hold)
                held = True
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if not held and not cancelled:
                # Something failed mid-hold: the circuit may be off, so the minimum off time
                # still applies before switching it back on (anti-short-cycle).
                left = hold - (self._clock() - started)
                if left > 0:
                    with contextlib.suppress(Exception):
                        await self._sleep(left)
            off_for = self._clock() - started
            closed_state, attempts, close_err = await self._close_with_retries(cid, name)
            ok_close = closed_state == "CLOSED"
            if ok_close:
                self._opened_at.pop(name, None)
                self._clear_cycle_file()
            else:
                self._start_reclose(name, cid)
            ok = ok_close and open_state == "OPEN"
            if ok:
                detail = f"OFF {off_for:.0f} s, back ON (verified)"
            elif ok_close:
                detail = (f"switch-off NOT confirmed (read-back {open_state or 'unavailable'}"
                          f"{'; ' + open_err if open_err else ''}); circuit ON (verified)")
            else:
                detail = (f"COULD NOT switch back ON after {attempts} tries "
                          f"(read-back {closed_state or 'unavailable'}{'; ' + close_err if close_err else ''})")
            result = self._result(name, "power_cycle", ok, closed_state, "CLOSED", source, detail)
            result["off_s"] = round(off_for, 1)
            result["close_attempts"] = attempts
            self.last = result
            if ok_close:
                await self._audit("cycle_done" if ok else "verify_mismatch",
                                  "info" if ok else "high", result)
                self._alert(f"A2W breaker: {name} power-cycled" if ok
                            else f"A2W breaker: {name} power cycle unconfirmed",
                            f"{name}: power cycle ({source}) → {detail}.",
                            "default" if ok else "high")
            else:
                await self._audit("close_failed", "critical", result)
                self._alert(f"URGENT: {name} is OFF - turn it back on",
                            f"A2W switched '{name}' OFF for a power cycle and could NOT switch it back "
                            f"ON ({detail}). Turn the '{name}' breaker ON at the SPAN panel now "
                            f"(physical switch in the panel, or the SPAN app if it works). A2W keeps "
                            f"retrying every {self.cfg.reclose_interval_s:g} s.", "urgent")
        return result

    async def _recover(self, name: str, cid: str, remaining: float) -> None:
        try:
            await self._audit_raw("cycle_recover", "high",
                                  f"{name}: a power cycle was interrupted by a bridge restart — "
                                  f"switching it back ON in {remaining:.0f} s",
                                  {"circuit": name, "remaining_s": remaining})
            if remaining > 0:
                await self._sleep(remaining)
            state, attempts, err = await self._close_with_retries(cid, name)
            ok = state == "CLOSED"
            result = self._result(name, "recover_close", ok, state, "CLOSED", "restart",
                                  "back ON (verified)" if ok else
                                  f"COULD NOT switch back ON after {attempts} tries ({err or state})")
            self.last = result
            if ok:
                self._clear_cycle_file()
                await self._audit("closed", "high", result)
                self._alert(f"A2W breaker: {name} restored after restart",
                            f"{name}: a power cycle was interrupted by a bridge restart; the circuit "
                            "is back ON (verified).", "high")
            else:
                self._start_reclose(name, cid)
                await self._audit("close_failed", "critical", result)
                self._alert(f"URGENT: {name} is OFF - turn it back on",
                            f"After a bridge restart A2W could not switch '{name}' back ON. Turn the "
                            f"'{name}' breaker ON at the SPAN panel now. A2W keeps retrying.", "urgent")
        finally:
            self._busy = None
            self._task = None

    # --- relay primitives -----------------------------------------------------
    async def _readback(self, cid: str, name: str, want: str) -> str | None:
        """Re-read the panel until the relay shows `want` (or tries run out). Returns the last
        state seen, or None if the panel could not be read at all."""
        state = None
        for i in range(READBACK_TRIES):
            try:
                circuits = await self._read_panel()
                c = extract_relay(circuits, name)
                state = c["relay_state"] if c and c["circuit_id"] == cid else state
            except Exception as exc:  # noqa: BLE001
                log.warning("span breaker read-back failed (%s): %s", name, exc)
            if state == want:
                return state
            if i < READBACK_TRIES - 1:
                await self._sleep(READBACK_GAP_S)
        return state

    async def _close_once(self, cid: str, name: str) -> tuple[str | None, str | None]:
        err = None
        try:
            await self.client.set_relay(cid, "CLOSED")
        except Exception as exc:  # noqa: BLE001 — may have landed; the read-back decides
            err = str(exc)
        return await self._readback(cid, name, "CLOSED"), err

    async def _close_with_retries(self, cid: str, name: str) -> tuple[str | None, int, str | None]:
        state, err = None, None
        attempts = max(1, int(self.cfg.close_attempts))
        for i in range(attempts):
            state, err = await self._close_once(cid, name)
            if state == "CLOSED":
                return state, i + 1, None
            log.warning("span breaker: CLOSE %s attempt %d/%d failed (state=%s, %s)",
                        name, i + 1, attempts, state, err)
            if i < attempts - 1:
                with contextlib.suppress(Exception):
                    await self._sleep(self.cfg.close_retry_delay_s)
        return state, attempts, err

    def _start_reclose(self, name: str, cid: str) -> None:
        if name in self._pending_close and not self._pending_close[name].done():
            return
        self._pending_close[name] = asyncio.create_task(self._reclose_loop(name, cid),
                                                        name=f"span-reclose-{name}")

    async def _reclose_loop(self, name: str, cid: str) -> None:
        """Keep trying to switch a circuit we left OFF back ON until a read-back says CLOSED."""
        tries = 0
        while True:
            await self._sleep(self.cfg.reclose_interval_s)
            tries += 1
            state, err = await self._close_once(cid, name)
            if state == "CLOSED":
                self._opened_at.pop(name, None)
                self._clear_cycle_file()
                self._pending_close.pop(name, None)
                result = self._result(name, "reclose", True, state, "CLOSED", "background",
                                      f"back ON (verified) after {tries} background retries")
                self.last = result
                await self._audit("reclosed", "high", result)
                self._alert(f"A2W breaker: {name} back ON",
                            f"{name} is back ON (verified) after {tries} background retries.", "high")
                return

    def _finish_pending(self, name: str) -> None:
        t = self._pending_close.pop(name, None)
        if t:
            t.cancel()
            self._clear_cycle_file()

    # --- audit + alerts -------------------------------------------------------
    def _result(self, name, action, ok, state, expected, source, detail) -> dict:
        return {"ok": bool(ok), "circuit": name, "action": action, "relay_state": state,
                "expected": expected, "verified": state == expected, "source": source,
                "detail": detail, "ts": self._clock()}

    async def _refused(self, name: str, action, source: str, reason: str) -> None:
        msg = f"{name}: {action} refused ({source}) — {reason}"
        log.warning("span breaker %s", msg)
        await self._audit_raw("refused", "warning", msg,
                              {"circuit": name, "action": action, "source": source, "reason": reason})
        self._alert(f"A2W breaker: {action} refused", msg, "default")

    async def _audit(self, code: str, severity: str, result: dict) -> None:
        if code != "refused":
            self.last = result
        await self._audit_raw(code, severity,
                              f"{result['circuit']}: {result['action']} ({result['source']}) → {result['detail']}",
                              result)

    async def _audit_raw(self, code: str, severity: str, message: str, detail: dict) -> None:
        try:  # an audit failure must never stand between a circuit and its CLOSE
            await self.store.add_event(EVENT_PUMP_ID, EVENT_TYPE, code=code, severity=severity,
                                       message=message, detail=detail)
        except Exception as exc:  # noqa: BLE001
            log.warning("span breaker audit failed: %s", exc)

    def _alert(self, title: str, message: str, priority: str) -> None:
        """Push + email one short line (fire-and-forget; never blocks the relay path)."""
        tags = "rotating_light" if priority == "urgent" else "electric_plug"
        for coro in (notify.ntfy(self.notify_cfg, title=title, message=message,
                                 priority=priority, tags=tags),
                     notify.email(self.notify_cfg, subject=title, body=message)):
            t = asyncio.create_task(coro)
            self._bg.add(t)
            t.add_done_callback(self._bg.discard)

    # --- crash-recovery record ------------------------------------------------
    def _write_cycle_file(self, rec: dict) -> None:
        if not self._cycle_path:
            return
        tmp = self._cycle_path.with_suffix(".tmp")
        try:  # atomic: a half-written record at this power-outage-prone site is useless
            with open(tmp, "w") as f:
                json.dump(rec, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._cycle_path)
        except OSError as exc:
            log.warning("span breaker: cycle record write failed: %s", exc)

    def _read_cycle_file(self) -> dict | None:
        if not self._cycle_path:
            return None
        try:
            rec = json.loads(self._cycle_path.read_text())
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            log.warning("span breaker: cycle record unreadable: %s", exc)
            return {}
        return rec if isinstance(rec, dict) else {}

    def _clear_cycle_file(self) -> None:
        if self._cycle_path:
            with contextlib.suppress(FileNotFoundError, OSError):
                self._cycle_path.unlink()
