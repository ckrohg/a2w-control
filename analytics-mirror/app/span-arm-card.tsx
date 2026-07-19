"use client";
// @purpose Portal card for the backup-element ARM (spec: span-backup-arm). Shows the live element
// relay state + A2W's arm intent + the recent SHADOW "would-arm" decisions, and a one-tap toggle to
// arm/disarm A2W. Phase 1 = shadow: nothing is toggled on SPAN; this only controls whether A2W *would*.
import { useState } from "react";

export type ArmState = {
  circuit: string | null; relay_state: string | null; armed: boolean | null;
  live: boolean | null; desired_armed: boolean | null; ts: number | null;
};
export type ArmEvent = {
  ts: number; relay_state: string | null; armed: boolean; live: boolean; action: string; detail: string | null;
};

export function SpanArmCard({ state, events }: { state: ArmState | null; events: ArmEvent[] }) {
  const [pending, setPending] = useState(false);
  const [desired, setDesired] = useState<boolean | null>(state?.desired_armed ?? state?.armed ?? false);
  const armed = desired ?? false;
  const relayOpen = state?.relay_state === "OPEN";
  const live = !!state?.live;

  async function toggle(next: boolean) {
    setPending(true);
    try {
      const r = await fetch("/api/span-arm", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ armed: next }),
      });
      if (r.ok) setDesired(next);
    } finally { setPending(false); }
  }

  return (
    <div className="chart-block">
      <h3>
        Backup element — A2W arm{" "}
        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: live ? "#c0392b" : "#555" }}>
          {live ? "LIVE" : "SHADOW"}
        </span>
      </h3>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
        <span>Element (SPAN “Buffer Tank”): <b style={{ color: relayOpen ? "#e67e22" : "#2ecc71" }}>
          {state?.relay_state == null ? "—" : relayOpen ? "OFF (unavailable)" : "available"}</b></span>
        <span>A2W: <b style={{ color: armed ? "#4dabf7" : "#888" }}>{armed ? "ARMED" : "DISARMED"}</b></span>
        <button
          disabled={pending}
          onClick={() => toggle(!armed)}
          style={{ padding: "6px 12px", borderRadius: 6, cursor: pending ? "wait" : "pointer",
                   background: armed ? "#444" : "#2f6f4f", color: "#fff", border: "none" }}>
          {pending ? "…" : armed ? "Disarm A2W (keep element off)" : "Arm A2W (turn on if left off)"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 6 }}>
        {live
          ? "A2W will CLOSE the element relay (make it available) when armed + it’s found off. It can never open it."
          : "Shadow: A2W only logs what it WOULD do — nothing on SPAN is toggled. Arm/disarm to test the switch."}
      </div>
      {events.length > 0 && (
        <div className="legend" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
          <b style={{ fontSize: 12 }}>Recent “would-arm” decisions:</b>
          {events.slice(0, 6).map((e, i) => (
            <span key={i} style={{ fontSize: 12 }}>
              {new Date(e.ts * 1000).toLocaleString()} — <b>{e.action}</b>{e.live ? " (LIVE)" : " (shadow)"}
              {e.detail ? ` · ${e.detail}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
