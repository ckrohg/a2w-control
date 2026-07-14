// @purpose /curve — the optimization story in one view (plan §6.8): curve-space hero
// chart (outdoor °F × tank °F) with an iso-COP background showing WHERE the tank lived
// for 8 months under the as-found regime vs the I4 envelope the planner operates in,
// plus the COP receipt (measured tank-calorimetry vs the same model at planner targets),
// season kWh/$ strips, and today's plan blocks with per-block reasons + modeled COP.
// Before-era data is a static extract (lib/curve-history.json, dev-time script) — the
// dashboard has NO runtime dependency on TempIQ. Live overlays come from Neon.
// Honesty per the net-accounting doctrine: measured (SPAN, cop_measurements) vs model
// (COP surface, counterfactuals) is labeled on every number.
import { sql } from "@vercel/postgres";
import { fmtTime } from "@/lib/tz";
import { I1Banner } from "../i1-banner";
import historyJson from "@/lib/curve-history.json";

// explicit shape (per-day kwh key sets vary, which trips JSON literal inference)
type Daily = {
  d: string; out: number; out_lo: number; out_hi: number; tank: number; tgt: number | null;
  kwh: Partial<Record<"aw1" | "aw2" | "element" | "circ" | "glycol", number>>;
  cop_af: number; cop_cur: number; cop_pot: number; tgt_cur: number; tgt_pot: number;
};
type ReceiptRow = { o: number; measured?: number; n?: number; af?: number; cur?: number; pot?: number };
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
    cop_measured_avg: number | null; notes: string[];
  };
  bins_tank: number[][]; bins_target: number[][];
  daily: Daily[];
  cop_points: { o: number | null; cop: number; sink: number | null }[];
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
const eta = (o: number) => Math.max(0.3, ETA_BASE - Math.max(0, 17 - o) * 0.001);
const copAt = (o: number, w: number) =>
  w - o <= 5 ? 6 : Math.max(1, Math.min(6, (eta(o) * (w + 459.67)) / (w - o)));
/** water temp of the iso-COP contour `c` at outdoor `o` (invert copAt) */
const isoW = (c: number, o: number) => (c * o + eta(o) * 459.67) / (c - eta(o));

const fmtK = (n: number) => n.toLocaleString("en-US");
const copHue = (c: number) => Math.max(0, Math.min(1, (c - 1.6) / 2.9)) * 120; // red→green

// ---- hero: curve space ---------------------------------------------------------------
const HX = { min: 0, max: 105 };
const HY = { min: 88, max: 174 };

function CurveField({
  bins, live, blocks, now,
}: {
  bins: number[][];
  live: { x: number; y: number }[];
  blocks: { outdoor_f: number; tank_target_f: number; reason: string; ts: string }[];
  now: { o: number; t: number } | null;
}) {
  const W = 900, H = 430, pad = { l: 44, r: 14, t: 14, b: 30 };
  const X = (o: number) => pad.l + ((o - HX.min) / (HX.max - HX.min)) * (W - pad.l - pad.r);
  const Y = (t: number) => pad.t + (1 - (t - HY.min) / (HY.max - HY.min)) * (H - pad.t - pad.b);
  const clampY = (t: number) => Math.max(HY.min, Math.min(HY.max, t));
  const xs: number[] = [];
  for (let o = HX.min; o <= HX.max; o += 3) xs.push(o);

  // iso-COP bands (fill between adjacent contours) + labeled contour lines
  const levels = [1.7, 2, 2.5, 3, 3.5, 4, 5, 6.5];
  const bands = levels.slice(0, -1).map((c1, i) => {
    const c2 = levels[i + 1];
    const top = xs.map((o) => `${X(o).toFixed(1)},${Y(clampY(isoW(c1, o))).toFixed(1)}`);
    const bot = xs.slice().reverse().map((o) => `${X(o).toFixed(1)},${Y(clampY(isoW(c2, o))).toFixed(1)}`);
    return { d: `M${top.join("L")}L${bot.join("L")}Z`, hue: copHue((c1 + c2) / 2) };
  });
  const contours = [2, 2.5, 3, 3.5, 4, 5].map((c) => {
    const pts = xs.map((o) => ({ o, w: isoW(c, o) })).filter((p) => p.w > HY.min + 1 && p.w < HY.max - 1);
    return pts.length > 1 ? { c, pts } : null;
  }).filter(Boolean) as { c: number; pts: { o: number; w: number }[] }[];

  const maxN = Math.max(...bins.map((b) => b[2]));
  const envTop = xs.map((o) => `${X(o).toFixed(1)},${Y(hiF(o)).toFixed(1)}`);
  const envBot = xs.slice().reverse().map((o) => `${X(o).toFixed(1)},${Y(loF(o)).toFixed(1)}`);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: "auto", aspectRatio: "900/430" }}>
      {bands.map((b, i) => (
        <path key={`b${i}`} d={b.d} fill={`hsl(${b.hue} 65% 50%)`} fillOpacity={0.055} />
      ))}
      {contours.map(({ c, pts }) => (
        <g key={`c${c}`}>
          <path
            d={pts.map((p, j) => `${j ? "L" : "M"}${X(p.o).toFixed(1)},${Y(p.w).toFixed(1)}`).join("")}
            fill="none" stroke="#4a5866" strokeWidth={1} strokeDasharray="2 4"
          />
          <text x={X(pts[pts.length - 1].o) - 4} y={Y(pts[pts.length - 1].w) - 4}
            fill="#5d6c7b" fontSize={12} textAnchor="end">COP {c}</text>
        </g>
      ))}

      {/* axes */}
      {[90, 110, 130, 150, 170].map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} stroke="#2c3640" strokeWidth={0.7} />
          <text x={4} y={Y(t) + 4} fill="#8b98a5" fontSize={12}>{t}°</text>
        </g>
      ))}
      {[0, 20, 40, 60, 80, 100].map((o) => (
        <text key={`x${o}`} x={X(o)} y={H - 8} fill="#8b98a5" fontSize={12} textAnchor="middle">{o}°F out</text>
      ))}
      <line x1={X(5)} x2={X(5)} y1={pad.t} y2={H - pad.b} stroke="#3d3222" strokeWidth={1.4} strokeDasharray="3 5" />
      <text x={X(5) + 4} y={pad.t + 12} fill="#8b7355" fontSize={11}>design day 5°F</text>

      {/* before-era density cloud: hourly (outdoor, tank), 2°F bins */}
      {bins.filter((b) => b[1] >= HY.min && b[1] <= HY.max).map(([o, t, n], i) => (
        <rect key={`d${i}`} x={X(o - 1)} y={Y(t + 1)} width={X(o + 1) - X(o - 1)} height={Y(t - 1) - Y(t + 1)}
          fill="#4dabf7" fillOpacity={0.1 + 0.5 * (Math.log(n + 1) / Math.log(maxN + 1))} rx={1} />
      ))}

      {/* as-found regime */}
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(curveF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#ffd666" strokeWidth={2.2} strokeDasharray="6 4" />
      <line x1={X(HX.min)} x2={X(HX.max)} y1={Y(history.meta.asfound.hp1_setpoint_f)} y2={Y(history.meta.asfound.hp1_setpoint_f)}
        stroke="#63e6be" strokeWidth={1.3} strokeDasharray="2 3" />
      <line x1={X(HX.min)} x2={X(HX.max)} y1={Y(history.meta.asfound.hp2_setpoint_f)} y2={Y(history.meta.asfound.hp2_setpoint_f)}
        stroke="#f783ac" strokeWidth={1.3} strokeDasharray="2 3" />

      {/* optimizer envelope */}
      <path d={`M${envTop.join("L")}L${envBot.join("L")}Z`} fill="#e599f7" fillOpacity={0.13} />
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(hiF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#e599f7" strokeWidth={1.6} />
      <path d={xs.map((o, j) => `${j ? "L" : "M"}${X(o).toFixed(1)},${Y(loF(o)).toFixed(1)}`).join("")}
        fill="none" stroke="#e599f7" strokeWidth={1.6} />

      {/* live: last 48 h of actual (outdoor, tank) + current point */}
      {live.map((p, i) => (
        <circle key={`l${i}`} cx={X(p.x)} cy={Y(clampY(p.y))} r={2.1} fill="#e6edf3" fillOpacity={0.85} />
      ))}
      {now && (
        <g>
          <circle cx={X(now.o)} cy={Y(clampY(now.t))} r={7} fill="none" stroke="#e6edf3" strokeWidth={1.6} />
          <text x={X(now.o) + 11} y={Y(clampY(now.t)) + 4} fill="#e6edf3" fontSize={12.5} fontWeight={650}>now</text>
        </g>
      )}

      {/* today's plan blocks */}
      {blocks.map((b, i) => (
        <circle key={`p${i}`} cx={X(b.outdoor_f)} cy={Y(b.tank_target_f)} r={4}
          fill="#e599f7" stroke={b.reason.includes("sanitize") ? "#ffd666" : "#0f1419"} strokeWidth={1.4}>
          <title>{`${fmtTime(new Date(b.ts))} → ${b.tank_target_f}°F · ${b.reason} · modeled COP ${copAt(b.outdoor_f, b.tank_target_f).toFixed(2)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// ---- COP receipt ----------------------------------------------------------------------
function ReceiptChart({ points, receipt }: { points: { o: number; cop: number }[]; receipt: ReceiptRow[] }) {
  const W = 900, H = 280, pad = { l: 44, r: 14, t: 12, b: 28 };
  const y0 = 1, y1 = 6; // top = the model's own validity clamp (TempIQ MAX_VALID_COP)
  const X = (o: number) => pad.l + ((o - HX.min) / (HX.max - HX.min)) * (W - pad.l - pad.r);
  const Y = (c: number) => pad.t + (1 - (Math.min(c, y1) - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const line = (key: "measured" | "af" | "cur" | "pot", minN = 0) => {
    const pts = receipt.filter((r) => r[key] != null && (key !== "measured" || (r.n ?? 0) >= minN));
    return pts.map((r, j) => `${j ? "L" : "M"}${X(r.o).toFixed(1)},${Y(r[key] as number).toFixed(1)}`).join("");
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: "auto", aspectRatio: "900/280" }}>
      {[1, 2, 3, 4, 5, 6].map((c) => (
        <g key={c}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(c)} y2={Y(c)} stroke="#2c3640" strokeWidth={0.7} />
          <text x={4} y={Y(c) + 4} fill="#8b98a5" fontSize={12}>{c.toFixed(0)}</text>
        </g>
      ))}
      {[0, 20, 40, 60, 80, 100].map((o) => (
        <text key={o} x={X(o)} y={H - 8} fill="#8b98a5" fontSize={12} textAnchor="middle">{o}°F out</text>
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={X(p.o)} cy={Y(p.cop)} r={2} fill="#4dabf7" fillOpacity={0.28} />
      ))}
      <path d={line("af")} fill="none" stroke="#8b98a5" strokeWidth={1.5} strokeDasharray="5 4" />
      <path d={line("measured", 3)} fill="none" stroke="#4dabf7" strokeWidth={2.6} />
      <path d={line("cur")} fill="none" stroke="#e599f7" strokeWidth={2.2} />
      <path d={line("pot")} fill="none" stroke="#e599f7" strokeWidth={1.5} strokeDasharray="5 4" />
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: "auto", aspectRatio: "900/240" }}>
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={0.7} />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={12}>{g}</text>
        </g>
      ))}
      {daily.map((d, i) => {
        const h = hp(d), e = el(d);
        return (
          <g key={d.d}>
            {h > 0 && <rect x={X(i)} y={Y(h)} width={bw} height={Y(0) - Y(h)} fill="#ff9f43" fillOpacity={0.8}>
              <title>{`${d.d} · HP ${h.toFixed(1)} kWh ($${(h * history.meta.rate_usd_kwh).toFixed(2)}) · ${d.out}°F mean`}</title>
            </rect>}
            {e > 0.2 && <rect x={X(i)} y={Y(h + e)} width={bw} height={Y(0) - Y(e)} fill="#ff6b6b" fillOpacity={0.85}>
              <title>{`${d.d} · element ${e.toFixed(1)} kWh ($${(e * history.meta.rate_usd_kwh).toFixed(2)})`}</title>
            </rect>}
          </g>
        );
      })}
      <path d={cfPath} fill="none" stroke="#e599f7" strokeWidth={1.6} strokeDasharray="4 3" />
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: "auto", aspectRatio: "900/260" }}>
      {[0, 40, 80, 120, 160].map((g) => (
        <g key={g}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={0.7} />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={12}>{g}°</text>
        </g>
      ))}
      <path d={band} fill="#845ef7" fillOpacity={0.14} />
      <path d={path((d) => d.out)} fill="none" stroke="#845ef7" strokeWidth={1.5} />
      <path d={path((d) => d.tank)} fill="none" stroke="#4dabf7" strokeWidth={1.8} />
      <path d={path((d) => d.tgt)} fill="none" stroke="#ffd666" strokeWidth={1.5} strokeDasharray="5 4" />
      <path d={path((d) => d.tgt_cur)} fill="none" stroke="#e599f7" strokeWidth={1.8} />
      <line x1={pad.l} x2={W - pad.r} y1={Y(history.meta.asfound.hp1_setpoint_f)} y2={Y(history.meta.asfound.hp1_setpoint_f)}
        stroke="#63e6be" strokeWidth={1.1} strokeDasharray="2 3" />
      {monthTicks(daily).map((t) => (
        <text key={t.i} x={X(t.i)} y={H - 8} fill="#8b98a5" fontSize={12}>{t.label}</text>
      ))}
    </svg>
  );
}

// ---- page ------------------------------------------------------------------------------
type SlxRow = { ts: number; tank_f: number | null; outdoor_f: number | null };
type ShadowBlock = { ts: string; outdoor_f: number; tank_target_f: number; hp1_setpoint_f: number; reason: string };

export default async function CurvePage() {
  let live: { x: number; y: number }[] = [];
  let now: { o: number; t: number } | null = null;
  let blocks: ShadowBlock[] = [];
  let shadowAt: number | null = null;
  try {
    const slx = (await sql<SlxRow>`
      SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, tank_f, outdoor_f
      FROM slx_readings WHERE ts >= now() - interval '48 hours' ORDER BY ts ASC`).rows;
    const pts = slx.filter((r) => r.outdoor_f != null && r.tank_f != null);
    const step = Math.max(1, Math.floor(pts.length / 200));
    live = pts.filter((_, i) => i % step === 0).map((r) => ({ x: r.outdoor_f as number, y: r.tank_f as number }));
    const last = pts[pts.length - 1];
    if (last && Date.now() / 1000 - last.ts < 1200) now = { o: last.outdoor_f as number, t: last.tank_f as number };
    const sp = await sql`SELECT plan, EXTRACT(EPOCH FROM computed_at)::float8 AS t FROM shadow_plans ORDER BY id DESC LIMIT 1`;
    if (sp.rowCount) { blocks = sp.rows[0].plan as ShadowBlock[]; shadowAt = sp.rows[0].t as number; }
  } catch { /* history still renders without Neon */ }

  const m = history.meta;
  const est = m.estimates;
  const era = `${new Date(m.era.from + "T12:00:00").toLocaleString("en-US", { month: "short", day: "numeric" })} → ${new Date(m.era.to + "T12:00:00").toLocaleString("en-US", { month: "short", day: "numeric" })}`;
  const copPts = history.cop_points.filter((p) => p.o != null) as { o: number; cop: number }[];

  return (
    <>
      <header>
        <h1>The Curve</h1>
        <span className="dim">before vs. after · {era} baked · live overlay</span>
        <a className="btn" href="/" style={{ marginLeft: "auto", textDecoration: "none" }}>Pumps</a>
        <a className="btn" href="/hbx" style={{ textDecoration: "none" }}>HBX</a>
        <a className="btn" href="/savings" style={{ textDecoration: "none" }}>Savings</a>
        <form action="/api/logout" method="post"><button type="submit">Sign out</button></form>
      </header>

      <I1Banner />

      <div className="cards">
        <div className="card">
          <h2>Before <span className="chip off">8 months</span></h2>
          <div className="temps"><div className="temp"><div className="v">150–165°</div><div className="l">tank, all year</div></div></div>
          <div className="meta">
            HBX curve {CFG.dbt}°F @ {CFG.dot}°F out → {CFG.mbt}°F @ {CFG.wwsd}°F out; HP setpoints parked at{" "}
            {m.asfound.hp1_setpoint_f}° / {m.asfound.hp2_setpoint_f}°F, 24/7. Same hot tank in July as in January.
          </div>
        </div>
        <div className="card">
          <h2>The receipt <span className="chip warn">measured</span></h2>
          <div className="temps"><div className="temp"><div className="v">COP {m.cop_measured_avg}</div><div className="l">flat vs outdoor</div></div></div>
          <div className="meta">
            {copPts.length} tank-calorimetry measurements. COP never improved in mild weather — condensing stayed hot
            no matter the temperature outside. That flatness is the money left on the table.
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
          Where the tank lives — outdoor °F × tank °F
          <span className="dim"> (blue cloud = 8 months as-found · purple band = where the planner operates · dotted arcs = modeled COP)</span>
        </h3>
        <div className="chart">
          <CurveField bins={history.bins_tank} live={live} blocks={blocks} now={now} />
        </div>
        <div className="legend">
          <span><i style={{ background: "#4dabf7", opacity: 0.6 }} />tank, hourly {era} (density)</span>
          <span><i style={{ background: "#ffd666" }} />as-found HBX target curve</span>
          <span><i style={{ background: "#63e6be" }} />HP1 setpoint 167°F (24/7)</span>
          <span><i style={{ background: "#f783ac" }} />HP2 setpoint 160°F (24/7)</span>
          <span><i style={{ background: "#e599f7" }} />I4 envelope + today&apos;s plan blocks{shadowAt ? ` (computed ${fmtTime(shadowAt)})` : ""}</span>
          <span><i style={{ background: "#e6edf3" }} />live, last 48 h</span>
        </div>
        <div className="meta">
          How to read it: height above an iso-COP arc is wasted lift — heat pumped hotter than anything needed it.
          The old regime held the top-left of the chart in every season (the target scatter sits on the yellow line
          with σ {m.asfound.mined_fit.sigma}°F); the planner’s band hugs the arcs where COP is 3–4+. At the cold end
          the yellow curve meets the pumps’ ceiling — the deadlock where calls couldn’t terminate. Hover a purple dot
          for the hour’s reason and modeled COP.
        </div>
      </div>

      <div className="chart-block">
        <h3>The COP receipt — measured vs. the same model at planner targets <span className="dim">(by outdoor °F)</span></h3>
        <div className="chart">
          <ReceiptChart points={copPts} receipt={history.receipt} />
        </div>
        <div className="legend">
          <span><i style={{ background: "#4dabf7" }} />measured, median per 5°F bin ({copPts.length} charges)</span>
          <span><i style={{ background: "#8b98a5" }} />model at as-found tank temps (validation — should track blue)</span>
          <span><i style={{ background: "#e599f7" }} />model at planner targets (as built)</span>
          <span><i style={{ background: "#e599f7", opacity: 0.55 }} />model at envelope potential</span>
        </div>
        <div className="meta">
          The gray dashed line is the model evaluated where the system actually ran — its agreement with the blue
          measured line is what makes the purple lines credible. The wedge between blue and purple is the claim,
          in COP units. Absolute measured COP carries tank-volume uncertainty (A-4); the flatness is the load-bearing fact.
          Above ~50°F outdoor the model runs optimistic (standby losses dominate measured mild-weather charges) and
          saturates at its validity clamp of 6 — read the purple lines as upper bounds; the $ math uses only the
          day-by-day ratio, not the absolute level.
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
      </div>

      {blocks.length > 0 && (
        <div className="chart-block">
          <h3>Today’s plan — 24 blocks <span className="dim">(tile shade = modeled COP · hover for the reason)</span></h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(60px, 1fr))", gap: 4 }}>
            {blocks.map((b, i) => {
              const c = copAt(b.outdoor_f, b.tank_target_f);
              return (
                <div key={i} title={`${fmtTime(new Date(b.ts))} · ${b.reason} · outdoor ${b.outdoor_f.toFixed(0)}°F · modeled COP ${c.toFixed(2)}`}
                  style={{ background: `hsl(${copHue(c)} 45% 20%)`, border: "1px solid #2c3640", borderRadius: 8, padding: "6px 4px", textAlign: "center" }}>
                  <div style={{ fontSize: 10.5, color: "#8b98a5" }}>{fmtTime(new Date(b.ts)).replace(/:\d\d /, " ")}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{b.tank_target_f}°</div>
                  <div style={{ fontSize: 10, color: "#8b98a5" }}>COP {c >= 5.95 ? "6+" : c.toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="chart-block">
        <h3>Honesty notes</h3>
        {m.notes.map((n, i) => <div className="meta" key={i}>· {n}</div>)}
        <div className="meta">· counterfactuals scale measured daily HP kWh by the modeled COP ratio — the meter is the ledger, models are diagnostics (plan §8.1)</div>
        <div className="meta">· winter months conflate HP2 degradation and the disabled element; the A-6 baseline model is claim-grade at monthly aggregation only</div>
        <div className="meta">· extract {m.extracted_at} · rate ${m.rate_usd_kwh}/kWh flat, 1:1 net metering · COP surface η = {ETA_BASE} Carnot-style (TempIQ)</div>
      </div>
    </>
  );
}
