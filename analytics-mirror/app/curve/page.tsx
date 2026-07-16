// @purpose /curve — the base-system EFFICIENCY MAP in one view: a curve-space hero chart
// (outdoor °F × tank °F) whose background is the modeled heat-pump COP at every tank/outdoor
// pair, with the COP=1 crossover drawn bold in red (below it the tank's own resistive backup
// element is the cheaper way to make the same hot water). The historical operating cloud, the
// as-found HBX curve, and the summer/DHW-only permission band are overlaid to tell the
// before/after story; the live point shows where the tank sits now. The hour-by-hour plan
// (per-block targets + reasons) has MOVED to the Plan/Optimize tab — no plan overlays here.
// Below the hero: the COP receipt (measured tank-calorimetry vs the same model at planner
// targets) and the season kWh/$ + temperature strips. Before-era data is a static extract
// (lib/curve-history.json, dev-time script) — the dashboard has NO runtime dependency on
// TempIQ. Live overlays come from Neon. Honesty per the net-accounting doctrine: measured
// (SPAN, cop_measurements) vs model (COP surface, counterfactuals) is labeled on every number.
import { sql } from "@vercel/postgres";
import { I1Banner } from "../i1-banner";
import { StormBanner } from "../storm-banner";
import historyJson from "@/lib/curve-history.json";

// explicit shape (per-day kwh key sets vary, which trips JSON literal inference)
type Daily = {
  d: string; out: number; out_lo: number; out_hi: number; tank: number; tgt: number | null;
  kwh: Partial<Record<"aw1" | "aw2" | "element" | "circ" | "glycol", number>>;
  cop_af: number; cop_cur: number; cop_pot: number; tgt_cur: number; tgt_pot: number;
};
type ReceiptRow = {
  o: number; measured_v1?: number; n_v1?: number; measured_v3?: number; n_v3?: number;
  af?: number; cur?: number; pot?: number;
};
type CurveHistory = {
  meta: {
    extracted_at: string; era: { from: string; to: string }; hours: number;
    rate_usd_kwh: number; eta_base: number;
    asfound: {
      cfg: { dot: number; dbt: number; wwsd: number; mbt: number };
      mined_fit: { a: number; b: number; sigma: number };
      hp1_setpoint_f: number; hp2_setpoint_f: number;
    };
    opts: { dhwWindows: number[][]; dhwFloorF: number; idleF: number; i1MarginF: number; winterGuardF: number; sanitizeF: number; strictCapF: number };
    totals_kwh: Record<string, number>;
    estimates: { hp_kwh_measured: number; cur_kwh_saved: number; pot_kwh_saved: number; cur_usd_saved: number; pot_usd_saved: number };
    cop: { v1_n: number; v1_median: number | null; v3_n: number; v3_median_mild: number | null; v3_median_warm: number | null };
    mfr_ratings_w75: { o: number; cop: number }[];
    notes: string[];
  };
  bins_tank: number[][]; bins_target: number[][];
  daily: Daily[];
  cop_points: { o: number | null; cop: number; sink: number | null; v: number | null }[];
  receipt: ReceiptRow[];
};
const history = historyJson as unknown as CurveHistory;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // parameterless sql = cacheable fetch bodies (see home page note)

// ---- model, mirrored from planner/src/shadow.ts + TempIQ zone-cop-calculator --------
const CFG = history.meta.asfound.cfg; // as-found HBX reset curve (frozen era)
const ETA_BASE = history.meta.eta_base;
const STRICT_CAP = history.meta.opts.strictCapF;

const curveF = (o: number) => {
  const t = CFG.dbt + ((o - CFG.dot) * (CFG.mbt - CFG.dbt)) / (CFG.wwsd - CFG.dot);
  return Math.max(Math.min(t, Math.max(CFG.dbt, CFG.mbt)), Math.min(CFG.dbt, CFG.mbt));
};
const loF = (o: number) => 95 + ((55 - Math.min(Math.max(o, 5), 55)) / 50) * 40;
const hiF = (o: number) => Math.max(Math.min(curveF(o) + 3, STRICT_CAP), loF(o));
/** n-weighted (by measured-hour count) model COP over a mild/warm outdoor bin — lets the
 *  receipt card show the MODELED "possible" COP at planner-cool tanks over the SAME weather
 *  the measurements sampled (mild <65°F, warm ≥65°F, matching the extractor's cop_summary). */
const nwCop = (key: "af" | "cur" | "pot", lo: number, hi: number) => {
  const rows = history.receipt.filter((r) => r.n_v3 && r.o >= lo && r.o < hi && r[key] != null);
  const w = rows.reduce((s, r) => s + (r.n_v3 as number), 0);
  return w ? Math.round((rows.reduce((s, r) => s + (r[key] as number) * (r.n_v3 as number), 0) / w) * 10) / 10 : null;
};

const fmtK = (n: number) => n.toLocaleString("en-US");

// ---- hero: curve space ---------------------------------------------------------------
// HX is the module-level outdoor domain the ReceiptChart + SeasonKwh share. The hero chart
// uses its OWN wider domain (HHX below) so the COP=1 crossover in deep cold is visible.
const HX = { min: 0, max: 105 };
const HY = { min: 88, max: 174 };
// Hero-local outdoor domain: extended to the cold so the COP=1 line is on-chart.
const HHX = { min: -15, max: 105 };

// ---- hero-local COP model (do NOT use for ReceiptChart/SeasonKwh — those keep the global
// model). This model reaches COP 1 in the visible range so the resistive-backup crossover
// reads. Carnot-style with an outdoor-indexed fraction of ideal. ---------------------------
const heroFrac = (o: number) =>
  o >= 45 ? 0.5 : o >= 0 ? 0.3 + (o / 45) * 0.2 : o >= -15 ? 0.22 + ((o + 15) / 15) * 0.08 : 0.22;
const heroCop = (o: number, w: number) => {
  const Tc = w + 10 + 459.67, Te = o - 12 + 459.67;
  return Math.max(0.4, Math.min(5, heroFrac(o) * (Tc / Math.max(Tc - Te, 1))));
};
// binary-search the tank temp where heroCop(o,w)=C (cop decreases as w rises); null if off-domain
const heroContourW = (C: number, o: number): number | null => {
  let lo = 88, hi = 185;
  if (heroCop(o, lo) < C || heroCop(o, hi) > C) return null;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (heroCop(o, m) > C) lo = m; else hi = m; }
  return (lo + hi) / 2;
};
const heroColor = (c: number) => { // desaturated green(cheap)→red(dear); calm wash
  const k = Math.max(0, Math.min(1, (c - 1) / (4.3 - 1)));
  return `hsl(${(8 + k * 114).toFixed(0)} 30% ${(20 + k * 13).toFixed(0)}%)`;
};

function CurveField({
  bins, live, now,
}: {
  bins: number[][];
  live: { x: number; y: number }[];
  now: { o: number; t: number } | null;
}) {
  const W = 900, H = 430, pad = { l: 44, r: 14, t: 14, b: 30 };
  // Hero uses its OWN wide domain (HHX) so the COP=1 crossover in deep cold is on-chart.
  // ReceiptChart/SeasonKwh keep the module-level HX — only this local X() uses HHX.
  const X = (o: number) => pad.l + ((o - HHX.min) / (HHX.max - HHX.min)) * (W - pad.l - pad.r);
  const Y = (t: number) => pad.t + (1 - (t - HY.min) / (HY.max - HY.min)) * (H - pad.t - pad.b);
  const clampY = (t: number) => Math.max(HY.min, Math.min(HY.max, t));
  const xs: number[] = [];
  for (let o = HHX.min; o <= HHX.max; o += 3) xs.push(o);

  // ---- COP EFFICIENCY FIELD (the star): coarse grid of cells shaded by heroCop ----------
  const CELL = 4; // ° step, both axes
  const field: { o: number; w: number; c: number }[] = [];
  for (let o = HHX.min; o < HHX.max; o += CELL)
    for (let w = HY.min; w < HY.max; w += CELL)
      field.push({ o: o + CELL / 2, w: w + CELL / 2, c: heroCop(o + CELL / 2, w + CELL / 2) });

  // ---- contours: faint 2/3/4, bold red COP 1 -------------------------------------------
  // sample o finely across HHX; drop points where the contour is null or off the tank axis
  const contourPath = (C: number) => {
    let d = "", pen = false;
    for (let o = HHX.min; o <= HHX.max; o += 1.5) {
      const w = heroContourW(C, o);
      if (w == null || w < HY.min || w > HY.max) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${X(o).toFixed(1)},${Y(w).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  // right-end label anchor for a faint contour (last on-chart point scanning from the right)
  const contourLabel = (C: number): { x: number; y: number } | null => {
    for (let o = HHX.max; o >= HHX.min; o -= 1) {
      const w = heroContourW(C, o);
      if (w != null && w >= HY.min + 3 && w <= HY.max - 3) return { x: X(o), y: Y(w) };
    }
    return null;
  };
  const faint = [2, 3, 4].map((c) => ({ c, d: contourPath(c), lbl: contourLabel(c) })).filter((k) => k.d);
  const cop1d = contourPath(1);
  // anchor the bold COP-1 label near the left/cold end of the line
  const cop1lbl = (() => {
    for (let o = HHX.min; o <= HHX.max; o += 1) {
      const w = heroContourW(1, o);
      if (w != null && w >= HY.min + 6 && w <= HY.max - 6) return { x: X(o), y: Y(w) };
    }
    return null;
  })();

  const maxN = Math.max(...bins.map((b) => b[2]));
  const envTop = xs.map((o) => `${X(o).toFixed(1)},${Y(hiF(o)).toFixed(1)}`);
  const envBot = xs.slice().reverse().map((o) => `${X(o).toFixed(1)},${Y(loF(o)).toFixed(1)}`);

  // on-chart annotation with a dark halo so it stays readable over any layer
  const Note = ({ x, y, anchor = "start", color = "#cfd8e3", size = 13, weight = 650, children }: {
    x: number; y: number; anchor?: "start" | "middle" | "end"; color?: string; size?: number; weight?: number; children: React.ReactNode;
  }) => (
    <text x={x} y={y} textAnchor={anchor} fill={color} fontSize={size} fontWeight={weight}
      paintOrder="stroke" stroke="#0f1419" strokeWidth={4} strokeLinejoin="round">{children}</text>
  );

  const hp1 = history.meta.asfound.hp1_setpoint_f, hp2 = history.meta.asfound.hp2_setpoint_f;
  const cellW = X(HHX.min + CELL) - X(HHX.min), cellH = Y(HY.min) - Y(HY.min + CELL);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "900/430" }}>
      {/* COP EFFICIENCY FIELD — first, behind everything */}
      {field.map((f, i) => (
        <g key={`f${i}`}>
          <rect x={X(f.o - CELL / 2)} y={Y(f.w + CELL / 2)} width={cellW + 0.6} height={cellH + 0.6}
            fill={heroColor(f.c)} fillOpacity={0.55} vectorEffect="non-scaling-stroke" />
          {f.c < 1 && (
            <rect x={X(f.o - CELL / 2)} y={Y(f.w + CELL / 2)} width={cellW + 0.6} height={cellH + 0.6}
              fill="#e0584a" fillOpacity={0.16} vectorEffect="non-scaling-stroke" />
          )}
        </g>
      ))}

      {/* axes */}
      {[90, 110, 130, 150, 170].map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(t) + 4} fill="#8b98a5" fontSize={12}>{t}°</text>
        </g>
      ))}
      {[-10, 0, 20, 40, 60, 80, 100].map((o) => (
        <text key={`x${o}`} x={X(o)} y={H - 8} fill="#8b98a5" fontSize={12} textAnchor="middle">{o}°F out</text>
      ))}
      <line x1={X(5)} x2={X(5)} y1={pad.t + 6} y2={H - pad.b} stroke="#3d3222" strokeWidth={1.4} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
      <Note x={X(5) + 5} y={Y(91)} color="#8b7355" size={11} weight={500}>design day 5°F</Note>

      {/* faint reference iso-COP contours 2/3/4 */}
      {faint.map(({ c, d, lbl }) => (
        <g key={`c${c}`}>
          <path d={d} fill="none" stroke="#e6ecf5" strokeOpacity={0.28} strokeWidth={1.1}
            strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
          {lbl && (
            <text x={lbl.x - 4} y={lbl.y - 6} fill="#e6ecf5" fillOpacity={0.5} fontSize={11.5} fontWeight={600} textAnchor="end"
              paintOrder="stroke" stroke="#0f1419" strokeWidth={3} strokeLinejoin="round">COP {c}</text>
          )}
        </g>
      ))}

      {/* BEFORE: density cloud of hourly (outdoor, tank), 2°F bins */}
      {bins.filter((b) => b[1] >= HY.min && b[1] <= HY.max).map(([o, t, n], i) => (
        <rect key={`d${i}`} x={X(o - 1)} y={Y(t + 1)} width={X(o + 1) - X(o - 1)} height={Y(t - 1) - Y(t + 1)}
          fill="#4dabf7" fillOpacity={0.1 + 0.5 * (Math.log(n + 1) / Math.log(maxN + 1))} rx={1} vectorEffect="non-scaling-stroke" />
      ))}

      {/* as-found regime: HBX target curve + parked HP setpoints */}
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(curveF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#ffd666" strokeWidth={2.2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
      {[hp1, hp2].map((sp) => (
        <line key={sp} x1={X(HHX.min)} x2={X(HHX.max)} y1={Y(sp)} y2={Y(sp)}
          stroke="#8b98a5" strokeWidth={1.1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      ))}

      {/* summer / DHW-only permission band (violet) */}
      <path d={`M${envTop.join("L")}L${envBot.join("L")}Z`} fill="#e599f7" fillOpacity={0.12} vectorEffect="non-scaling-stroke" />
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(hiF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#e599f7" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(loF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#e599f7" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />

      {/* BOLD red COP 1 crossover — below it the resistive backup element is cheaper */}
      <path d={cop1d} fill="none" stroke="#e0584a" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {cop1lbl && (
        <Note x={cop1lbl.x + 6} y={cop1lbl.y - 8} color="#e0584a" size={12.5} weight={700}>
          COP 1 · backup cheaper ⤴
        </Note>
      )}

      {/* live: hourly means, last 24 h + current point */}
      {live.map((p, i) => (
        <circle key={`l${i}`} cx={X(p.x)} cy={Y(clampY(p.y))} r={2.4} fill="#e6edf3" fillOpacity={0.8} vectorEffect="non-scaling-stroke" />
      ))}
      {now && (
        <g>
          <circle cx={X(now.o)} cy={Y(clampY(now.t))} r={7} fill="none" stroke="#e6edf3" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          <Note x={X(now.o) + 11} y={Y(clampY(now.t)) + 4} color="#e6edf3">live now</Note>
        </g>
      )}

      {/* direct labels — read the chart without the legend */}
      <Note x={X(38)} y={Y(171)} anchor="middle" color="#7cc0f5" size={13.5}>
        BEFORE — tank held 150–165° in every season
      </Note>
      <Note x={X(104)} y={Y(hp2) + 15} anchor="end" color="#98a5b3" size={12} weight={550}>
        HP setpoints parked 167° / 160°, 24/7
      </Note>
      <Note x={X(104)} y={Y(curveF(104)) - 8} anchor="end" color="#ffd666" size={12} weight={550}>
        HBX target curve (as-found)
      </Note>
      <Note x={X(6)} y={Y(169)} color="#e8b25a" size={12} weight={600}>
        winter + baseboard → 160–180° (up near the old curve)
      </Note>
      <Note x={X(30)} y={Y(112)} anchor="middle" color="#eeb7fb" size={13}>
        summer / DHW-only band
      </Note>
    </svg>
  );
}

// ---- COP receipt ----------------------------------------------------------------------
function ReceiptChart({ points, receipt, mfr }: {
  points: { o: number; cop: number; v: number | null }[];
  receipt: ReceiptRow[];
  mfr: { o: number; cop: number }[];
}) {
  const W = 900, H = 280, pad = { l: 44, r: 14, t: 12, b: 28 };
  const y0 = 1, y1 = 6; // top = the model's own validity clamp (TempIQ MAX_VALID_COP)
  const X = (o: number) => pad.l + ((o - HX.min) / (HX.max - HX.min)) * (W - pad.l - pad.r);
  const Y = (c: number) => pad.t + (1 - (Math.min(c, y1) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const line = (key: "measured_v1" | "measured_v3" | "af" | "cur" | "pot") => {
    // model lines stop at 65°F out — beyond that lift is tiny, the surface saturates
    // at its validity clamp, and there is no heating load to save on anyway
    const pts = receipt.filter((r) => r[key] != null &&
      (key === "measured_v1" ? (r.n_v1 ?? 0) >= 3
        : key === "measured_v3" ? (r.n_v3 ?? 0) >= 3
        : r.o <= 65));
    return pts.map((r, j) => `${j ? "L" : "M"}${X(r.o).toFixed(1)},${Y(r[key] as number).toFixed(1)}`).join("");
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "900/280" }}>
      {[1, 2, 3, 4, 5, 6].map((c) => (
        <g key={c}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(c)} y2={Y(c)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(c) + 4} fill="#8b98a5" fontSize={12}>{c.toFixed(0)}</text>
        </g>
      ))}
      {[0, 20, 40, 60, 80, 100].map((o) => (
        <text key={o} x={X(o)} y={H - 8} fill="#8b98a5" fontSize={12} textAnchor="middle">{o}°F out</text>
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={X(p.o)} cy={Y(p.cop)} r={2}
          fill={(p.v ?? 0) >= 3 ? "#4dabf7" : "#8b98a5"} fillOpacity={(p.v ?? 0) >= 3 ? 0.32 : 0.22} vectorEffect="non-scaling-stroke" />
      ))}
      <path d={line("af")} fill="none" stroke="#8b98a5" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      <path d={line("measured_v1")} fill="none" stroke="#ff6b6b" strokeWidth={1.6} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      <path d={line("measured_v3")} fill="none" stroke="#4dabf7" strokeWidth={2.6} vectorEffect="non-scaling-stroke" />
      <path d={line("cur")} fill="none" stroke="#e599f7" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
      <path d={line("pot")} fill="none" stroke="#e599f7" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      {/* manufacturer rated points at W75 — the machine's own ceiling at hot water */}
      {mfr.map((m, i) => (
        <g key={`m${i}`}>
          <path d={`M${X(m.o)},${Y(m.cop) - 6}L${X(m.o) + 6},${Y(m.cop)}L${X(m.o)},${Y(m.cop) + 6}L${X(m.o) - 6},${Y(m.cop)}Z`}
            fill="#ffd666" stroke="#0f1419" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <text x={X(m.o) + 9} y={Y(m.cop) - 6} fill="#ffd666" fontSize={11.5} fontWeight={600}
            paintOrder="stroke" stroke="#0f1419" strokeWidth={3}>spec {m.cop} @ W75</text>
        </g>
      ))}
    </svg>
  );
}

// ---- season strips ---------------------------------------------------------------------
function monthTicks(daily: Daily[]) {
  const ticks: { i: number; label: string }[] = [];
  let last = "";
  daily.forEach((d, i) => {
    const m = d.d.slice(0, 7);
    if (m !== last) { ticks.push({ i, label: new Date(d.d + "T12:00:00").toLocaleString("en-US", { month: "short" }) }); last = m; }
  });
  return ticks.slice(1); // first partial month crowds the axis
}

function SeasonKwh({ daily }: { daily: Daily[] }) {
  const W = 900, H = 240, pad = { l: 44, r: 14, t: 12, b: 28 };
  const n = daily.length;
  const hp = (d: Daily) => (d.kwh.aw1 ?? 0) + (d.kwh.aw2 ?? 0);
  const el = (d: Daily) => d.kwh.element ?? 0;
  const rawMax = Math.max(...daily.map((d) => hp(d) + el(d)), 1);
  const max = Math.ceil(rawMax / 50) * 50;
  const X = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const bw = Math.max(1.2, (W - pad.l - pad.r) / n - 0.6);
  const grid = [0, max / 2, max];
  let cfPath = "";
  daily.forEach((d, i) => {
    const h = hp(d);
    if (h <= 0.5) return;
    cfPath += `${cfPath ? "L" : "M"}${(X(i) + bw / 2).toFixed(1)},${Y(h * (d.cop_af / d.cop_cur)).toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "900/240" }}>
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={12}>{g}</text>
        </g>
      ))}
      {daily.map((d, i) => {
        const h = hp(d), e = el(d);
        return (
          <g key={d.d}>
            {h > 0 && <rect x={X(i)} y={Y(h)} width={bw} height={Y(0) - Y(h)} fill="#ff9f43" fillOpacity={0.8} vectorEffect="non-scaling-stroke">
              <title>{`${d.d} · HP ${h.toFixed(1)} kWh ($${(h * history.meta.rate_usd_kwh).toFixed(2)}) · ${d.out}°F mean`}</title>
            </rect>}
            {e > 0.2 && <rect x={X(i)} y={Y(h + e)} width={bw} height={Y(0) - Y(e)} fill="#ff6b6b" fillOpacity={0.85} vectorEffect="non-scaling-stroke">
              <title>{`${d.d} · element ${e.toFixed(1)} kWh ($${(e * history.meta.rate_usd_kwh).toFixed(2)})`}</title>
            </rect>}
          </g>
        );
      })}
      <path d={cfPath} fill="none" stroke="#e599f7" strokeWidth={1.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      {monthTicks(daily).map((t) => (
        <text key={t.i} x={X(t.i)} y={H - 8} fill="#8b98a5" fontSize={12}>{t.label}</text>
      ))}
    </svg>
  );
}

function SeasonTemps({ daily }: { daily: Daily[] }) {
  const W = 900, H = 260, pad = { l: 44, r: 14, t: 12, b: 28 };
  const n = daily.length;
  const y0 = -5, y1 = 172;
  const X = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const path = (get: (d: Daily) => number | null) => {
    let out = "";
    daily.forEach((d, i) => {
      const v = get(d);
      if (v == null) return;
      out += `${out ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    });
    return out;
  };
  const band =
    daily.map((d, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(d.out_hi).toFixed(1)}`).join("") +
    daily.slice().reverse().map((d, i) => `L${X(n - 1 - i).toFixed(1)},${Y(d.out_lo).toFixed(1)}`).join("") + "Z";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "900/260" }}>
      {[0, 40, 80, 120, 160].map((g) => (
        <g key={g}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={12}>{g}°</text>
        </g>
      ))}
      <path d={band} fill="#845ef7" fillOpacity={0.14} vectorEffect="non-scaling-stroke" />
      <path d={path((d) => d.out)} fill="none" stroke="#845ef7" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path d={path((d) => d.tank)} fill="none" stroke="#4dabf7" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
      <path d={path((d) => d.tgt)} fill="none" stroke="#ffd666" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      <path d={path((d) => d.tgt_cur)} fill="none" stroke="#e599f7" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
      <line x1={pad.l} x2={W - pad.r} y1={Y(history.meta.asfound.hp1_setpoint_f)} y2={Y(history.meta.asfound.hp1_setpoint_f)}
        stroke="#63e6be" strokeWidth={1.1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      {monthTicks(daily).map((t) => (
        <text key={t.i} x={X(t.i)} y={H - 8} fill="#8b98a5" fontSize={12}>{t.label}</text>
      ))}
    </svg>
  );
}

// ---- page ------------------------------------------------------------------------------
type SlxRow = { ts: number; tank_f: number | null; outdoor_f: number | null };

export default async function CurvePage() {
  let live: { x: number; y: number }[] = [];
  let now: { o: number; t: number } | null = null;
  let liveCop: { o: number; cop: number; q: number | null }[] = [];
  try {
    const slx = (await sql<SlxRow>`
      SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, tank_f, outdoor_f
      FROM slx_readings WHERE ts >= now() - interval '24 hours' ORDER BY ts ASC`).rows;
    const pts = slx.filter((r) => r.outdoor_f != null && r.tank_f != null);
    // hourly means — a short readable trail instead of a 5-min scribble
    const byHour = new Map<number, { sx: number; sy: number; n: number }>();
    for (const r of pts) {
      const h = Math.floor(r.ts / 3600);
      const a = byHour.get(h) ?? { sx: 0, sy: 0, n: 0 };
      a.sx += r.outdoor_f as number; a.sy += r.tank_f as number; a.n++;
      byHour.set(h, a);
    }
    live = [...byHour.values()].map((a) => ({ x: a.sx / a.n, y: a.sy / a.n }));
    const last = pts[pts.length - 1];
    if (last && Date.now() / 1000 - last.ts < 1200) now = { o: last.outdoor_f as number, t: last.tank_f as number };
    // Live COP surface: the planner's incremental feed from TempIQ /cop-measurements — now
    // de-flattened per TempIQ#1503 — stored in a2w Neon. The honest current COP, not the frozen bake.
    const cp = await sql`
      SELECT outdoor_temp_f AS o, cop, quality_score AS q FROM tempiq_cop_points
      WHERE system LIKE 'hydronic%' AND measured_at >= now() - interval '30 days'
        AND cop > 0 AND outdoor_temp_f IS NOT NULL ORDER BY measured_at ASC`;
    liveCop = cp.rows as { o: number; cop: number; q: number | null }[];
  } catch { /* history still renders without Neon */ }

  const m = history.meta;
  const est = m.estimates;
  const era = `${new Date(m.era.from + "T12:00:00").toLocaleString("en-US", { month: "short", day: "numeric" })} → ${new Date(m.era.to + "T12:00:00").toLocaleString("en-US", { month: "short", day: "numeric" })}`;
  const copPts = history.cop_points.filter((p) => p.o != null) as { o: number; cop: number; v: number | null }[];
  const cop = history.meta.cop;
  // Possible (modeled) COP at planner-cool tanks vs the model at as-found tanks, same weather.
  const possMild = nwCop("cur", 0, 65), possWarm = nwCop("cur", 65, 999);
  const afMild = nwCop("af", 0, 65), afWarm = nwCop("af", 65, 999);
  // Live de-flattened COP (TempIQ#1503) stats, binned like the receipt.
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const lcAll = med(liveCop.map((p) => p.cop));
  const lcMild = med(liveCop.filter((p) => p.o <= 65).map((p) => p.cop));
  const lcWarm = med(liveCop.filter((p) => p.o > 65).map((p) => p.cop));

  return (
    <>
      <I1Banner />
      <StormBanner />

      <div className="cards">
        <div className="card">
          <h2>Live COP <span className="chip on">de-flattened · #1503</span></h2>
          <div className="temps">
            <div className="temp"><div className="v">{lcAll?.toFixed(2) ?? "—"}</div><div className="l">median · last 30d</div></div>
            <div className="temp"><div className="v">{lcMild?.toFixed(2) ?? "—"}</div><div className="l">mild ≤65°F out</div></div>
            <div className="temp"><div className="v">{lcWarm?.toFixed(2) ?? "—"}</div><div className="l">warm &gt;65°F out</div></div>
          </div>
          <div className="meta">
            The planner&apos;s live COP feed ({liveCop.length} points) from TempIQ, now segmented to the honest
            v3 calorimetric measurement (TempIQ#1503) — no longer the flat ~2.33 artifact. This is the current
            efficiency read; the frozen July-14 bake below is kept for the before/after story.
          </div>
        </div>
        <div className="card">
          <h2>Before <span className="chip off">8 months</span></h2>
          <div className="temps"><div className="temp"><div className="v">150–165°</div><div className="l">tank, all year</div></div></div>
          <div className="meta">
            HBX curve {CFG.dbt}°F @ {CFG.dot}°F out → {CFG.mbt}°F @ {CFG.wwsd}°F out; HP setpoints parked at{" "}
            {m.asfound.hp1_setpoint_f}° / {m.asfound.hp2_setpoint_f}°F, 24/7. Same hot tank in July as in January.
          </div>
        </div>
        <div className="card">
          <h2>The receipt <span className="chip warn">measured vs. modeled</span></h2>
          <div className="temps">
            <div className="temp"><div className="v">{cop.v3_median_mild} → {cop.v3_median_warm}</div><div className="l">measured · old hot tanks</div></div>
            <div className="temp"><div className="v">{possMild} → {possWarm}</div><div className="l">possible · planner-cool</div></div>
          </div>
          <div className="meta">
            Left = what the pumps actually did at 150–165°F tanks (mild → warm outdoor): auditable, but draw-contaminated,
            so a floor. Right = the same efficiency model at the planner&apos;s cooler targets, over the same weather. Same
            model, only the water gets cooler — the honest tank-temperature prize is {afMild} → {possMild} (mild) and{" "}
            {afWarm} → {possWarm} (warm). The old &ldquo;flat 2.33&rdquo; was an artifact: two calculators glued across
            seasons, the winter one beating the machine&apos;s 1.96 W75 spec.
          </div>
        </div>
        <div className="card">
          <h2>Now <span className="chip heating">planner</span></h2>
          <div className="temps"><div className="temp"><div className="v">95–135°</div><div className="l">outdoor-indexed band</div></div></div>
          <div className="meta">
            I4 envelope: 95°F tank at ≥55°F out rising to 135°F at 5°F out. Hourly targets carry reasons
            (DHW windows, sanitize, idle); HP setpoint = target + {m.opts.i1MarginF}°F (I1, A-4-measured).
          </div>
        </div>
        <div className="card">
          <h2>The prize <span className="chip cooling">modeled</span></h2>
          <div className="temps"><div className="temp"><div className="v">${fmtK(est.cur_usd_saved)}–{fmtK(est.pot_usd_saved)}</div><div className="l">per season</div></div></div>
          <div className="meta">
            Same weather, same service, planner targets instead: {fmtK(est.cur_kwh_saved)}–{fmtK(est.pot_kwh_saved)} kWh
            off {fmtK(est.hp_kwh_measured)} measured HP kWh at ${m.rate_usd_kwh}/kWh. Lower bound = planner as built;
            upper = envelope potential once the winter solver lands.
          </div>
        </div>
      </div>

      <div className="chart-block">
        <h3>
          Where efficiency lives — the base-system COP map
          <span className="dim"> (outdoor °F across, tank °F up)</span>
        </h3>
        <div className="chart">
          <CurveField bins={history.bins_tank} live={live} now={now} />
        </div>
        <div className="legend">
          <span><i style={{ background: "hsl(65 30% 30%)" }} />shading = modeled COP: green cheap → red dear</span>
          <span><i style={{ background: "#e0584a" }} />COP 1 — backup cheaper below (red line)</span>
          <span><i style={{ background: "#4dabf7", opacity: 0.6 }} />each blue square = hours spent there, {era}</span>
          <span><i style={{ background: "#e599f7" }} />summer / DHW band (violet)</span>
          <span><i style={{ background: "#e6edf3" }} />white = live, last 24 h</span>
        </div>
        <div className="meta">
          The ceiling isn&apos;t one number — how low the tank can go depends on demand. Slide <b>down</b> (cooler
          tank) or <b>right</b> (milder day) and every step lands on a cheaper COP. When only hot water is owed —
          most of the year here — the planner works down in the violet summer/DHW band. But when baseboard zones
          call in the cold the tank must ride back up near the old HBX curve (≈160–180°) to actually heat the house,
          and the band doesn&apos;t apply. Below the bold red <b>COP 1</b> line the tank&apos;s own resistive element
          makes the same hot water for less — only in deep cold with a hot tank (the red sliver, far left).
        </div>
      </div>

      <div className="chart-block">
        <h3>The COP receipt — measured (two instruments) vs. the model <span className="dim">(by outdoor °F · yellow diamonds = the machine&apos;s own rating)</span></h3>
        <div className="chart">
          <ReceiptChart points={copPts} receipt={history.receipt} mfr={m.mfr_ratings_w75} />
        </div>
        <div className="legend">
          <span><i style={{ background: "#4dabf7" }} />measured, session calculator ({cop.v3_n} charges, Mar→Jul)</span>
          <span><i style={{ background: "#ff6b6b" }} />legacy winter calculator ({cop.v1_n} rows) — inflated, beats the spec diamonds</span>
          <span><i style={{ background: "#8b98a5" }} />model at as-found tank temps</span>
          <span><i style={{ background: "#e599f7" }} />model at planner targets (solid = as built, dashed = potential)</span>
          <span><i style={{ background: "#ffd666" }} />manufacturer rating at 75°C water</span>
        </div>
        <div className="meta">
          Forensics (2026-07-14): the old &ldquo;flat COP&rdquo; line blended these two instruments across seasons. The red
          dotted winter series reads <em>above</em> the yellow spec diamonds — physically impossible, so it&apos;s discarded
          as inflated (unlearned standby credit + survivorship). The blue auditable series rises with outdoor temp as
          physics demands, and is itself a <em>lower bound</em>: 36–67% of warm-weather charge windows had hot water
          running mid-charge (charges are draw-triggered), which understates thermal. The wedge up to the purple lines
          is the claim; model lines stop at 65°F out. The $ math never used this curve — it scales measured kWh by
          model ratios only.
        </div>
      </div>

      <div className="chart-block">
        <h3>Season electricity — heat pumps + element <span className="dim">(SPAN, measured · dashed = modeled with planner as built)</span></h3>
        <div className="chart">
          <SeasonKwh daily={history.daily} />
        </div>
        <div className="legend">
          <span><i style={{ background: "#ff9f43" }} />HP kWh/day (AW1+AW2): {fmtK(m.totals_kwh.aw1 + m.totals_kwh.aw2)} kWh ≈ ${fmtK(Math.round((m.totals_kwh.aw1 + m.totals_kwh.aw2) * m.rate_usd_kwh))}</span>
          <span><i style={{ background: "#ff6b6b" }} />backup element: {fmtK(m.totals_kwh.element)} kWh</span>
          <span><i style={{ background: "#e599f7" }} />counterfactual kWh (model)</span>
        </div>
      </div>

      <div className="chart-block">
        <h3>The year at a glance — °F <span className="dim">(the flat-tank story vs. what the planner would have commanded)</span></h3>
        <div className="chart">
          <SeasonTemps daily={history.daily} />
        </div>
        <div className="legend">
          <span><i style={{ background: "#845ef7" }} />outdoor (daily mean + range)</span>
          <span><i style={{ background: "#4dabf7" }} />tank (daily mean)</span>
          <span><i style={{ background: "#ffd666" }} />HBX target</span>
          <span><i style={{ background: "#e599f7" }} />planner counterfactual target</span>
          <span><i style={{ background: "#63e6be" }} />HP1 setpoint 167°F</span>
        </div>
        <div className="meta">
          The counterfactual&apos;s winter plateau is the I4 strict cap (135°) — enough for the binding baseboard zone on
          design day but with zero margin, because the demand-driven winter solver isn&apos;t built yet. Once
          zone demand feeds in, winter targets ride each day&apos;s actual binding-zone need instead of a fixed cap.
        </div>
      </div>

      <div className="chart-block">
        <h3>Honesty notes</h3>
        {m.notes.map((n, i) => <div className="meta" key={i}>· {n}</div>)}
        <div className="meta">· counterfactuals scale measured daily HP kWh by the modeled COP ratio — the meter is the ledger, models are diagnostics</div>
        <div className="meta">· winter months conflate HP2 degradation and the disabled element; the A-6 baseline model is claim-grade at monthly aggregation only</div>
        <div className="meta">· extract {m.extracted_at} · rate ${m.rate_usd_kwh}/kWh flat, 1:1 net metering · COP surface η = {ETA_BASE} Carnot-style (TempIQ)</div>
      </div>
    </>
  );
}
