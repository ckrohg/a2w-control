"use client";
// @purpose Shared client flow for a REAL tank boost (#186), used by the Optimize boost card and the
// Home "Heat now" card. confirm modal (exact request + preflight warnings) → POST /api/planner/boost
// → poll /api/planner/target (writer status) and /api/hub/state (which pumps are heating). Every
// message the UI shows comes from lib/boost-state.ts boostView(): success text exists ONLY after the
// writer status shows the boost; a planner rejection is shown verbatim as a rejection.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModals } from "./modal";
import {
  boostBody, boostView, confirmText, preflight, pumpsLine,
  type BoostPhase, type BoostRequest, type HubState, type WriterStatus,
} from "@/lib/boost-state";

const FAST_MS = 5_000; // while waiting for read-back / adoption
const SLOW_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export function useBoost() {
  const { confirm, Modals } = useModals();
  const [phase, setPhase] = useState<BoostPhase>({ phase: "idle" });
  const [st, setSt] = useState<WriterStatus | null>(null);
  const [stAtMs, setStAtMs] = useState<number | null>(null); // when `st` was last read successfully
  const [stErr, setStErr] = useState("");
  const [hub, setHub] = useState<HubState | null>(null);
  const [hubErr, setHubErr] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stRef = useRef<WriterStatus | null>(null);
  const hubRef = useRef<HubState | null>(null);
  // One poll in flight per endpoint (an interval tick while one is pending is skipped, so slow answers
  // are never starved by newer starts — Codex pass 2); a forced load (after a write) may overlap, and
  // then a response older than the last APPLIED one is dropped.
  const stSeq = useRef(0), stApplied = useRef(0), stBusy = useRef(false);
  const hubSeq = useRef(0), hubApplied = useRef(0), hubBusy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadStatus = useCallback(async (force = false) => {
    if (stBusy.current && !force) return;
    stBusy.current = true;
    const seq = ++stSeq.current;
    let next: WriterStatus | null = null, err = "";
    try {
      const res = await fetch("/api/planner/target", { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const body: WriterStatus & { error?: string } = await res.json().catch(() => ({}) as WriterStatus);
      if (res.ok) next = body;
      else err = body.error || `planner error (${res.status})`;
    } catch {
      err = "could not reach the dashboard server";
    }
    if (seq === stSeq.current) stBusy.current = false;
    if (!mounted.current || seq < stApplied.current) return;
    stApplied.current = seq;
    setSt(next); stRef.current = next; setStErr(err);
    if (next) setStAtMs(Date.now());
    setNowMs(Date.now());
  }, []);

  const loadHub = useCallback(async (force = false) => {
    if (hubBusy.current && !force) return;
    hubBusy.current = true;
    const seq = ++hubSeq.current;
    let next: HubState | null = null, err = "";
    try {
      const res = await fetch("/api/hub/state", { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const body: HubState & { error?: string } = await res.json().catch(() => ({}) as HubState);
      if (res.ok) next = body;
      else err = body.error || `hub error (${res.status})`;
    } catch {
      err = "could not reach the dashboard server";
    }
    if (seq === hubSeq.current) hubBusy.current = false;
    if (!mounted.current || seq < hubApplied.current) return;
    hubApplied.current = seq;
    setHub(next); hubRef.current = next; setHubErr(err);
  }, []);

  // The clock ticks on its own, so read-back age and the "unconfirmed" timeout advance even when a
  // poll is slow.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const view = useMemo(() => boostView(phase, st, nowMs, stAtMs), [phase, st, nowMs, stAtMs]);

  // Remember that the read-back showed this boost, so its later disappearance reads as "ended",
  // never as "unconfirmed".
  useEffect(() => {
    if (phase.phase === "accepted" && !phase.seen && ["commanded", "in_force", "superseded"].includes(view.key)) {
      setPhase({ ...phase, seen: true, writeAt: st?.last_write_at ?? null });
    }
  }, [phase, view.key, st]);

  const waiting = ["verifying", "commanded", "sending", "expired_unrestored", "stale"].includes(view.key);
  useEffect(() => {
    loadStatus();
    loadHub();
    const a = setInterval(() => loadStatus(), waiting ? FAST_MS : SLOW_MS);
    const b = setInterval(() => loadHub(), SLOW_MS);
    return () => { clearInterval(a); clearInterval(b); };
  }, [loadStatus, loadHub, waiting]);

  const send = useCallback(async (target_f: number, minutes: number, title: string, extra?: string) => {
    const req: BoostRequest = boostBody(target_f, minutes);
    const warn = preflight(req, stRef.current, hubRef.current, Date.now() / 1000);
    const ok = await confirm({
      title,
      body: confirmText(req, Date.now()) + (extra ? `\n\n${extra}` : "") + (warn.length ? `\n\nBefore you send:\n• ${warn.join("\n• ")}` : ""),
      confirmLabel: "Send to planner",
    });
    if (!ok) return;
    setPhase({ phase: "sending", req });
    try {
      const res = await fetch("/api/planner/boost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(30_000),
      });
      const out: { error?: string; detail?: string; boost_restore_at?: string } = await res.json().catch(() => ({}));
      if (!res.ok) setPhase({ phase: "rejected", req, status: res.status, error: out.error || out.detail || "" });
      else setPhase({ phase: "accepted", req, atMs: Date.now(), restoreAt: typeof out.boost_restore_at === "string" ? out.boost_restore_at : null });
    } catch {
      setPhase({ phase: "rejected", req, status: 0, error: "network error — the request may not have reached the planner; check the writer status before retrying" });
    } finally {
      loadStatus(true);
      loadHub(true);
    }
  }, [confirm, loadStatus, loadHub]);

  const pumps = pumpsLine(hub, nowMs / 1000, hubErr || undefined);
  const busy = phase.phase === "sending";
  return { send, view, st, stErr, pumps, busy, Modals, nowMs };
}
