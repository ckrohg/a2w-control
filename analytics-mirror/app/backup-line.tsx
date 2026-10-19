"use client";
// @purpose Home backup-element line (#184), client side so its freshness keeps moving while the page
// stays open (Codex pass 2): the server passes the raw SPAN relay / Buffer Tank sample and the 7-day
// call count; lib/backup-state.ts maps them against a clock that ticks here, so a CLOSED sample that
// ages past 15 min turns "unknown" without a reload. <AutoRefresh/> re-fetches the samples themselves.
import { useEffect, useState } from "react";
import { backupView, type BackupInputs } from "@/lib/backup-state";

export function useNowS(initialS: number, everyMs = 15_000): number {
  const [now, setNow] = useState(initialS);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export function BackupLine({ inputs }: { inputs: BackupInputs }) {
  const nowS = useNowS(inputs.nowS);
  const v = backupView({ ...inputs, nowS });
  return (
    <div className="meta" style={{ marginTop: 4 }}>
      <span className={`chip ${v.tone === "red" ? "offline" : v.tone === "amber" ? "warn" : ""}`} style={{ marginRight: 6 }}>
        {v.chip}
      </span>
      <span style={{ color: v.tone === "red" ? "var(--crit)" : undefined }}>{v.headline}</span>
      <div style={{ marginTop: 2 }}>{v.calledLine}</div>
    </div>
  );
}

/** The top-row alert chip, on the same ticking clock: red only while a FRESH sample says OPEN. */
export function BackupChip({ inputs }: { inputs: BackupInputs }) {
  const nowS = useNowS(inputs.nowS);
  const v = backupView({ ...inputs, nowS });
  if (v.tone === "red") return <span className="chip offline">backup element unavailable (breaker OPEN)</span>;
  // it was red at render and has aged out — say unknown rather than drop to silence
  if (backupView(inputs).tone === "red") return <span className="chip warn">backup element state unknown</span>;
  return null;
}
