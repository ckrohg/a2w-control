"use client";
// @purpose Plan page client (route /optimize). TOP of page shows the planner's hour-by-hour
// schedule and the REAL autonomy state, read from the planner's controller_status heartbeat:
//   1. "Running now" — data-driven from the heartbeat (auto-pilot + Phase B: off / shadow / live,
//      plus a reporting/stale indicator). This is ground truth and CANNOT drift from the planner.
//      The Off·Set·Request·Armed switch below it: Off and Armed ACTUATE (W2-B — they POST to the
//      planner's guarded /api/autonomy, flipping both controllers shadow↔live via controller_flags);
//      Set & forget and Request are still PREVIEW ONLY (they re-render the chart, no planner mode
//      exists for them yet — honest fast-follow). The switch seeds from the planner's runtime row.
//   2. Boost card — presets + a Custom… reveal + a capacity readout. PREVIEW ONLY: it overlays a
//      raised segment on the chart; it does not call the planner's boost endpoint yet.
//   3. The timeline chart — a devicePixelRatio-aware canvas; ports the mockup's drawPlan/cop model.
//   4. "How it reacts to demand" copy card.
// Both levers are live-capable: the HP setpoint (Modbus) and the buffer-tank target (the HBX cloud
// reset-curve dial — proven; it adopts on the next reheat cycle), both through the guarded writer.
// BOTTOM keeps the guarded 131°F summer recommendation + Restore (Apply is live, same I4/I1 guards).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const COP_SENS_PER_F = 0.01; // ~1%/°F — rough; A-4 measures the real slope

const SAFE_FLOOR_F = 131; // ≥ daily sanitize threshold → no separate sanitize automation needed
const WINTER_CUTOFF_F = 50; // below this outdoor temp, a static cool tank would underheat the rooms
const CEFF_GAL = 110; // tank C_eff (gal), measured/learned by TempIQ — see ceff-110-gallons memory

// ---- shared data model (24 blocks per plan; mirrors curve/page.tsx) -------------------
export type ShadowBlock = {
  ts: string;
  outdoor_f: number;
  tank_target_f: number;
  hp1_setpoint_f: number;
  reason: string;
};

// Real controller state, read server-side from the planner's controller_status heartbeat.
export type ControllerState = { enabled: boolean; dryRun: boolean; result: string | null; targetF?: number | null };
export type Autonomy = {
  reporting: boolean; // heartbeat fresh (< 15 min old)
  ageMin: number | null; // minutes since the planner last reported (server-computed → no hydration drift)
  autopilot: ControllerState;
  phaseb: ControllerState;
} | null;

// off (flag not set) / shadow (on, dry-run — logs but writes nothing) / live (on, writing).
function ctrlState(c: ControllerState): { label: string; cls: string } {
  if (!c.enabled) return { label: "off", cls: "st-off" };
  if (c.dryRun) return { label: "shadow · dry-run", cls: "st-shadow" };
  return { label: "live", cls: "st-live" };
}

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
  auto_sanitize_enabled?: boolean;
  error?: string;
};

// ---- COP model (ported verbatim from the mockup's shared model) -----------------------
function frac(o: number): number {
  if (o >= 45) return 0.5;
  if (o >= 0) return 0.3 + (o / 45) * 0.2;
  if (o >= -15) return 0.22 + ((o + 15) / 15) * 0.08;
  return 0.22;
}
function cop(o: number, t: number): number {
  const Tc = t + 10 + 459.67;
  const Te = o - 12 + 459.67;
  const ideal = Tc / Math.max(Tc - Te, 1);
  return Math.max(0.4, Math.min(5.0, frac(o) * ideal));
}
function clamp(v: number, a: number, b: number): number {
  return Math.min(Math.max(v, a), b);
}
// held reset curve (tank tracks outdoor, ignores the clock)
function setCurve(o: number): number {
  return clamp(Math.round(118 + (65 - o) * 0.8), 116, 165);
}
// field shade for a COP value (mockup fieldColor)
function fieldColor(c: number): string {
  const k = Math.max(0, Math.min(1, (c - 1) / (4.3 - 1)));
  const h = 8 + k * (122 - 8);
  const L = 20 + k * 13;
  return `hsla(${h.toFixed(0)},30%,${L.toFixed(0)}%,0.55)`;
}
// COP dot/line color (mockup copDot)
function copDot(c: number): string {
  const k = Math.max(0, Math.min(1, (c - 1) / (4.3 - 1)));
  return `hsl(${(8 + k * (122 - 8)).toFixed(0)},46%,52%)`;
}
function hh(h: number): string {
  const ap = h < 12 ? "AM" : "PM";
  let d = h % 12;
  if (d === 0) d = 12;
  return d + " " + ap;
}
const MONO = 'ui-monospace,"SF Mono",Menlo,monospace';

// ---- autonomy copy (ported from the mockup's COPY object) -----------------------------
type Mode = "off" | "set" | "req" | "arm";
type ModeCopy = { name: string; chip: string; chipClass: string; desc: string; trade: string };
const COPY: Record<Mode, ModeCopy> = {
  off: {
    name: "Off — advisory",
    chip: "shadow",
    chipClass: "chip-off",
    desc:
      "The plan is what the planner would do. Nothing here acts on its own — you enact setpoints yourself when you choose.",
    trade: "No savings, but full control — you watch and nothing moves on its own.",
  },
  set: {
    name: "Set & forget — hold one curve",
    chip: "static",
    chipClass: "chip-set",
    desc:
      "The planner picks one optimized reset curve — the tank tracks outdoor (hotter when cold, cooler when mild) but ignores the clock. Approve it once; it holds until you change it or the season shifts.",
    trade:
      "Safe and predictable — a curve keeps enough heat for baseboard in the cold and trims the tank when mild, so it can't leave you short. But it can't shift charges into the cheapest hours or coast through idle gaps the way the hourly plan does.",
  },
  req: {
    name: "Request — approve each change",
    chip: "approve",
    chipClass: "chip-req",
    desc:
      "The planner proposes the full hourly plan; you decide. Every hour whose HP setpoint changes waits for a ✓ (or approve the whole day). Nothing runs unapproved.",
    trade:
      "Captures the dynamic savings while you stay in the loop — but it wants your attention through the day.",
  },
  arm: {
    name: "Armed — autonomous",
    chip: "live",
    chipClass: "chip-arm",
    desc:
      "The planner drives the HP setpoint itself, re-planning every 15 min as the day actually unfolds. It follows the plan without asking; a human write always preempts it.",
    trade:
      "Most savings, zero effort — the temperature moves on its own inside your guardrails, and Boost or any human write always wins.",
  },
};

// ---- boost model ----------------------------------------------------------------------
type BoostKind = "dhw" | "heat";
type Boost = { start: number; hours: number; target: number; kind: BoostKind; zone: string };

function boostCap(tankB: number, kind: BoostKind, zone: string): { line: string; est: string } {
  if (kind === "heat") {
    const mins = Math.round(48 + (tankB - 120) * 5);
    return {
      line: `≈ ${mins} min of extra ${zone} heat`,
      est: `estimate from TempIQ — zone design load + tank C_eff ${CEFF_GAL} gal`,
    };
  }
  const gal = Math.max(0, Math.round((tankB - 110) * 3.4));
  const shower = Math.round(gal / 2);
  return {
    line: `≈ ${gal} gal of hot water · about ${shower} min of showers`,
    est: `estimate from TempIQ — tank C_eff ${CEFF_GAL} gal + DHW draw model`,
  };
}

// ---- the timeline chart (canvas, ported from the mockup's drawPlan) -------------------
const PMIN = 58, PMAX = 146, CMIN = 1, CMAX = 5;
const MP = { l: 40, r: 44, t: 16, b: 30 };

type PlanGeo = {
  X: (h: number) => number;
  Xc: (h: number) => number;
  pw: number;
  tank: number[];
  hp: number[];
  copA: number[];
};

function PlanChart({
  blocks,
  mode,
  boost,
  nowH,
}: {
  blocks: ShadowBlock[];
  mode: Mode;
  boost: Boost | null;
  nowH: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const geoRef = useRef<PlanGeo | null>(null);

  // Derived plan arrays from the real blocks (advisory tank + executing HP + outdoor + reasons).
  const OUT = useMemo(() => blocks.map((b) => b.outdoor_f), [blocks]);
  const TANK = useMemo(() => blocks.map((b) => b.tank_target_f), [blocks]);
  const HPbase = useMemo(() => blocks.map((b) => b.hp1_setpoint_f), [blocks]);
  const WHY = useMemo(() => blocks.map((b) => b.reason), [blocks]);

  const draw = useCallback(() => {
    const pc = canvasRef.current;
    if (!pc) return;
    const px2 = pc.getContext("2d");
    if (!px2) return;
    const parent = pc.parentElement;
    const W = (parent?.clientWidth || 900);
    const H = Math.max(320, Math.min(400, W * 0.42));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    pc.width = W * dpr;
    pc.height = H * dpr;
    pc.style.height = H + "px";
    px2.setTransform(dpr, 0, 0, dpr, 0, 0);
    px2.clearRect(0, 0, W, H);
    const pw = W - MP.l - MP.r;
    const ph = H - MP.t - MP.b;
    const X = (h: number) => MP.l + (h / 24) * pw;
    const Xc = (h: number) => X(h + 0.5);
    const Y = (v: number) => MP.t + (1 - (v - PMIN) / (PMAX - PMIN)) * ph;
    const Yc = (c: number) => MP.t + (1 - (c - CMIN) / (CMAX - CMIN)) * ph;
    const isSet = mode === "set";

    // per-mode plan arrays; set&forget holds one reset curve (tracks outdoor, ignores the clock)
    const tankArr = isSet ? OUT.map(setCurve) : TANK.slice();
    const hpArr = isSet ? tankArr.map((t) => Math.min(t + 5, 160)) : HPbase.slice();
    if (boost) {
      for (let bb = 0; bb < boost.hours; bb++) {
        const bh = (boost.start + bb) % 24;
        if (bh >= tankArr.length) continue;
        hpArr[bh] = Math.max(hpArr[bh], boost.target);
        tankArr[bh] = Math.max(tankArr[bh], boost.target - 5);
      }
    }
    const copArr = OUT.map((o, i) => cop(o, tankArr[i]));
    const changes = hpArr.map((v, i) => i !== 0 && v !== hpArr[(i + 23) % 24]);
    geoRef.current = { X, Xc, pw, tank: tankArr, hp: hpArr, copA: copArr };

    // COP background columns
    for (let h = 0; h < 24; h++) {
      px2.fillStyle = fieldColor(copArr[h] ?? 1);
      px2.globalAlpha = 0.5;
      px2.fillRect(X(h), MP.t, pw / 24 + 0.6, ph);
    }
    px2.globalAlpha = 1;
    // DHW window bands
    ([[6, 9], [17, 22]] as const).forEach((w) => {
      px2.fillStyle = "rgba(127,227,227,0.09)";
      px2.fillRect(X(w[0]), MP.t, X(w[1]) - X(w[0]), ph);
    });
    // boost window band
    if (boost) {
      const bx0 = X(boost.start);
      const bx1 = X(boost.start + boost.hours);
      px2.fillStyle = "rgba(224,178,77,0.14)";
      px2.fillRect(bx0, MP.t, bx1 - bx0, ph);
    }
    // gridlines
    px2.strokeStyle = "rgba(255,255,255,0.05)";
    px2.lineWidth = 1;
    [60, 80, 100, 120, 140].forEach((v) => {
      px2.beginPath();
      px2.moveTo(MP.l, Y(v));
      px2.lineTo(MP.l + pw, Y(v));
      px2.stroke();
    });

    px2.save();
    px2.beginPath();
    px2.rect(MP.l, MP.t, pw, ph);
    px2.clip();

    // outdoor smooth line
    px2.strokeStyle = "rgba(90,143,202,0.85)";
    px2.lineWidth = 2;
    px2.beginPath();
    OUT.forEach((v, h) => {
      const x = Xc(h), y = Y(v);
      h ? px2.lineTo(x, y) : px2.moveTo(x, y);
    });
    px2.stroke();

    // expected COP (right axis)
    px2.strokeStyle = "rgba(227,189,99,0.7)";
    px2.lineWidth = 1.6;
    px2.setLineDash([1, 3]);
    px2.beginPath();
    copArr.forEach((v, h) => {
      const x = Xc(h), y = Yc(v);
      h ? px2.lineTo(x, y) : px2.moveTo(x, y);
    });
    px2.stroke();
    px2.setLineDash([]);

    // stepped tank target (advisory, dashed) + HP setpoint (solid, executes)
    stepLine(px2, tankArr, X, Y, "rgba(125,97,196,0.85)", 2, [6, 4]);
    stepLine(px2, hpArr, X, Y, "rgba(180,140,255,0.95)", 3, null);

    // change markers on HP line (none in set&forget — it never changes)
    if (!isSet) {
      for (let mIdx = 0; mIdx < 24; mIdx++) {
        if (!changes[mIdx]) continue;
        const x = Xc(mIdx), y = Y(hpArr[mIdx]);
        px2.fillStyle = mode === "arm" ? "rgba(75,189,119,0.95)" : "rgba(180,140,255,0.95)";
        px2.beginPath();
        px2.arc(x, y, 4, 0, 7);
        px2.fill();
        px2.strokeStyle = "#0b0e15";
        px2.lineWidth = 1.5;
        px2.stroke();
      }
    }
    // now line
    const nx = Xc(nowH);
    px2.strokeStyle =
      mode === "arm" ? "rgba(75,189,119,0.8)" : isSet ? "rgba(127,227,227,0.8)" : "rgba(180,140,255,0.8)";
    px2.lineWidth = 1.5;
    px2.setLineDash([4, 3]);
    px2.beginPath();
    px2.moveTo(nx, MP.t);
    px2.lineTo(nx, MP.t + ph);
    px2.stroke();
    px2.setLineDash([]);
    px2.restore();
    px2.fillStyle = mode === "arm" ? "#7fe0a4" : isSet ? "#a7e9e6" : "#c9b3ff";
    px2.font = "600 10.5px " + MONO;
    px2.textAlign = "center";
    px2.fillText(mode === "arm" ? "now · acting" : isSet ? "now · holding" : "now", nx, MP.t - 2);

    // DHW + boost labels
    px2.fillStyle = "rgba(127,227,227,0.6)";
    px2.font = "10px " + MONO;
    px2.textAlign = "center";
    px2.fillText("DHW", X(7.5), MP.t + 11);
    px2.fillText("DHW", X(19.5), MP.t + 11);
    if (boost) {
      px2.fillStyle = "rgba(232,178,90,0.95)";
      px2.fillText("BOOST", X(boost.start + boost.hours / 2), MP.t + ph - 9);
    }

    // axes
    px2.fillStyle = "#71809a";
    px2.font = "11px " + MONO;
    px2.textAlign = "right";
    px2.textBaseline = "middle";
    [60, 80, 100, 120, 140].forEach((v) => px2.fillText(v + "°", MP.l - 7, Y(v)));
    px2.textAlign = "left";
    px2.fillStyle = "rgba(227,189,99,0.75)";
    [1, 2, 3, 4, 5].forEach((c) => px2.fillText(String(c), MP.l + pw + 8, Yc(c)));
    px2.fillStyle = "#71809a";
    px2.textAlign = "center";
    px2.textBaseline = "top";
    [0, 6, 12, 18, 24].forEach((h) =>
      px2.fillText(
        h === 0 ? "12A" : h === 12 ? "12P" : h === 24 ? "12A" : (h % 12) + (h < 12 ? "A" : "P"),
        X(h),
        MP.t + ph + 8,
      ),
    );
  }, [OUT, TANK, HPbase, mode, boost, nowH]);

  // redraw on [blocks, mode, boost] (draw depends on all of them) and on resize
  useEffect(() => {
    draw();
    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(draw, 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(rt);
      window.removeEventListener("resize", onResize);
    };
  }, [draw]);

  // hover tooltip
  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const geo = geoRef.current;
    const pc = canvasRef.current;
    const tip = tipRef.current;
    if (!geo || !pc || !tip) return;
    const r = pc.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const h = Math.floor((mx - MP.l) / (geo.pw / 24));
    if (h < 0 || h > 23 || mx < MP.l || mx > MP.l + geo.pw) {
      tip.style.opacity = "0";
      return;
    }
    const inBoost = !!boost && (((h - boost.start + 24) % 24) < boost.hours);
    const why = inBoost
      ? "Boosted — reverts to the plan after"
      : mode === "set"
        ? "Held reset curve — tracks outdoor, not the clock"
        : WHY[h] ?? "";
    tip.innerHTML =
      '<div class="pt-th">' +
      hh(h).replace(" ", "") +
      ":00" +
      (h === nowH ? " · now" : "") +
      (inBoost ? " · boost" : "") +
      "</div>" +
      '<div class="pt-row"><span>Outdoor</span><b>' +
      (OUT[h] ?? "—") +
      "°</b></div>" +
      '<div class="pt-row"><span>Tank target</span><b style="color:#b9a3e6">' +
      geo.tank[h] +
      "° adv</b></div>" +
      '<div class="pt-row"><span>HP setpoint</span><b style="color:#c9b3ff">' +
      geo.hp[h] +
      "°</b></div>" +
      '<div class="pt-row"><span>Exp. COP</span><b style="color:' +
      copDot(geo.copA[h]) +
      '">' +
      geo.copA[h].toFixed(1) +
      "</b></div>" +
      '<div class="pt-why">' +
      why +
      "</div>";
    let tx = geo.Xc(h) + 14;
    if (tx > r.width - 170) tx = geo.Xc(h) - 164;
    tip.style.left = tx + "px";
    tip.style.top = MP.t + 6 + "px";
    tip.style.opacity = "1";
  };
  const onLeave = () => {
    if (tipRef.current) tipRef.current.style.opacity = "0";
  };

  return (
    <div className="plan-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="plan-canvas"
        role="img"
        aria-label="Timeline of today's plan: stepped HP setpoint and tank-target lines in violet, a smooth outdoor temperature line, expected COP, DHW windows shaded, and a marker at the current hour."
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      />
      <div ref={tipRef} className="plan-tip" />
    </div>
  );
}

// stepped line (ported from the mockup's stepLine)
function stepLine(
  c: CanvasRenderingContext2D,
  arr: number[],
  X: (h: number) => number,
  Y: (v: number) => number,
  style: string,
  w: number,
  dash: number[] | null,
) {
  c.strokeStyle = style;
  c.lineWidth = w;
  if (dash) c.setLineDash(dash);
  c.beginPath();
  for (let h = 0; h < 24; h++) {
    const y = Y(arr[h]);
    c.moveTo(X(h), y);
    c.lineTo(X(h + 1), y);
    if (h < 23) {
      const yn = Y(arr[h + 1]);
      c.moveTo(X(h + 1), y);
      c.lineTo(X(h + 1), yn);
    }
  }
  c.stroke();
  c.setLineDash([]);
}

// =======================================================================================
export default function OptimizeClient({
  rate,
  dailyKwh,
  blocks,
  computedAt,
  autonomy,
  initialMode = "off",
}: {
  rate: number;
  dailyKwh: number;
  blocks: ShadowBlock[];
  computedAt: number | null;
  autonomy: Autonomy;
  initialMode?: Mode;
}) {
  const router = useRouter();
  // ---- autonomy + boost view state --------------------------------------------------
  // mode seeds from the planner's RUNTIME autonomy row (initialMode). Off/Armed actuate; Set/Request
  // are chart previews only. (Boost state below is still preview.)
  const [mode, setMode] = useState<Mode>(initialMode);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState("");
  const [boost, setBoost] = useState<Boost | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDeg, setCustomDeg] = useState(8);
  const [customHrs, setCustomHrs] = useState(3);
  // display-only ✓ toggles for the Request-mode "changes waiting" chips
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const nowH = useMemo(() => new Date().getHours(), []);

  const hasPlan = blocks.length > 0;
  const copyM = COPY[mode];

  // Real controller badges from the heartbeat (null until the planner first reports).
  const apS = autonomy ? ctrlState(autonomy.autopilot) : null;
  const pbS = autonomy ? ctrlState(autonomy.phaseb) : null;
  const anyLive =
    !!autonomy &&
    ((autonomy.autopilot.enabled && !autonomy.autopilot.dryRun) ||
      (autonomy.phaseb.enabled && !autonomy.phaseb.dryRun));
  const bothOff = !!autonomy && !autonomy.autopilot.enabled && !autonomy.phaseb.enabled;

  // ONE autonomy concept (owner: "it's just one thing — make it appear that way"). The tank target
  // and the pump setpoints are two hands of the same motion (the setpoint serves the target, kept
  // coordinated by the I1 guardrail). systemLive = the system is driving itself. The per-lever badges
  // survive as under-the-hood DETAIL (transparency — never hide the real runtime state), and the
  // pump-side write reliability shows as HEALTH, not a second mode.
  const systemLive = anyLive;
  const handText = (c: ControllerState) => (!c.enabled ? "off" : c.dryRun ? "advisory" : "live");
  // Pump-setpoint write health: live but its last result reports a failure ⇒ retrying (not a mode).
  const pumpRetrying =
    !!autonomy && autonomy.phaseb.enabled && !autonomy.phaseb.dryRun &&
    /fail|error|timeout/i.test(autonomy.phaseb.result ?? "");

  // HP setpoint changes across the day → the Request-mode chips row (display-only).
  const changeHours = useMemo(() => {
    if (!hasPlan) return [] as { h: number; from: number; to: number }[];
    const hp = blocks.map((b) => b.hp1_setpoint_f);
    const n = hp.length;
    const out: { h: number; from: number; to: number }[] = [];
    for (let i = 0; i < n; i++) {
      const prev = hp[(i + n - 1) % n];
      if (i !== 0 && hp[i] !== prev) out.push({ h: i, from: prev, to: hp[i] });
    }
    return out;
  }, [blocks, hasPlan]);

  // boost capacity readout — target-5 is the tank floor the boost lifts to (mockup applyBoost)
  const cap = boost ? boostCap(boost.target - 5, boost.kind, boost.zone) : null;
  const boostEndLabel = boost ? hh((boost.start + boost.hours) % 24).replace(" ", "") : "";

  const applyBoost = (b: Boost | null) => setBoost(b);
  const applyCustom = () => {
    const d = clamp(Math.round(customDeg) || 8, 1, 30);
    const y = clamp(Math.round(customHrs) || 3, 1, 24);
    applyBoost({ start: nowH, hours: y, target: 124 + d, kind: "dhw", zone: "the zone" });
  };
  const toggleApproved = (h: number) =>
    setApproved((prev) => {
      const next = new Set(prev);
      next.has(h) ? next.delete(h) : next.add(h);
      return next;
    });
  const approveAll = () => setApproved(new Set(changeHours.map((c) => c.h)));

  // ---- existing HbxStatus poll (unchanged) for the bottom 131° recommendation ---------
  const savedPerMonth = (dropF: number) => Math.max(0, dropF) * COP_SENS_PER_F * dailyKwh * rate * 30;
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

  // W2-B: the Off/Armed switch actuator. Off and Armed POST to the planner (via the token-holding
  // proxy) to flip both controllers shadow↔live; Set & forget and Request are chart PREVIEWS only
  // (no planner mode exists yet) so they just change the local view. Arming is confirmed because it
  // hands the live heat pumps to the planner — but it's fully reversible (Off restores shadow next
  // cycle) and a manual write / Boost always preempts. Optimistic UI with revert on failure.
  async function selectMode(next: Mode) {
    if (next === mode) return;
    if (next === "set" || next === "req") {
      setMode(next); // preview only — re-renders the chart, does not actuate
      setAutoMsg("");
      return;
    }
    const goLive = next === "arm";
    if (
      goLive &&
      !window.confirm(
        "Arm autonomy? The planner will drive the buffer target itself (and Phase B setpoints if enabled), inside the I4/I1 guardrails. A manual write or Boost always preempts it, and switching to Off returns everything to advisory. Continue?",
      )
    )
      return;
    const prev = mode;
    setMode(next); // optimistic
    setAutoBusy(true);
    setAutoMsg("");
    try {
      const res = await fetch("/api/planner/autonomy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const out: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (res.ok) {
        setAutoMsg(
          goLive
            ? "Armed — the planner is now driving, inside the guardrails. Takes effect within one cycle."
            : "Off — both controllers return to advisory (shadow) on the next cycle. Nothing writes.",
        );
        router.refresh(); // re-read the runtime row + heartbeat so "Running now" reflects the flip
      } else {
        setMode(prev); // revert — the planner rejected it
        setAutoMsg(`Couldn't change mode: ${out.error || res.status}`);
      }
    } catch {
      setMode(prev);
      setAutoMsg("Network error — mode unchanged.");
    } finally {
      setAutoBusy(false);
    }
  }

  // Single guarded write / restore — reports the accepted/rejected result exactly like
  // HbxTargetCard's act(). window.confirm gate per spec. (Apply stays DISABLED; Restore live.)
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
      const out: { ok?: boolean; detail?: string; error?: string } = await res.json().catch(() => ({}));
      setMsg(res.ok ? `${out.detail || "Done"} ✓` : `Rejected: ${out.error || out.detail || res.status}`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
      load();
    }
  }

  // ---- recommendation-card derived values (mirrors the old summer-floor card) ----------
  const outdoor = st?.outdoor_f ?? null;
  const canRecommend = outdoor != null && outdoor >= WINTER_CUTOFF_F;
  const target = st?.target_f ?? null;
  const dropF = target == null ? 0 : Math.max(0, target - SAFE_FLOOR_F);
  const savedUsd = savedPerMonth(dropF);
  const alreadyApplied = !!st?.curve_overridden && target === SAFE_FLOOR_F;

  const computedLabel =
    computedAt != null
      ? new Date(computedAt * 1000).toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          month: "short",
          day: "numeric",
          timeZone: "America/New_York",
        })
      : null;

  return (
    <div style={{ marginTop: 4 }}>
      {/* ============ AUTONOMY + honest posture ============ */}
      <div className="plan-top">
        <div className="card">
          <p className="plan-eyebrow">Autonomy · Off &amp; Armed are live</p>
          <div className="plan-seg" role="group" aria-label="Autonomy level">
            {(["off", "set", "req", "arm"] as Mode[]).map((m) => {
              const preview = m === "set" || m === "req"; // no planner mode yet → chart preview only
              return (
                <button
                  key={m}
                  type="button"
                  className={`ps-btn ps-${m}`}
                  aria-pressed={mode === m}
                  disabled={autoBusy}
                  title={preview ? "Preview only — this mode isn't live yet" : undefined}
                  onClick={() => selectMode(m)}
                >
                  <span className="ps-led" />
                  {m === "off" ? "Off" : m === "set" ? "Set & forget" : m === "req" ? "Request" : "Armed"}
                  {preview && <span className="ps-soon">soon</span>}
                </button>
              );
            })}
          </div>
          {autoMsg && (
            <p className="pm-desc" style={{ color: autoMsg.startsWith("Couldn't") || autoMsg.startsWith("Network") ? "var(--warm)" : "var(--ok)", marginTop: 8 }}>
              {autoMsg}
            </p>
          )}

          <div className="plan-mode-copy">
            <div className="pm-state">
              <span>{copyM.name}</span>
              <span className={`plan-statuschip ${copyM.chipClass}`}>{copyM.chip}</span>
            </div>
            <p className="pm-desc">{copyM.desc}</p>
            <p className="plan-tradeoff">
              <b>Trade-off · </b>
              {copyM.trade}
            </p>
          </div>

          {/* REAL live state — read from the planner's controller_status heartbeat (ground truth,
              cannot drift). Off/Armed on the switch actuate; THIS reflects the effective runtime flags. */}
          <div className="plan-live">
            <div className="plan-live-head">
              <span className="pl-eyebrow2">Running now</span>
              {autonomy ? (
                autonomy.reporting ? (
                  <span className="pl-beat ok">planner reporting</span>
                ) : (
                  <span className="pl-beat stale">
                    planner quiet{autonomy.ageMin != null ? ` · ${autonomy.ageMin} min ago` : ""}
                  </span>
                )
              ) : (
                <span className="pl-beat stale">no report yet</span>
              )}
            </div>

            {autonomy && apS && pbS ? (
              <>
                {/* ONE state — the system as a single self-driving thing. */}
                <div className="pl-ctrl">
                  <span className="pl-ctrl-name">Autonomous mode</span>
                  <span className={`pl-badge ${systemLive ? "st-live" : "st-shadow"}`}>
                    {systemLive ? "on" : "advisory"}
                  </span>
                  <span className="pl-ctrl-detail">
                    {systemLive
                      ? `driving the system to ${autonomy.autopilot.targetF ?? "the plan’s"}°F, inside the guardrails`
                      : "computing the plan and logging what it would do — writing nothing on its own"}
                  </span>
                </div>

                {/* Under-the-hood detail: the two coordinated hands of that one motion. Kept visible
                    for transparency, but framed as detail, not two separate systems to reason about. */}
                <div className="pl-hands">
                  <span className="pl-hand">
                    <span className="pl-hand-dot" /> Tank target <span className="dim">· {handText(autonomy.autopilot)}</span>
                  </span>
                  <span className="pl-hand">
                    <span className="pl-hand-dot" /> Pump setpoints <span className="dim">· {handText(autonomy.phaseb)}</span>
                    {pumpRetrying && <b style={{ color: "var(--warm)" }}> · retrying</b>}
                  </span>
                </div>

                <p className="pl-summary">
                  {systemLive
                    ? "The system is driving itself — the tank target and the pump setpoints move together (the setpoints serve the target for the best efficiency), always inside the I4/I1 safety guardrails. A manual write or Boost always wins."
                    : bothOff
                      ? "Advisory only — nothing moves on its own; you set the temperature yourself."
                      : "Advisory only — the plan is computed and logged, but nothing is written until you Arm it."}
                  {pumpRetrying && " The pump-setpoint side is currently retrying its writes; the tank target keeps working meanwhile."}
                </p>
              </>
            ) : (
              <p className="pl-summary">
                Waiting for the planner’s first status heartbeat. Until it reports, treat the switch
                above as a preview only.
              </p>
            )}

            <p className="pl-note">
              <b>Off</b> and <b>Armed</b> above take effect on the system — they flip both controllers
              between advisory (shadow) and live, inside the I4/I1 guardrails, and are reported here on
              the next cycle. <b>Set &amp; forget</b> and <b>Request</b> are previews of upcoming modes —
              they change the chart but don’t run yet.
            </p>
          </div>

          {/* Request mode: display-only "changes waiting" chips */}
          {mode === "req" && (
            <div className="plan-rail">
              <div className="plan-rail-head">
                <p className="plan-eyebrow" style={{ margin: 0 }}>
                  Changes waiting for you
                </p>
                <button type="button" className="plan-approve-all" onClick={approveAll}>
                  ✓ Approve all
                </button>
              </div>
              {changeHours.length === 0 ? (
                <div className="meta">No HP-setpoint changes in today&apos;s plan.</div>
              ) : (
                <div className="plan-chips">
                  {changeHours.map((c) => {
                    const on = approved.has(c.h);
                    return (
                      <span key={c.h} className={`plan-chip${on ? " ok" : ""}`}>
                        <span>
                          {hh(c.h)} · <span className="pc-hp">HP {c.from}→{c.to}°</span>
                        </span>
                        <button
                          type="button"
                          className="pc-tk"
                          aria-pressed={on}
                          aria-label="Approve"
                          onClick={() => toggleApproved(c.h)}
                        >
                          ✓
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Armed mode: acting note */}
          {mode === "arm" && (
            <div className="plan-armnote">
              Armed is live: the planner asserts these HP setpoints itself every cycle, inside the
              I4/I1 guardrails; a human write (here or at the wall) always preempts it. “Running now”
              above shows what it’s actually doing right now.
            </div>
          )}
        </div>

        <div className="plan-honest">
          <div className="ph-h">Two levers, both wired</div>
          The planner moves two things: the <b>heat-pump setpoint</b> (Modbus — the biggest mild-day
          COP lever) and the <b>buffer-tank target</b> (the HBX cloud reset-curve dial — <b>proven</b>;
          it adopts on the next reheat cycle). Both route through the guarded writer (I4 envelope, I1
          cross-check, sanitize floor, rate limit), and the two lines are drawn so they can never
          cross. Whether either is <em>actually writing</em> right now is shown in “Running now”.
        </div>
      </div>

      {/* ============ BOOST (preview only) ============ */}
      <div className="card plan-boost">
        <div className="pb-row">
          <p className="plan-eyebrow" style={{ margin: 0 }}>
            Need more, briefly?
          </p>
          <span className={`pb-status${boost ? " on" : ""}`}>
            {boost ? `boosting to ${boost.target}° until ${boostEndLabel} — reverts to plan` : "off"}
          </span>
        </div>
        <div className="pb-btns">
          <button type="button" onClick={() => applyBoost({ start: nowH, hours: 2, target: 132, kind: "dhw", zone: "the zone" })}>
            Long shower · 2 h
          </button>
          <button type="button" onClick={() => applyBoost({ start: nowH, hours: 8, target: 132, kind: "dhw", zone: "the zone" })}>
            Guests / full house · 8 h
          </button>
          <button type="button" onClick={() => applyBoost({ start: nowH, hours: 4, target: 138, kind: "heat", zone: "Living Room" })}>
            Extra heat · 4 h
          </button>
          <button
            type="button"
            className="pb-custom-toggle"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
          >
            Custom…
          </button>
          <button type="button" className="pb-clear" onClick={() => applyBoost(null)}>
            Clear
          </button>
        </div>
        {customOpen && (
          <div className="pb-custom">
            <label>
              +
              <input
                type="number"
                min={1}
                max={30}
                value={customDeg}
                aria-label="degrees warmer"
                onChange={(e) => setCustomDeg(Number(e.target.value))}
              />
              °
            </label>
            <label>
              for{" "}
              <input
                type="number"
                min={1}
                max={24}
                value={customHrs}
                aria-label="hours"
                onChange={(e) => setCustomHrs(Number(e.target.value))}
              />{" "}
              h
            </label>
            <button type="button" className="pb-apply" onClick={applyCustom}>
              Apply
            </button>
          </div>
        )}
        {cap && (
          <div className="pb-cap">
            {cap.line}
            <span className="pb-est">{cap.est}</span>
          </div>
        )}
        <p className="pb-note">
          Tell the planner about a draw it can&apos;t forecast. It lifts the floor for the window,
          then automatically falls back to the plan — even in <b style={{ color: "#4bbd77" }}>Armed</b>.{" "}
          <b>Preview — these buttons don&apos;t call the planner yet (the write path itself is live).</b>
        </p>
      </div>

      {/* ============ TIMELINE CHART ============ */}
      <div className="card plan-plotcard">
        <div className="plan-plothead">
          <p className="plan-eyebrow" style={{ margin: 0 }}>
            °F (left) · expected COP (right) × hour of day
          </p>
          <span className="plan-hint">
            {computedLabel ? `computed ${computedLabel}` : "computed 12:05 AM"} · times Eastern
          </span>
        </div>
        {hasPlan ? (
          <PlanChart blocks={blocks} mode={mode} boost={boost} nowH={nowH} />
        ) : (
          <div className="empty">No plan computed yet — the planner writes one at 12:05 AM Eastern.</div>
        )}
        {hasPlan && (
          <div className="plan-legend">
            <span className="pl-grp">
              <span className="pl-line" style={{ borderTop: "3px solid #b48cff" }} />
              HP setpoint <span className="dim3">(Phase B tracks)</span>
            </span>
            <span className="pl-grp">
              <span className="pl-line" style={{ borderTop: "2px dashed #7d61c4" }} />
              tank target <span className="dim3">(auto-pilot tracks)</span>
            </span>
            <span className="pl-grp">
              <span className="pl-line" style={{ borderTop: "2px solid #5a8fca" }} />
              outdoor
            </span>
            <span className="pl-grp">
              <span className="pl-line" style={{ borderTop: "2px solid #e3bd63" }} />
              expected COP
            </span>
            <span className="pl-grp">
              <span className="pl-swatch" style={{ background: "rgba(127,227,227,.14)" }} />
              DHW window
            </span>
            <span className="pl-grp">
              <span className="pl-swatch" style={{ background: "rgba(224,178,77,.16)" }} />
              boost window
            </span>
          </div>
        )}
      </div>

      {/* ============ HOW IT REACTS TO DEMAND ============ */}
      <div className="card plan-demand">
        <p className="plan-eyebrow">How it reacts when the day differs from the forecast</p>
        <div className="pd-grid">
          <div>
            <b>Instant swings are HBX&apos;s job.</b> A sudden draw or a zone call is answered in
            seconds by the HBX controller calling the pumps — the planner isn&apos;t in that fast loop.
          </div>
          <div>
            <b>The forward plan re-optimises.</b> Colder than forecast, or the tank ran low? It pulls
            the next charge earlier. Warmer with no draws? It coasts lower and skips a charge.
          </div>
          <div>
            <b>Baseboard calling lifts everything.</b> When a baseboard zone needs 160–180°, it raises
            the tank floor <em>and</em> the HP setpoint together — they can never cross.
          </div>
          <div>
            <b>What it can&apos;t predict, you hand it.</b> A long shower or a full house is the one
            input it has no way to forecast — that&apos;s the Boost above.
          </div>
        </div>
        <p className="pd-foot">
          Today the plan is computed once at 12:05 AM. Rolling re-optimisation on live state (tank
          temp, actual outdoor, live calls) is the upgrade Armed mode needs — built next, not yet live.
        </p>
      </div>

      {/* ============ SUMMER FLOOR RECOMMENDATION (bottom, guarded, apply LIVE) ============ */}
      <div className="card plan-rec">
        <span className="pr-num">{SAFE_FLOOR_F}°</span>
        <div className="pr-txt">
          <b>Summer floor recommendation.</b>
          {!loaded && !st ? (
            <p>Loading planner status…</p>
          ) : !st ? (
            <p>{msg || "Planner status unavailable — recommendation paused."}</p>
          ) : !canRecommend ? (
            <p>
              {outdoor == null
                ? "Confirming season — this cooler-tank recommendation is summer-only and won't offer to apply until an outdoor reading confirms it."
                : `Winter mode — a static cool tank would underheat the rooms. This interim tool is summer-only; outdoor is currently ${Math.round(
                    outdoor,
                  )}°F.`}
            </p>
          ) : (
            <p>
              Drop the tank floor to its safe summer minimum ({SAFE_FLOOR_F}°F ≥ the daily sanitize
              threshold) — about {Math.round(dropF)}°F cooler than today&apos;s {target == null ? "—" : `${Math.round(target)}°F`}{" "}
              target, roughly <b>${savedUsd.toFixed(0)}/mo</b>. Keeps pump setpoints unchanged, fully
              reversible, applied through the same I4/I1 guardrails.{" "}
              <a href="/curve" style={{ color: "#5a8fca" }}>
                Curve →
              </a>{" "}
              <a href="/savings" style={{ color: "#5a8fca" }}>
                Savings →
              </a>
            </p>
          )}
        </div>
        <div className="pr-actions">
          <button
            type="button"
            disabled={busy || !st || !canRecommend}
            onClick={() =>
              st &&
              act(
                "/api/planner/target",
                { target_f: SAFE_FLOOR_F },
                `Set the HBX tank target to ${SAFE_FLOOR_F}°F? This runs the tank ~22°F cooler while staying sanitized, and adopts on the next reheat cycle. Reversible via Restore curve. Pump setpoints must stay ≥${SAFE_FLOOR_F + (st?.i1_margin_f ?? 0)}°F, which is checked.`,
              )
            }
            title="Command the buffer target (adopts on the next reheat cycle)"
          >
            {alreadyApplied ? "Already applied ✓" : `Apply — floor to ${SAFE_FLOOR_F}°F`}
          </button>
          <button
            type="button"
            className="pr-restore"
            disabled={busy || !st}
            onClick={() =>
              st &&
              act(
                "/api/planner/restore",
                undefined,
                `Restore the as-found curve${st.baseline ? ` (${st.baseline.dbt}/${st.baseline.mbt}°F)` : ""}? This undoes the cooler-tank setting.`,
              )
            }
          >
            Restore as-found curve
          </button>
        </div>
        {msg && st ? <div className="pr-msg meta">{msg}</div> : null}
      </div>

      {/* Plan-specific styling — dark palette from the approved mockup (violet accents). The
          route reuses the dashboard's own .card/.cards/.meta/.chip/.empty/.banner/.dim classes;
          these cover the mock-switch, boost, trade-off and chart blocks the base CSS lacks. */}
      <style jsx>{`
        .dim3 {
          color: #71809a;
        }
        .plan-eyebrow {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #71809a;
          margin: 0 0 11px;
        }
        .plan-top {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
          margin-bottom: 18px;
        }
        @media (min-width: 760px) {
          .plan-top {
            grid-template-columns: 1.05fr 0.95fr;
          }
        }
        /* ---- autonomy segmented switch ---- */
        .plan-seg {
          display: inline-flex;
          flex-wrap: wrap;
          background: #0b0e15;
          border: 1px solid #232c40;
          border-radius: 11px;
          padding: 4px;
          gap: 3px;
        }
        .ps-btn {
          font: inherit;
          font-size: 13px;
          font-weight: 560;
          color: #71809a;
          background: none;
          border: 0;
          padding: 8px 12px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 7px;
          transition: 0.15s;
          min-height: 0;
        }
        .ps-btn:hover {
          color: #aab4c8;
          background: none;
        }
        .ps-btn:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .ps-soon {
          font-size: 9.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: #71809a;
          border: 1px solid #232c40;
          border-radius: 5px;
          padding: 1px 4px;
          margin-left: 1px;
        }
        .ps-btn[aria-pressed="true"] {
          color: #e7ebf3;
          background: #161d2e;
          box-shadow: inset 0 0 0 1px #232c40;
        }
        .ps-led {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #232c40;
          flex: none;
        }
        .ps-off[aria-pressed="true"] .ps-led {
          background: #71809a;
        }
        .ps-set[aria-pressed="true"] .ps-led {
          background: #7fe3e3;
          box-shadow: 0 0 0 3px rgba(127, 227, 227, 0.22);
        }
        .ps-req[aria-pressed="true"] .ps-led {
          background: #e0b24d;
          box-shadow: 0 0 0 3px rgba(224, 178, 77, 0.22);
        }
        .ps-arm[aria-pressed="true"] .ps-led {
          background: #4bbd77;
          box-shadow: 0 0 0 3px rgba(75, 189, 119, 0.24);
        }
        .plan-mode-copy {
          margin-top: 14px;
        }
        .pm-state {
          font-weight: 640;
          font-size: 15px;
          letter-spacing: -0.01em;
          display: flex;
          align-items: center;
          gap: 9px;
          flex-wrap: wrap;
        }
        .pm-desc {
          margin: 6px 0 0;
          color: #aab4c8;
          font-size: 13.5px;
          max-width: 54ch;
        }
        .plan-statuschip {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 10.5px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          padding: 3px 9px;
          border-radius: 999px;
          font-weight: 600;
        }
        .chip-off {
          background: rgba(113, 128, 154, 0.16);
          color: #aab4c8;
        }
        .chip-set {
          background: rgba(127, 227, 227, 0.14);
          color: #7fe3e3;
        }
        .chip-req {
          background: rgba(224, 178, 77, 0.15);
          color: #e0b24d;
        }
        .chip-arm {
          background: rgba(75, 189, 119, 0.16);
          color: #4bbd77;
        }
        .plan-tradeoff {
          margin-top: 12px;
          padding: 10px 12px;
          background: #0b0e15;
          border: 1px solid #232c40;
          border-radius: 9px;
          font-size: 12.5px;
          color: #aab4c8;
          line-height: 1.55;
        }
        .plan-tradeoff :global(b) {
          color: #e0b24d;
        }
        /* ---- "Running now" — real controller state from the heartbeat ---- */
        .plan-live {
          margin-top: 14px;
          padding: 12px 13px;
          background: #0b0e15;
          border: 1px solid #232c40;
          border-radius: 11px;
        }
        .plan-live-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .pl-eyebrow2 {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #e7ebf3;
          font-weight: 600;
        }
        .pl-beat {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 10.5px;
          letter-spacing: 0.06em;
          padding: 3px 9px;
          border-radius: 999px;
          white-space: nowrap;
        }
        .pl-beat.ok {
          background: rgba(75, 189, 119, 0.15);
          color: #4bbd77;
        }
        .pl-beat.stale {
          background: rgba(224, 178, 77, 0.15);
          color: #e0b24d;
        }
        .pl-ctrl {
          display: flex;
          align-items: center;
          gap: 9px;
          flex-wrap: wrap;
          padding: 7px 0;
          border-top: 1px solid #161d2e;
          font-size: 13px;
          color: #aab4c8;
        }
        .pl-ctrl:first-of-type {
          border-top: 0;
        }
        .pl-ctrl-name {
          font-weight: 600;
          color: #e7ebf3;
          min-width: 150px;
        }
        .pl-ctrl-name em {
          font-style: normal;
          font-weight: 400;
          color: #71809a;
        }
        .pl-hands {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 22px;
          padding: 4px 0 6px 12px;
          font-size: 12.5px;
          color: #8b98a5;
        }
        .pl-hand {
          display: inline-flex;
          align-items: center;
          gap: 7px;
        }
        .pl-hand-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #3a4650;
          flex: none;
        }
        .pl-badge {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 10.5px;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          padding: 3px 9px;
          border-radius: 999px;
          font-weight: 600;
        }
        .st-off {
          background: rgba(113, 128, 154, 0.16);
          color: #aab4c8;
        }
        .st-shadow {
          background: rgba(127, 227, 227, 0.14);
          color: #7fe3e3;
        }
        .st-live {
          background: rgba(75, 189, 119, 0.18);
          color: #4bbd77;
        }
        .pl-ctrl-detail {
          color: #71809a;
          font-size: 12.5px;
          font-variant-numeric: tabular-nums;
        }
        .pl-summary {
          margin: 10px 0 0;
          padding-top: 10px;
          border-top: 1px solid #161d2e;
          font-size: 12.5px;
          color: #aab4c8;
          line-height: 1.5;
        }
        .pl-note {
          margin: 8px 0 0;
          font-size: 11.5px;
          color: #71809a;
          line-height: 1.5;
        }
        .pl-note :global(b) {
          color: #aab4c8;
        }
        /* ---- request-mode chips rail ---- */
        .plan-rail {
          margin-top: 16px;
          padding-top: 15px;
          border-top: 1px solid #1b2233;
        }
        .plan-rail-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 11px;
          flex-wrap: wrap;
        }
        .plan-approve-all {
          font: inherit;
          font-size: 12.5px;
          font-weight: 600;
          color: #12331f;
          background: #4bbd77;
          border: 0;
          padding: 8px 13px;
          border-radius: 9px;
          cursor: pointer;
          min-height: 0;
        }
        .plan-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .plan-chip {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          background: #0b0e15;
          border: 1px solid #232c40;
          border-radius: 10px;
          padding: 7px 9px 7px 12px;
          font-size: 12.5px;
          color: #aab4c8;
          font-variant-numeric: tabular-nums;
        }
        .plan-chip.ok {
          border-color: rgba(75, 189, 119, 0.5);
          color: #e7ebf3;
        }
        .pc-hp {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          color: #b48cff;
        }
        .pc-tk {
          width: 22px;
          height: 22px;
          min-height: 0;
          border-radius: 6px;
          border: 1px solid #232c40;
          background: #161d2e;
          color: #71809a;
          font-size: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .plan-chip.ok .pc-tk {
          background: #4bbd77;
          color: #0c2415;
          border-color: #4bbd77;
        }
        .plan-armnote {
          margin-top: 16px;
          padding-top: 15px;
          border-top: 1px solid #1b2233;
          font-size: 12.5px;
          color: #71809a;
        }
        /* ---- mechanism card (informational, not a warning) ---- */
        .plan-honest {
          background: rgba(90, 143, 202, 0.06);
          border: 1px solid rgba(90, 143, 202, 0.22);
          border-radius: 14px;
          padding: 14px 16px;
          font-size: 13px;
          color: #aab4c8;
          line-height: 1.5;
        }
        .plan-honest :global(b) {
          color: #e7ebf3;
        }
        .ph-h {
          font-weight: 640;
          color: #e7ebf3;
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 5px;
          font-size: 13.5px;
        }
        /* ---- boost ---- */
        .plan-boost {
          margin-bottom: 18px;
        }
        .pb-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .pb-status {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: #71809a;
          letter-spacing: 0.02em;
        }
        .pb-status.on {
          color: #e0b24d;
        }
        .pb-btns {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .pb-btns button {
          font: inherit;
          font-size: 13px;
          font-weight: 500;
          color: #aab4c8;
          background: #0b0e15;
          border: 1px solid #232c40;
          padding: 9px 13px;
          border-radius: 9px;
          cursor: pointer;
          transition: 0.15s;
          min-height: 0;
        }
        .pb-btns button:hover {
          border-color: #e0b24d;
          color: #e7ebf3;
          background: #0b0e15;
        }
        .pb-btns button.pb-clear {
          color: #71809a;
          margin-left: auto;
        }
        .pb-custom-toggle[aria-expanded="true"] {
          border-color: #e0b24d;
          color: #e7ebf3;
        }
        .pb-custom {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 11px;
          font-size: 13px;
          color: #aab4c8;
        }
        .pb-custom label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .pb-custom input {
          width: 54px;
          background: #0b0e15;
          border: 1px solid #232c40;
          color: #e7ebf3;
          border-radius: 7px;
          padding: 6px 8px;
          font: inherit;
          font-variant-numeric: tabular-nums;
        }
        .pb-apply {
          font: inherit;
          font-size: 12.5px;
          font-weight: 600;
          color: #e7ebf3;
          background: #161d2e;
          border: 1px solid #232c40;
          padding: 7px 13px;
          border-radius: 8px;
          cursor: pointer;
          min-height: 0;
        }
        .pb-apply:hover {
          border-color: #e0b24d;
        }
        .pb-cap {
          margin-top: 12px;
          padding: 11px 13px;
          background: rgba(224, 178, 77, 0.09);
          border: 1px solid rgba(224, 178, 77, 0.28);
          border-radius: 10px;
          font-size: 13.5px;
          color: #e7ebf3;
          font-variant-numeric: tabular-nums;
          line-height: 1.4;
        }
        .pb-est {
          color: #71809a;
          font-size: 11.5px;
          display: block;
          margin-top: 3px;
          font-variant-numeric: normal;
        }
        .pb-note {
          margin: 12px 0 0;
          font-size: 12.5px;
          color: #71809a;
          max-width: 72ch;
          line-height: 1.5;
        }
        .pb-note :global(b) {
          color: #e7ebf3;
        }
        /* ---- timeline chart ---- */
        .plan-plotcard {
          padding: 18px 18px 14px;
        }
        .plan-plothead {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 16px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .plan-hint {
          font-size: 12.5px;
          color: #71809a;
        }
        .plan-legend {
          display: flex;
          flex-wrap: wrap;
          gap: 12px 22px;
          margin-top: 16px;
          padding-top: 15px;
          border-top: 1px solid #1b2233;
          font-size: 12.5px;
          color: #aab4c8;
          align-items: center;
        }
        .pl-grp {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pl-line {
          width: 24px;
          height: 0;
          flex: none;
        }
        .pl-swatch {
          width: 24px;
          height: 11px;
          border-radius: 3px;
          flex: none;
        }
        /* ---- demand-reaction card ---- */
        .plan-demand {
          margin-top: 18px;
        }
        .pd-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px 22px;
          margin-top: 6px;
        }
        @media (min-width: 640px) {
          .pd-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
        .pd-grid > div {
          font-size: 13px;
          color: #aab4c8;
          line-height: 1.5;
        }
        .pd-grid :global(b) {
          color: #e7ebf3;
        }
        .pd-foot {
          margin: 14px 0 0;
          font-size: 12.5px;
          color: #71809a;
          padding-top: 12px;
          border-top: 1px solid #1b2233;
          line-height: 1.5;
        }
        /* ---- recommendation card (bottom) ---- */
        .plan-rec {
          margin-top: 18px;
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .pr-num {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 26px;
          font-weight: 600;
          color: #b48cff;
          letter-spacing: -0.02em;
        }
        .pr-txt {
          flex: 1;
          min-width: 220px;
        }
        .pr-txt :global(b) {
          color: #e7ebf3;
        }
        .pr-txt p {
          margin: 3px 0 0;
          color: #71809a;
          font-size: 12.5px;
          line-height: 1.5;
        }
        .pr-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .plan-rec button {
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          color: #aab4c8;
          background: #161d2e;
          border: 1px solid #232c40;
          padding: 9px 16px;
          border-radius: 9px;
        }
        .plan-rec button:disabled {
          cursor: not-allowed;
          opacity: 0.7;
        }
        .pr-msg {
          flex-basis: 100%;
        }
      `}</style>

      {/* canvas + tooltip styling lives in a plain (non-scoped) tag because the tooltip
          markup is injected via innerHTML and can't carry styled-jsx scope hashes. */}
      <style>{`
        .plan-canvas-wrap { position: relative; width: 100%; }
        .plan-canvas { display: block; width: 100%; height: auto; border-radius: 8px; }
        .plan-tip {
          position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 5;
          background: #0a0d15; border: 1px solid #232c40; border-radius: 9px; padding: 9px 11px;
          font-size: 12px; min-width: 150px; box-shadow: 0 8px 26px rgba(0,0,0,.5);
        }
        .plan-tip .pt-th { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: #e7ebf3; letter-spacing: .04em; margin-bottom: 6px; }
        .plan-tip .pt-row { display: flex; justify-content: space-between; gap: 16px; color: #aab4c8; line-height: 1.7; }
        .plan-tip .pt-row b { color: #e7ebf3; font-variant-numeric: tabular-nums; }
        .plan-tip .pt-why { margin-top: 6px; color: #71809a; font-size: 11.5px; max-width: 190px; white-space: normal; }
      `}</style>
    </div>
  );
}
