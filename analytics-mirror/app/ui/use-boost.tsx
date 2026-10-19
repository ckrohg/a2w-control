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

export function useBoost() {
  const { confirm, Modals } = useModals();
  const [phase, setPhase] = useState<BoostPhase>({ phase: "idle" });
  const [st, setSt] = useState<WriterStatus | null>(null);
  const [stErr, setStErr] = useState("");
  const [hub, setHub] = useState<HubState | null>(null);
  const [hubErr, setHubErr] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stRef = useRef<WriterStatus | null>(null);
  const hubRef = useRef<HubState | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/target", { cache: "no-store" });
      const body: WriterStatus & { error?: string } = await res.json().catch(() => ({}) as WriterStatus);
      if (res.ok) { setSt(body); stRef.current = body; setStErr(""); }
      else { setSt(null); stRef.current = null; setStErr(body.error || `planner error (${res.status})`); }
    } catch {
      setSt(null); stRef.current = null; setStErr("could not reach the dashboard server");
    } finally {
      setNowMs(Date.now());
    }
  }, []);

  const loadHub = useCallback(async () => {
    try {
      const res = await fetch("/api/hub/state", { cache: "no-store" });
      const body: HubState & { error?: string } = await res.json().catch(() => ({}) as HubState);
      if (res.ok) { setHub(body); hubRef.current = body; setHubErr(""); }
      else { setHub(null); hubRef.current = null; setHubErr(body.error || `hub error (${res.status})`); }
    } catch {
      setHub(null); hubRef.current = null; setHubErr("could not reach the dashboard server");
    }
  }, []);

  const view = useMemo(() => boostView(phase, st, nowMs), [phase, st, nowMs]);

  // Remember that the read-back showed this boost, so its later disappearance reads as "ended",
  // never as "unconfirmed".
  useEffect(() => {
    if (phase.phase === "accepted" && !phase.seen && ["commanded", "in_force", "superseded"].includes(view.key)) {
      setPhase({ ...phase, seen: true });
    }
  }, [phase, view.key]);

  const waiting = view.key === "verifying" || view.key === "commanded" || view.key === "sending";
  useEffect(() => {
    loadStatus();
    loadHub();
    const a = setInterval(loadStatus, waiting ? FAST_MS : SLOW_MS);
    const b = setInterval(loadHub, SLOW_MS);
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
      });
      const out: { error?: string; detail?: string; boost_restore_at?: string } = await res.json().catch(() => ({}));
      if (!res.ok) setPhase({ phase: "rejected", req, status: res.status, error: out.error || out.detail || "" });
      else setPhase({ phase: "accepted", req, atMs: Date.now(), restoreAt: typeof out.boost_restore_at === "string" ? out.boost_restore_at : null });
    } catch {
      setPhase({ phase: "rejected", req, status: 0, error: "network error — the request may not have reached the planner; check the writer status before retrying" });
    } finally {
      loadStatus();
      loadHub();
    }
  }, [confirm, loadStatus, loadHub]);

  const pumps = pumpsLine(hub, nowMs / 1000, hubErr || undefined);
  const busy = phase.phase === "sending";
  return { send, view, st, stErr, pumps, busy, Modals, nowMs };
}
