"use client";
// @purpose Optimize page client — the interim, SUMMER-ONLY, caution-first savings
// recommendation. Polls /api/planner/target (same shape the Control page's HbxTargetCard
// uses) and offers a SINGLE guarded write: lower the HBX tank target to a safe floor of
// 131°F. 131 is always ≥ the daily Legionella sanitize threshold (so no separate sanitize
// automation is needed), ~22°F cooler than today's ~150–155°F (most of the summer COP win),
// and one reversible write that leaves pump setpoints unchanged. The apply/restore go through
// the SAME planner guardrails (I4 envelope, I1 pump-setpoint cross-check, rate limit,
// read-back, audit) — this card only asks and reports. Winter is gated out: a static cool
// tank would underheat the rooms, so the demand-based auto-pilot handles that season.
import { useCallback, useEffect, useState } from "react";

const COP_SENS_PER_F = 0.01; // ~1%/°F — rough; A-4 measures the real slope

const SAFE_FLOOR_F = 131; // ≥ daily sanitize threshold → no separate sanitize automation needed
const DEEPER_CUT_F = 120; // "coming next" — needs the narrow daily-131 auto-sanitize + setpoint trim
const WINTER_CUTOFF_F = 50; // below this outdoor temp, a static cool tank would underheat the rooms

type HbxStatus = {
  tank_f: number | null;
  target_f: number | null;
  outdoor_f: number | null;
  band: { lo: number; hi: number } | null;
  curve_overridden: boolean;
  baseline: { dbt: number; mbt: number } | null;
  last_write_at: string | null;
  i1_margin_f: number;
  active_boost?: { target_f: number; restore_at: string } | null;
  error?: string;
};

export default function OptimizeClient({ rate, dailyKwh }: { rate: number; dailyKwh: number }) {
  // rough monthly savings for a given °F drop below today's target (same math as Savings)
  const savedPerMonth = (dropF: number) =>
    Math.max(0, dropF) * COP_SENS_PER_F * dailyKwh * rate * 30;
  const [st, setSt] = useState<HbxStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/target", { cache: "no-store" });
      const body: HbxStatus = await res.json().catch(() => ({}) as HbxStatus);
      if (res.ok) {
        setSt(body);
      } else {
        setSt(null);
        setMsg(body.error || `Planner error (${res.status}).`);
      }
    } catch {
      setMsg("Could not reach the dashboard server.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Single guarded write / restore — reports the accepted/rejected result exactly like
  // HbxTargetCard's act(). window.confirm gate per spec.
  async function act(path: string, body: unknown | undefined, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const out: { ok?: boolean; detail?: string; error?: string } = await res
        .json()
        .catch(() => ({}));
      setMsg(res.ok ? `${out.detail || "Done"} ✓` : `Rejected: ${out.error || out.detail || res.status}`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!loaded && !st) return <div className="empty">Loading…</div>;
  if (!st) return <div className="empty">{msg || "Planner status unavailable."}</div>;

  const outdoor = st.outdoor_f;
  // Cautious gate: only offer the cooler-tank apply when we can CONFIRM it's summer — outdoor
  // known AND ≥ cutoff. Winter would underheat rooms; an unknown outdoor must not be risked.
  const canApply = outdoor != null && outdoor >= WINTER_CUTOFF_F;
  if (!canApply) {
    return (
      <div className="cards" style={{ marginTop: 4 }}>
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>
            {outdoor == null ? "Confirming season…" : "Winter mode"}
            <span className="chip warn">summer-only tool</span>
          </h2>
          <div className="meta">
            {outdoor == null
              ? "Waiting for an outdoor reading to confirm it's summer — this cooler-tank tool is summer-only and won't offer to apply until the season is confirmed."
              : `A static cool tank would underheat your rooms. The demand-based auto-pilot (with TempIQ) handles winter; this interim tool is summer-only. Outdoor is currently ${Math.round(outdoor)}°F.`}
          </div>
        </div>
      </div>
    );
  }

  const target = st.target_f;
  const dropF = target == null ? 0 : Math.max(0, target - SAFE_FLOOR_F);
  const savedUsd = savedPerMonth(dropF);
  // The deeper cut's *extra* over the 131 floor (today's target → 120 minus today's target → 131).
  const extraUsd = target == null ? 0 : Math.max(0, savedPerMonth(target - DEEPER_CUT_F) - savedUsd);

  const alreadyApplied = st.curve_overridden && target === SAFE_FLOOR_F;

  return (
    <div className="cards" style={{ marginTop: 4 }}>
      {/* Recommended summer setting */}
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <h2>
          Recommended summer setting
          <span className={`chip ${alreadyApplied ? "ok" : "warn"}`}>
            {alreadyApplied ? "applied" : "rough estimate"}
          </span>
        </h2>
        <div className="temps">
          <div className="temp">
            <div className="v">{target == null ? "—" : `${Math.round(target)}°`}</div>
            <div className="l">Current target</div>
          </div>
          <div className="temp">
            <div className="v">{SAFE_FLOOR_F}°</div>
            <div className="l">Recommended</div>
          </div>
          <div className="temp">
            <div className="v">{target == null ? "—" : `−${Math.round(dropF)}°`}</div>
            <div className="l">°F cooler</div>
          </div>
          <div className="temp">
            <div className="v">{`≈ $${savedUsd.toFixed(0)}`}</div>
            <div className="l">/ month (rough)</div>
          </div>
        </div>
        <div className="meta">
          Lowering the tank to <b>{SAFE_FLOOR_F}°F</b> runs it about {Math.round(dropF)}°F cooler
          than today — cooler water means a higher COP, so the same hot water costs less. Rough
          estimate: {Math.round(dropF)}°F × 1%/°F × {dailyKwh} kWh/day × ${rate.toFixed(2)}/kWh × 30
          ≈ <b>${savedUsd.toFixed(0)}/mo</b>.{" "}
          <a href="/curve" style={{ color: "#4dabf7" }}>Full breakdown on the Curve →</a>{" "}
          <a href="/savings" style={{ color: "#4dabf7" }}>$ detail on Savings →</a>
        </div>
        <div className="meta">
          {SAFE_FLOOR_F}°F stays hot enough for the daily sanitize automatically · keeps your pump
          setpoints unchanged · fully reversible (Restore curve) · applied through the same I4/I1
          guardrails.
        </div>
        <div className="temps" style={{ alignItems: "center", marginTop: 10 }}>
          <button
            type="button"
            disabled={busy || alreadyApplied}
            onClick={() =>
              act(
                "/api/planner/target",
                { target_f: SAFE_FLOOR_F },
                `Set the HBX tank target to ${SAFE_FLOOR_F}°F? This runs the tank ~22°F cooler while staying sanitized. Reversible via Restore curve. Pump setpoints must stay ≥${SAFE_FLOOR_F + st.i1_margin_f}°F, which is checked.`,
              )
            }
            style={{ flex: "0 0 auto" }}
          >
            {alreadyApplied ? "Already applied ✓" : busy ? "…" : `Apply — set tank target to ${SAFE_FLOOR_F}°F`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(
                "/api/planner/restore",
                undefined,
                `Restore the as-found curve${st.baseline ? ` (${st.baseline.dbt}/${st.baseline.mbt}°F)` : ""}? This undoes the cooler-tank setting.`,
              )
            }
            style={{ flex: "0 0 auto" }}
          >
            Restore as-found curve
          </button>
        </div>
        {msg ? (
          <div className="meta">
            <span style={{ color: "var(--text)" }}>{msg}</span>
          </div>
        ) : null}
      </div>

      {/* Preview: the deeper cut — disabled, coming next */}
      <div className="card" style={{ gridColumn: "1 / -1", opacity: 0.7 }}>
        <h2>
          Deeper cut — {DEEPER_CUT_F}°F
          <span className="chip">coming next</span>
        </h2>
        <div className="temps">
          <div className="temp">
            <div className="v">{DEEPER_CUT_F}°</div>
            <div className="l">Target</div>
          </div>
          <div className="temp">
            <div className="v">{`≈ +$${extraUsd.toFixed(0)}`}</div>
            <div className="l">more / month</div>
          </div>
        </div>
        <div className="meta">
          Needs the narrow daily-131°F auto-sanitize (coming next) so the cooler tank stays safe,
          plus a small pump-setpoint trim. Guided apply lands with that automation.
        </div>
        <div className="temps" style={{ alignItems: "center", marginTop: 10 }}>
          <button type="button" disabled style={{ flex: "0 0 auto" }}>
            Apply — coming next
          </button>
        </div>
      </div>
    </div>
  );
}
