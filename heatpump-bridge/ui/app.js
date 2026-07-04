// @purpose: UI logic — polls pump snapshots every 5s, guarded setpoint writes with
// verified read-back feedback, hand-rolled SVG history charts, event log. Vanilla JS.
"use strict";

const POLL_MS = 5000;
const MODE_LABELS = { cooling: "Cooling", heating: "Heating", hot_water: "Hot water" };
const state = {
  unit: localStorage.getItem("a2w-unit") === "f" ? "f" : "c",
  detailsOpen: {},      // pump id -> bool, survives re-renders
  pumps: [],            // [{id, name}]
  snapshots: {},        // id -> /status payload
  pending: {},          // id -> locally adjusted (unconfirmed) setpoint
  writing: {},          // id -> bool
  view: "dashboard",
  historyPump: null,
  historyHours: 24,
  eventsPump: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- data ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json();
}

async function refresh() {
  try {
    const pumps = await api("/api/pumps");
    state.pumps = pumps;
    $("#health-dot").className = "dot " + (pumps.some(p => p.online) ? "ok" : "bad");
    await Promise.all(pumps.map(async p => {
      state.snapshots[p.id] = await api(`/api/pumps/${p.id}/status`);
    }));
    if (!state.historyPump && pumps.length) state.historyPump = pumps[0].id;
    if (!state.eventsPump && pumps.length) state.eventsPump = pumps[0].id;
    renderDashboard();
    renderPumpSelectors();
  } catch (err) {
    $("#health-dot").className = "dot bad";
    console.error("refresh failed", err);
  }
}

// ---------- dashboard ----------
function fmtAgo(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function num(v, digits = 1) {
  return (v === null || v === undefined) ? "—" : Number(v).toFixed(digits);
}

// Display-only unit conversion. The pump, bridge, and guardrails are Celsius
// throughout (registers are whole degC); degF is a view preference on this device.
const unitLabel = () => state.unit === "f" ? "°F" : "°C";
const toDisplay = (c) => state.unit === "f" ? c * 9 / 5 + 32 : c;
function temp(v, digits = 1) {
  return (v === null || v === undefined) ? "—" : toDisplay(Number(v)).toFixed(digits);
}

function pill(label, on, cls = "") {
  return `<span class="pill ${on ? "on " + cls : ""}">${label}</span>`;
}

function detailRow(label, vals, fmt = v => v ?? "—") {
  return `<tr><th>${label}</th>${vals.map(v => `<td>${v == null ? "—" : fmt(v)}</td>`).join("")}</tr>`;
}

function renderDetails(id, s) {
  const st = s.status || {};
  const sw = s.switches || {};
  const d = s.details || {};
  const s1 = d.stage1_inverter || {}, f1 = d.stage1_fixed || {};
  const s2 = d.stage2_inverter || {}, f2 = d.stage2_fixed || {};
  const fanLabel = s.fan_speed && s.fan_speed !== "off" ? `Fan ${s.fan_speed}` : "Fan";

  const pills = [
    pill("Comp 1", st.compressor1),
    pill("Comp 2", st.compressor2),
    pill(fanLabel, s.fan_speed !== "off"),
    pill("Pump", st.water_pump),
    pill("Defrost", s.defrosting, "defrost"),
    pill("Elec heat", st.electric_heating, "hot"),
    st.crankcase_heater1 || st.crankcase_heater2
      ? pill("Crankcase", true) : "",
    st.chassis_heating ? pill("Chassis heat", true) : "",
  ].join("");

  const T = v => v == null ? "—" : temp(v, 0) + "°";
  const cols = [s1, f1, s2, f2];
  const table = `
    <div class="detail-scroll"><table class="detail">
      <tr><th></th><th>S1 inv</th><th>S1 fix</th><th>S2 inv</th><th>S2 fix</th></tr>
      ${detailRow("Discharge", cols.map(c => c.discharge_c), T)}
      ${detailRow("Coil", cols.map(c => c.coil_c), T)}
      ${detailRow("Suction", cols.map(c => c.suction_c), T)}
      ${detailRow("Comp Hz", [s1.compressor_hz, null, s2.compressor_hz, null])}
      ${detailRow("Current A", cols.map(c => c.current_a))}
      ${detailRow("EEV steps", cols.map(c => c.eev_steps))}
      ${detailRow("IPM temp", [s1.ipm_temp_c, null, s2.ipm_temp_c, null], T)}
      ${detailRow("Pressure hi/lo", [
        s1.high_pressure != null ? `${s1.high_pressure}/${s1.low_pressure}` : null, null,
        s2.high_pressure != null ? `${s2.high_pressure}/${s2.low_pressure}` : null, null])}
      ${detailRow("Bus V", [s1.bus_voltage_v, null, s2.bus_voltage_v, null])}
      ${detailRow("Fan rpm", [s1.fan_rpm, null, s2.fan_rpm, null])}
    </table></div>
    <div class="switchline">
      ${pill("Flow " + (sw.water_flow_switch ? "OK" : "LOW"), sw.water_flow_switch, sw.water_flow_switch ? "" : "bad")}
      ${pill("AC", sw.ac_online)}
      ${sw.emergency_switch ? pill("Emergency", true, "bad") : ""}
      <span class="acv">${d.shared?.ac_voltage_v ? d.shared.ac_voltage_v + " VAC" : ""}</span>
    </div>`;

  return `
    <div class="pills">${pills}</div>
    <details class="deep" data-id="${id}" ${state.detailsOpen[id] ? "open" : ""}>
      <summary>Details</summary>
      ${table}
    </details>`;
}

function renderDashboard() {
  const wrap = $("#pump-cards");
  wrap.innerHTML = state.pumps.map(p => {
    const s = state.snapshots[p.id] || {};
    const stateName = s.state || "offline";
    const actual = s.setpoint_c;
    const pending = state.pending[p.id];
    const shown = pending ?? actual;
    const dirty = pending !== undefined && pending !== actual;
    const writing = state.writing[p.id];
    const power = (s.power_sys1 || 0) + (s.power_sys2 || 0);
    const modeLabel = MODE_LABELS[s.mode_kind] || (s.mode_name || "—");
    const bounds = s.setpoint_bounds_c;
    const faults = (s.active_faults || []).map(f => `
      <div class="fault ${f.severity}">
        <span class="code">${esc(f.code)}</span>
        <span>${esc(f.message)}</span>
        <span class="age">${fmtAgo(f.since)}</span>
      </div>`).join("");
    const err = s.comm?.error_rate ?? 0;
    return `
    <div class="card" data-pump="${p.id}">
      <div class="head">
        <h2>${esc(s.name || p.name)}</h2>
        <span class="chip ${stateName}">${stateName}</span>
      </div>
      <div class="temps">
        <div class="temp"><div class="v">${temp(s.outlet_c)}°</div><div class="l">Outlet</div></div>
        <div class="temp"><div class="v">${temp(s.inlet_c)}°</div><div class="l">Inlet</div></div>
        <div class="temp"><div class="v">${temp(s.ambient_c)}°</div><div class="l">Outdoor</div></div>
      </div>
      <div class="powerline">Power <b>${num(power, 0)} W</b>
        &nbsp;·&nbsp; stage 1: ${num(s.power_sys1, 0)} · stage 2: ${num(s.power_sys2, 0)}</div>
      <div class="setpoint">
        <div>
          <div class="label">Setpoint · ${esc(modeLabel)}</div>
          <div class="val ${dirty ? "pending" : ""}">${temp(shown, 0)}${unitLabel()}</div>
          ${bounds ? `<div class="range-hint">${temp(bounds[0], 0)}–${temp(bounds[1], 0)}${unitLabel()}</div>` : ""}
        </div>
        <button class="stepper" data-act="dec" ${s.online ? "" : "disabled"}>−</button>
        <button class="stepper" data-act="inc" ${s.online ? "" : "disabled"}>+</button>
        <button class="confirm ${writing ? "busy" : ""}" data-act="set"
          ${dirty && !writing && s.online ? "" : "disabled"}>
          ${writing ? "…" : "Set"}</button>
      </div>
      ${faults ? `<div class="faults">${faults}</div>` : ""}
      ${s.online ? renderDetails(p.id, s) : ""}
      <div class="comm">
        <span>errors: <span class="${err > 0.05 ? "err-bad" : ""}">${(err * 100).toFixed(1)}%</span></span>
        <span>last poll ${fmtAgo(s.last_poll_ts)}</span>
      </div>
    </div>`;
  }).join("") || `<div class="empty">No pumps configured</div>`;
}

// remember expand/collapse across the 5s re-renders
document.addEventListener("click", (e) => {
  const summary = e.target.closest(".deep summary");
  if (summary) {
    const el = summary.parentElement;
    // native toggle fires after click; record the state it's about to become
    state.detailsOpen[el.dataset.id] = !el.open;
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-pump]");
  const id = card?.dataset.pump;
  if (!id) return;
  const snap = state.snapshots[id] || {};
  const current = state.pending[id] ?? snap.setpoint_c ?? 40;
  const clampPending = v => {
    const b = snap.setpoint_bounds_c;
    return b ? Math.min(Math.max(v, Math.ceil(b[0])), Math.floor(b[1])) : v;
  };

  if (btn.dataset.act === "dec") { state.pending[id] = clampPending(Math.round(current) - 1); renderDashboard(); }
  if (btn.dataset.act === "inc") { state.pending[id] = clampPending(Math.round(current) + 1); renderDashboard(); }
  if (btn.dataset.act === "set") {
    const value = state.pending[id];
    state.writing[id] = true;
    renderDashboard();
    try {
      const result = await api(`/api/pumps/${id}/setpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, source: "ui" }),
      });
      delete state.pending[id];
      snap.setpoint_c = result.setpoint_c;
      toast(`✓ ${snap.name}: setpoint ${temp(result.setpoint_c, 0)}${unitLabel()} (verified)`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.writing[id] = false;
      renderDashboard();
    }
  }
});

// ---------- tabs & selectors ----------
document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
  state.view = tab.dataset.view;
  document.querySelectorAll(".view").forEach(v =>
    v.classList.toggle("active", v.id === `view-${state.view}`));
  if (state.view === "history") loadHistory();
  if (state.view === "events") loadEvents();
}));

function renderPumpSelectors() {
  for (const [elId, key, reload] of [
    ["history-pumps", "historyPump", loadHistory],
    ["events-pumps", "eventsPump", loadEvents],
  ]) {
    const el = document.getElementById(elId);
    el.innerHTML = state.pumps.map(p =>
      `<button class="seg-btn ${state[key] === p.id ? "active" : ""}" data-id="${p.id}">${esc(p.name)}</button>`
    ).join("");
    el.querySelectorAll(".seg-btn").forEach(b => b.onclick = () => {
      state[key] = b.dataset.id;
      renderPumpSelectors();
      reload();
    });
  }
}

document.querySelectorAll("[data-hours]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("[data-hours]").forEach(x => x.classList.toggle("active", x === b));
  state.historyHours = Number(b.dataset.hours);
  loadHistory();
}));

// ---------- history charts (hand-rolled SVG) ----------
function svgChart(series, { height = 190, width = 800 } = {}) {
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const all = series.flatMap(s => s.points.filter(p => p.y !== null && isFinite(p.y)));
  if (!all.length) return `<div class="empty">No data yet</div>`;
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 4) { const m = (y0 + y1) / 2; y0 = m - 2; y1 = m + 2; }
  const X = x => pad.l + (x - x0) / Math.max(1, x1 - x0) * (width - pad.l - pad.r);
  const Y = y => pad.t + (1 - (y - y0) / (y1 - y0)) * (height - pad.t - pad.b);

  const gridY = [y0, (y0 + y1) / 2, y1];
  const grid = gridY.map(g => `
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(g)}" y2="${Y(g)}" stroke="#2c3640" stroke-width="1"/>
    <text x="4" y="${Y(g) + 4}" fill="#8b98a5" font-size="11">${Math.round(g)}</text>`).join("");

  const paths = series.map(s => {
    const pts = s.points.filter(p => p.y !== null && isFinite(p.y));
    if (!pts.length) return "";
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8"
      stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/>`;
  }).join("");

  const t0 = new Date(x0 * 1000), t1 = new Date(x1 * 1000);
  const fmt = d => state.historyHours > 48
    ? d.toLocaleDateString([], { month: "short", day: "numeric" })
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}${paths}
    <text x="${pad.l}" y="${height - 4}" fill="#8b98a5" font-size="11">${fmt(t0)}</text>
    <text x="${width - pad.r}" y="${height - 4}" fill="#8b98a5" font-size="11" text-anchor="end">${fmt(t1)}</text>
  </svg>`;
}

async function loadHistory() {
  if (!state.historyPump) return;
  try {
    const rows = await api(`/api/pumps/${state.historyPump}/history?hours=${state.historyHours}`);
    const pick = key => rows.map(r => ({ x: r.ts, y: r[key] }));
    const pickTemp = key => rows.map(r => ({ x: r.ts, y: r[key] == null ? null : toDisplay(r[key]) }));
    $("#temps-title").textContent = `Temperatures ${unitLabel()}`;
    $("#chart-temps").innerHTML = svgChart([
      { color: "#4dabf7", points: pickTemp("outlet_c") },
      { color: "#63e6be", points: pickTemp("inlet_c") },
      { color: "#845ef7", points: pickTemp("ambient_c") },
      { color: "#ffd666", points: pickTemp("setpoint_c"), dash: true },
    ]);
    $("#chart-power").innerHTML = svgChart([
      { color: "#ff9f43", points: pick("power_sys1") },
      { color: "#ff6b6b", points: pick("power_sys2") },
    ]);
  } catch (err) {
    toast(`history: ${err.message}`, true);
  }
}

// ---------- events ----------
async function loadEvents() {
  if (!state.eventsPump) return;
  try {
    const rows = await api(`/api/pumps/${state.eventsPump}/events?days=7`);
    $("#event-list").innerHTML = rows.map(e => {
      const t = new Date(e.ts * 1000).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return `<div class="event">
        <span class="ts">${t}</span>
        <span class="badge ${esc(e.type)}">${esc(e.type.replace("_", " "))}</span>
        ${e.code ? `<span class="code">${esc(e.code)}</span>` : ""}
        <span class="msg">${esc(e.message || "")}</span>
      </div>`;
    }).join("") || `<div class="empty">No events in the last 7 days</div>`;
  } catch (err) {
    toast(`events: ${err.message}`, true);
  }
}

// ---------- toast ----------
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3500);
}

// ---------- unit toggle ----------
function renderUnitToggle() {
  document.querySelectorAll("#unit-toggle .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.unit === state.unit));
}
document.querySelectorAll("#unit-toggle .seg-btn").forEach(b => b.addEventListener("click", () => {
  state.unit = b.dataset.unit;
  localStorage.setItem("a2w-unit", state.unit);
  renderUnitToggle();
  renderDashboard();
  if (state.view === "history") loadHistory();
}));

// ---------- boot ----------
renderUnitToggle();
refresh();
setInterval(() => {
  refresh();
  if (state.view === "history") loadHistory();
  if (state.view === "events") loadEvents();
}, POLL_MS);
