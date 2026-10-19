"use client";
// @purpose Control-page card for remote SPAN breaker control (owner decision 2026-10-18): the
// allowlisted circuits with their live relay state + watts (the bridge's span snapshot, relayed
// in the hub state this page already polls), per-circuit Power cycle 60 s / On / Off where the
// bridge allows it, a confirm modal, and the same password re-entry (arm) as write-mode. The
// success line comes only from the bridge's verified panel read-back (lib/breaker-state.ts).
import { useState } from "react";
import { useModals } from "../ui/modal";
import {
  circuitRows, confirmText, outcomeMessage,
  type BreakerAction, type Outcome, type SpanSnapshot,
} from "@/lib/breaker-state";

const TONE: Record<Outcome["tone"], string> = { ok: "var(--ok)", warn: "var(--warm)", bad: "var(--crit)" };

export function SpanBreakerCard({ span, connected, armed, onArm, onDone }: {
  span: SpanSnapshot | null | undefined;
  connected: boolean;
  armed: boolean;
  onArm: () => void;
  onDone: () => void;
}) {
  const { confirm, Modals } = useModals();
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const rows = circuitRows(span, { connected, armed, nowSec: Date.now() / 1000 });

  async function act(circuit: string, action: BreakerAction) {
    const c = confirmText(circuit, action);
    if (!(await confirm({ title: c.title, body: c.body, danger: action !== "close" }))) return;
    setSending(`${circuit}:${action}`);
    setOutcome({ tone: "warn", text: action === "power_cycle"
      ? `Power-cycling ${circuit} — waiting for the panel read-back (about a minute)…`
      : `Switching ${circuit} — waiting for the panel read-back…` });
    try {
      const res = await fetch("/api/hub/breaker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit, action }),
      });
      const body = await res.json().catch(() => null);
      setOutcome(outcomeMessage(res.status, body, { circuit, action }));
    } catch {
      setOutcome({ tone: "warn", text: "Network error — the action may still complete on the Pi. Watch the live state." });
    } finally {
      setSending(null);
      onDone();
    }
  }

  return (
    <div className="cards" style={{ marginTop: 4 }}>
      {Modals}
      <div className="card">
        <h2>
          SPAN breakers
          <span className={`chip ${span ? "ok" : "off"}`}>{span ? "local panel" : "no data"}</span>
        </h2>
        <div className="meta" style={{ marginBottom: 8 }}>
          The SPAN app&apos;s cloud path can&apos;t switch these circuits right now (a toggle in the app
          never reaches the panel). This card goes dashboard → hub → Pi → the panel&apos;s local API instead.
        </div>
        {rows.length === 0 ? (
          <div className="meta">
            {connected
              ? "No SPAN data from the bridge — it needs the breaker-control release, with SPAN local configured."
              : "Pi offline — no live breaker state."}
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.name} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
                                       padding: "6px 0", borderTop: "1px solid var(--border, #333)" }}>
              <b style={{ minWidth: 110 }}>{r.name}</b>
              <span className={`chip ${r.state === "on" ? "ok" : r.state === "off" ? "off" : "warn"}`}>{r.stateLabel}</span>
              <span className="meta" style={{ minWidth: 60 }}>{r.watts}</span>
              <span style={{ display: "inline-flex", gap: 6, marginLeft: "auto" }}>
                {r.buttons.map((b) => (
                  <button
                    key={b.action}
                    type="button"
                    disabled={!b.enabled || sending != null}
                    title={b.reason ?? undefined}
                    onClick={() => act(r.name, b.action)}
                    style={{ fontSize: 12, padding: "5px 10px" }}
                  >
                    {sending === `${r.name}:${b.action}` ? "…" : b.label}
                  </button>
                ))}
              </span>
              {r.note ? <div className="meta" style={{ flexBasis: "100%", color: "var(--warm)" }}>{r.note}</div> : null}
            </div>
          ))
        )}
        <div className="meta" style={{ marginTop: 8 }}>
          {armed ? null : (
            <>
              Switching needs the password again.{" "}
              <button type="button" onClick={onArm} style={{ fontSize: 12, padding: "3px 8px" }}>🔒 Arm</button>
              <br />
            </>
          )}
          Power cycle = off 60 s, then on; the bridge turns the circuit back on even if this page closes, and
          refuses if the other heat pump isn&apos;t on. The backup element (Buffer Tank) can only be turned on here.
          {outcome ? (<><br /><span style={{ color: TONE[outcome.tone] }}>{outcome.text}</span></>) : null}
        </div>
      </div>
    </div>
  );
}
