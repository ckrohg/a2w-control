// @purpose Backup-element gate card (owner rule 2026-10-19): whether A2W would make the 16.5 kW element available — a
// pump failed and the rest can't hold the tank, or every pump runs and the tank stays under the floor — with the REAL
// Buffer Tank breaker beside it. Server component; reads the planner's /health.backup_gate. In SHADOW the gate's state
// is virtual (nothing is switched), and the card says so in words, so it is never mistaken for the panel.
import { fetchPlannerBackupGate } from "@/lib/planner-health";
import { backupGateView, gateChip, generatorLine, relayLine } from "@/lib/backup-gate";
import { fmtDateTime } from "@/lib/tz";

const f1 = (v: number | null) => (v == null ? "—" : v.toFixed(1));

export async function BackupGateCard() {
  const { backupGate, error } = await fetchPlannerBackupGate();
  const v = backupGateView(backupGate);
  const chip = gateChip(v);
  if (!v.available) {
    return (
      <div className="card">
        <h2>Backup element gate<span className={`chip ${chip.cls}`}>{chip.text}</span></h2>
        <div className="meta">{error ?? "the planner did not report the backup gate"}</div>
      </div>
    );
  }
  const c = v.conditions;
  return (
    <div className="card">
      <h2>Backup element gate<span className={`chip ${chip.cls}`}>{chip.text}</span></h2>
      <div className="meta">{relayLine(v)}</div>
      <div className="meta">
        {v.mode === "shadow"
          ? "SHADOW: A2W logs and pages what it would do and switches nothing."
          : v.mode === "live"
            ? `LIVE: A2W closes the breaker on a real failure${v.reopenEnabled ? " and re-opens it once recovered" : "; re-opening is disabled"}.`
            : "Off."}
        {v.gateState === "closed" && v.virtual ? " Right now it WOULD have the element available." : ""}
      </div>
      {v.blind ? <div className="meta">Not judged this poll: {v.blind}</div> : (
        <div className="meta">
          Tank {f1(c.tankF)}° / target {f1(c.targetF)}° · {c.riseF == null ? "rise —" : `${c.riseF >= 0 ? "+" : ""}${c.riseF.toFixed(1)}° in 20 min`}
          {" · "}HBX {c.called ? "calling" : c.called === false ? "not calling" : "—"}
          {c.failed.length ? ` · failed: ${c.failed.join(", ")}` : " · no pump failed"}
        </div>
      )}
      {v.clocks.filter((k) => k.min > 0).map((k) => (
        <div className="meta" key={k.label} style={{ color: "var(--warm)" }}>⏱ {k.label}: {Math.round(k.min)} of {k.of} min</div>
      ))}
      {v.generator ? (
        <div className="meta" style={v.generator.supply !== "grid" ? { color: "var(--warm)" } : undefined}>
          ⚡ {generatorLine(v.generator)}
          {v.generator.lockout ? ` Would close now, but: ${v.generator.lockout}.` : ""}
          {v.generator.shed ? " The breaker is ON without headroom — A2W does not switch it off; shed a load or switch it off by hand." : ""}
          {v.generator.onePump ? " Both pumps run near the cap: would hold to one pump." : ""}
        </div>
      ) : null}
      {v.lastEvent ? <div className="meta">Last: {v.lastEvent.title} ({fmtDateTime(new Date(v.lastEvent.at))})</div> : null}
      {v.overrideUntil ? <div className="meta">Standing down after a manual switch-off until {fmtDateTime(new Date(v.overrideUntil))}.</div> : null}
      {v.piFallback ? (
        <div className="meta">
          Pi fallback ({v.piFallback.mode}, no cloud): {v.piFallback.allDownMin != null
            ? `every pump down ${Math.round(v.piFallback.allDownMin)} of ${v.piFallback.holdMin ?? 30} min`
            : v.piFallback.down.length ? `down: ${v.piFallback.down.join("; ")}` : "all pumps up"}
          {v.piFallback.last ? ` · last: ${v.piFallback.last}` : ""}
        </div>
      ) : null}
      <div className="meta" style={{ marginTop: 6 }}>
        Closes when a pump has failed and the tank sits {v.deficitF ?? 10}°+ below target without recovering for {v.failHoldMin ?? 90} min, or every
        available pump runs and the tank stays under {v.floorF ?? 100}°F for {v.floorHoldMin ?? 30} min.
        {v.episodes7d != null ? ` ${v.episodes7d} episode${v.episodes7d === 1 ? "" : "s"} in 7 days.` : ""}
        {v.error ? ` Error: ${v.error}` : ""}
      </div>
    </div>
  );
}
