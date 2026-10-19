"use client";
// @purpose Home "Heat now" card (#186): one tap → boost the tank to the everyday cap (strictCapF,
// 135 °F) through the same guarded /api/planner/boost route and read-back as the Optimize boost card
// (app/ui/use-boost.tsx). It claims nothing beyond what the writer status shows, and it lists plainly
// what it CANNOT do yet — the owner decisions on #175 (stage 1, element breaker, power cycle).
import { useState } from "react";
import { useBoost } from "./ui/use-boost";
import { BOOST_MAX_MINUTES, STRICT_CAP_F, estimateLines } from "@/lib/boost-state";

// 1–4 h was asked for; the planner refuses a boost over 120 min (writes.ts boost()), so 3 h and 4 h
// render disabled until the planner allows a longer boost.
const HOURS = [1, 2, 3, 4];

export function HeatNow() {
  const b = useBoost();
  const [hours, setHours] = useState(2);
  const ab = b.st?.active_boost ?? null;
  const tone = b.view.tone === "ok" ? "var(--ok, #4bbd77)" : b.view.tone === "bad" ? "var(--crit)" : b.view.tone === "pending" ? "#e0b24d" : undefined;
  const go = () => {
    const e = estimateLines(b.st?.tank_f ?? null, STRICT_CAP_F);
    b.send(STRICT_CAP_F, hours * 60, `Heat now: boost the tank to ${STRICT_CAP_F} °F for ${hours} h?`,
      `Hot water ${e.now}.\nHot water ${e.ifCompletes}.\n\nThis does NOT call stage 1, close the element breaker or power-cycle a faulted pump.`);
  };
  return (
    <div className="card">
      <h2>Heat now<span className="chip">tank boost</span></h2>
      <div className="meta" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {HOURS.map((h) => {
          const allowed = h * 60 <= BOOST_MAX_MINUTES;
          return (
            <button key={h} type="button" aria-pressed={hours === h} disabled={!allowed || b.busy || !!ab}
              title={allowed ? undefined : `The planner caps a boost at ${BOOST_MAX_MINUTES / 60} h — not available yet`}
              onClick={() => setHours(h)}
              style={{ flex: "0 0 auto", opacity: allowed ? 1 : 0.45, borderColor: hours === h ? "#e0b24d" : undefined }}>
              {h} h{allowed ? "" : " (soon)"}
            </button>
          );
        })}
        <button type="button" disabled={b.busy || !!ab} onClick={go} style={{ flex: "0 0 auto", fontWeight: 600 }}>
          {b.busy ? "…" : `Boost to ${STRICT_CAP_F}° for ${hours} h`}
        </button>
      </div>
      <div className="meta" role="status" style={{ marginTop: 6, color: tone }}>
        {b.st || b.view.key !== "idle" ? b.view.text : b.stErr ? `writer status unavailable (${b.stErr})` : "reading writer status…"}
      </div>
      <div className="meta">Pumps: {b.pumps}</div>
      <div className="meta">Hot water {estimateLines(b.st?.tank_f ?? null, STRICT_CAP_F).now}</div>
      <div className="meta" style={{ marginTop: 6 }}>
        What this cannot do yet: <b>call stage 1</b> (the HBX decides staging), <b>close the element
        breaker</b> (the SPAN arm is shadow-only), or <b>power-cycle a faulted unit</b>. Those are the owner
        decisions on{" "}
        <a href="https://github.com/ckrohg/a2w-control/issues/175" style={{ color: "#4dabf7" }} target="_blank" rel="noreferrer">#175</a>.
        3–4 h boosts need a planner change (it caps a boost at {BOOST_MAX_MINUTES / 60} h).
      </div>
      {b.Modals}
    </div>
  );
}
