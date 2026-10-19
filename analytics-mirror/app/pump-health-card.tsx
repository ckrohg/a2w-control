// @purpose Pump-health card (owner ask 2026-10-19): per pump, the "running but not doing its job" checks the planner runs
// with no fault code (running_no_lift, heating_no_draw, idle_draw, defrost_overlong, called_tank_flat) and yesterday's
// SPAN-metered rollup with its 7-day drift. Server component; reads the planner's /health.pump_health. The checks are
// SHADOW until the owner promotes one (PUMP_HEALTH_LIVE) — the card says so, so a flag here is never mistaken for a page.
import { fetchPlannerPumpHealth } from "@/lib/planner-health";
import { pumpHealthView, pumpChip, CHECK_LABELS } from "@/lib/pump-health";

const f1 = (v: number | null, d = 1) => (v == null ? "—" : v.toFixed(d));

export async function PumpHealthCard() {
  const { pumpHealth, error } = await fetchPlannerPumpHealth();
  const v = pumpHealthView(pumpHealth);
  if (!v.available) {
    return (
      <div className="card">
        <h2>Pump health<span className="chip offline">unavailable</span></h2>
        <div className="meta">{error ?? "the planner did not report pump health"}</div>
      </div>
    );
  }
  const shadow = Object.keys(CHECK_LABELS).filter((c) => !v.liveChecks.includes(c));
  return (
    <div className="card">
      <h2>Pump health<span className="chip">{v.liveChecks.length ? `${v.liveChecks.length} live` : "shadow"}</span></h2>
      {v.gate ? <div className="meta">Not evaluated this poll: {v.gate}</div> : null}
      {v.pumps.map((p) => {
        const chip = pumpChip(p, v.gate);
        return (
          <div key={p.id} style={{ marginTop: 8 }}>
            <div><b>{p.id}</b> <span className={`chip ${chip.cls}`}>{chip.text}</span></div>
            {p.tripped.map((c) => (
              <div className="meta" key={c.check} style={{ color: "var(--warm)" }}>
                ⚠ {c.label}{v.liveChecks.includes(c.check) ? "" : " (shadow)"} — {c.reason}
              </div>
            ))}
            {p.day ? (
              <div className="meta">
                {v.throughDay}: {f1(p.day.kwh)} kWh · {f1(p.day.run_h)} h run · {p.day.starts ?? "—"} starts · {p.day.defrosts ?? "—"} defrosts
                ({f1(p.day.defrost_min, 0)} min) · ΔT {f1(p.day.mean_dt_c)} °C · lift {f1(p.day.lift_index, 2)}
                {p.day.drift_pct != null ? ` · 7-d ${p.day.drift_pct > 0 ? "+" : ""}${p.day.drift_pct}% @ ${p.day.drift_bin} °C` : " · 7-d trend building"}
              </div>
            ) : <div className="meta">no daily rollup yet</div>}
          </div>
        );
      })}
      {v.twin ? <div className="meta" style={{ marginTop: 6 }}>Twin ratio vs baseline: {v.twin.pct > 0 ? "+" : ""}{v.twin.pct}% @ {v.twin.bin} °C{v.twin.flag ? " ⚠" : ""}</div> : null}
      <div className="meta" style={{ marginTop: 6 }}>
        {shadow.length ? `Shadow (logged + daily digest, no pages): ${shadow.map((c) => CHECK_LABELS[c]).join(", ")}.` : "All checks page."}
        {v.error ? ` Error: ${v.error}` : ""}
      </div>
    </div>
  );
}
