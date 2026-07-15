// @purpose Shared inline-SVG line-chart primitive — the single source of truth merged from
// the home page's local `Chart` (bands + label titles) and the /hbx page's `LineChart`
// (per-series width). Server component (no "use client"): callers pass epoch-second points
// and colors (later CSS-var tokens), and the chart auto-fits Y, draws 3 gridlines, optional
// top-strip bands, and dashed/solid series paths. Three fixes bake in here so every consumer
// inherits them: preserveAspectRatio="xMidYMid meet" + inline height:auto (mobile no longer
// stretches the 900×H viewBox to the CSS 150px), vectorEffect="non-scaling-stroke" on every
// drawn element (crisp lines at any render size), and a <title> hover readout per series.
import { fmtTime, fmtDay } from "@/lib/tz";

export type Pt = { x: number; y: number | null };
export type Series = { color: string; points: Pt[]; dash?: boolean; width?: number; label?: string };
export type Band = { x0: number; x1: number; color?: string };

export function Chart({
  series,
  hours,
  bands,
  height,
}: {
  series: Series[];
  hours: number;
  bands?: Band[];
  height?: number;
}): JSX.Element {
  const W = 900, H = height ?? 200, pad = { l: 38, r: 10, t: 10, b: 20 };
  const all = series.flatMap((s) => s.points.filter((p) => p.y != null && isFinite(p.y as number))) as { x: number; y: number }[];
  if (!all.length) return <div className="empty" style={{ padding: 20 }}>No data yet</div>;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 4) { const m = (y0 + y1) / 2; y0 = m - 2; y1 = m + 2; }
  const X = (x: number) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const grid = [y0, (y0 + y1) / 2, y1];
  const t0 = new Date(x0 * 1000), t1 = new Date(x1 * 1000);
  const lab = (d: Date) => (hours > 48 ? fmtDay(d) : fmtTime(d));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "auto", aspectRatio: `900/${H}` }}
    >
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={11}>{Math.round(g)}</text>
        </g>
      ))}
      {(bands ?? []).map((b, i) => {
        const bx0 = Math.max(b.x0, x0), bx1 = Math.min(b.x1, x1);
        if (bx1 <= bx0) return null;
        return <rect key={`b${i}`} x={X(bx0)} y={pad.t - 6} width={Math.max(2, X(bx1) - X(bx0))} height={5} rx={2} fill={b.color ?? "#63e6be"} fillOpacity={0.85} vectorEffect="non-scaling-stroke" />;
      })}
      {series.map((s, i) => {
        const pts = s.points.filter((p) => p.y != null && isFinite(p.y as number)) as { x: number; y: number }[];
        if (!pts.length) return null;
        const d = pts.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
        return (
          <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.8} strokeLinejoin="round" strokeDasharray={s.dash ? "5 4" : undefined} vectorEffect="non-scaling-stroke">
            <title>{s.label ?? ""}</title>
          </path>
        );
      })}
      <text x={pad.l} y={H - 4} fill="#8b98a5" fontSize={11}>{lab(t0)}</text>
      <text x={W - pad.r} y={H - 4} fill="#8b98a5" fontSize={11} textAnchor="end">{lab(t1)}</text>
    </svg>
  );
}
