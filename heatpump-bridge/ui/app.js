// @purpose: UI logic — polls pump snapshots every 5s, guarded setpoint writes with
// verified read-back feedback, hand-rolled SVG history charts, event log. Vanilla JS.
"use strict";

const POLL_MS = 5000;
const MODE_LABELS = { cooling: "Cooling", heating: "Heating", hot_water: "Hot water" };
const state = {
  unit: localStorage.getItem("a2w-unit") === "f" ? "f" : "c",
  detailsOpen: {},      // pump id -> bool, survives re-renders
  schedules: {},        // pump id -> timer rules
  pumps: [],            // [{id, name}]
  snapshots: {},        // id -> /status payload
  pending: {},          // id -> locally adjusted (unconfirmed) setpoint
  writing: {},          // id -> bool
  view: "dashboard",
  historyPump: null,
  historyHours: 24,
  eventsPump: null,
  eventsFilter: "all",
};

const EVENT_FILTERS = {
  all: () => true,
  faults: e => e.type.startsWith("fault"),
  writes: e => e.type.endsWith("_write") || e.type === "schedule_change",
  runtime: e => e.type === "state" || e.type === "comm",
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
      state.schedules[p.id] = await api(`/api/pumps/${p.id}/schedules`);
    }));
    if (!state.historyPump && pumps.length) state.historyPump = pumps[0].id;
    if (!state.eventsPump && pumps.length) state.eventsPump = pumps[0].id;
    renderDashboard();
    renderPumpSelectors();
    if (state.view === "setup") renderSetup();
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
      ${detailRow("Aux EEV", [s1.aux_eev_steps, null, s2.aux_eev_steps, null])}
      ${detailRow("IPM temp", [s1.ipm_temp_c, null, s2.ipm_temp_c, null], T)}
      ${detailRow("Pressure hi/lo", [
        s1.high_pressure != null ? `${s1.high_pressure}/${s1.low_pressure}` : null, null,
        s2.high_pressure != null ? `${s2.high_pressure}/${s2.low_pressure}` : null, null])}
      ${detailRow("Bus V", [s1.bus_voltage_v, null, s2.bus_voltage_v, null])}
      ${detailRow("Fan rpm", [s1.fan_rpm, null, s2.fan_rpm, null])}
      ${(s1.ee_code || s2.ee_code || d.shared?.fixed_ee_code)
        ? detailRow("EE code", [s1.ee_code, d.shared?.fixed_ee_code, s2.ee_code, null]) : ""}
    </table></div>
    <div class="switchline">
      ${pill("Flow " + (sw.water_flow_switch ? "OK" : "LOW"), sw.water_flow_switch, sw.water_flow_switch ? "" : "bad")}
      ${pill("AC", sw.ac_online)}
      ${sw.emergency_switch ? pill("Emergency", true, "bad") : ""}
      <span class="acv">${d.shared?.ac_voltage_v ? d.shared.ac_voltage_v + " VAC" : ""}</span>
    </div>`;

  const params = (s.parameters || []).map(p => `
    <button class="param" data-param="${esc(p.key)}" title="Edit (${p.min}–${p.max})">
      <span>${esc(p.label)}</span><b>${p.value} ✎</b>
    </button>`).join("");

  const timers = (state.schedules[id] || []).map(t => `
    <div class="timer">
      <b>${esc(t.time_hhmm)}</b>
      <span class="pill on ${t.action === "off" ? "bad" : ""}">${t.action.toUpperCase()}</span>
      <span class="timer-note">daily</span>
      <button class="timer-del" data-del-timer="${t.id}" title="Remove timer">×</button>
    </div>`).join("");

  return `
    <div class="pills">${pills}</div>
    <details class="deep" data-id="${id}" ${state.detailsOpen[id] ? "open" : ""}>
      <summary>Details</summary>
      ${table}
    </details>
    <details class="deep" data-id="${id}-timers" ${state.detailsOpen[id + "-timers"] ? "open" : ""}>
      <summary>Timers <span class="paramnote">daily on/off, runs on the bridge</span></summary>
      <div class="timers">${timers || '<div class="empty small">No timers</div>'}
        <div class="timer-add">
          <input type="time" class="t-time" value="06:00">
          <select class="t-action"><option value="on">Turn on</option><option value="off">Turn off</option></select>
          <button class="t-add" data-add-timer="1">Add</button>
        </div>
      </div>
    </details>
    ${params ? `
    <details class="deep" data-id="${id}-params" ${state.detailsOpen[id + "-params"] ? "open" : ""}>
      <summary>Unit parameters <span class="paramnote">installer settings — tap to edit, °C</span></summary>
      <div class="params">${params}</div>
    </details>` : ""}`;
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
        <button class="power ${s.on ? "on" : ""}" data-power="${s.on ? "off" : "on"}"
          title="${s.on ? "Turn unit off" : "Turn unit on"}" ${s.online ? "" : "disabled"}>⏻</button>
        <span class="chip ${stateName}">${stateName}</span>
      </div>
      <div class="modectl seg">
        <button class="seg-btn ${s.mode_kind === "heating" ? "active" : ""}"
          data-mode="heating" ${s.online ? "" : "disabled"}>Heat</button>
        <button class="seg-btn ${s.mode_kind === "cooling" ? "active" : ""}"
          data-mode="cooling" ${s.online ? "" : "disabled"}>Cool</button>
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
        ${s.identity_ok === false ? '<span class="err-bad">⚠ W610 identity mismatch — writes blocked</span>' : ""}
        ${!s.online ? `<button class="find-gw" data-find-gw>Find gateway</button>` : ""}
        <span>last poll ${fmtAgo(s.last_poll_ts)}</span>
      </div>
    </div>`;
  }).join("") || `<div class="empty">No pumps configured</div>`;
}

// ---------- confirmation modal ----------
function confirmDialog({ title, body, confirmLabel, danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <p>${esc(body)}</p>
        <div class="modal-actions">
          <button class="m-cancel">Cancel</button>
          <button class="m-confirm ${danger ? "danger" : ""}">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (answer) => { overlay.remove(); resolve(answer); };
    overlay.querySelector(".m-cancel").onclick = () => close(false);
    overlay.querySelector(".m-confirm").onclick = () => close(true);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
    overlay.querySelector(".m-confirm").focus();
  });
}

function promptDialog({ title, body, value, min, max, confirmLabel, danger = false,
                        inputType = "number" }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const inputHtml = inputType === "number"
      ? `<input type="number" value="${value}" min="${min}" max="${max}" step="1">
         <span class="range">allowed ${min}–${max}</span>`
      : `<input type="text" value="${esc(value ?? "")}" maxlength="40" class="wide">`;
    overlay.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <p>${esc(body)}</p>
        <div class="modal-input">${inputHtml}</div>
        <div class="modal-actions">
          <button class="m-cancel">Cancel</button>
          <button class="m-confirm ${danger ? "danger" : ""}">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const input = overlay.querySelector("input");
    const close = (answer) => { overlay.remove(); resolve(answer); };
    overlay.querySelector(".m-cancel").onclick = () => close(null);
    overlay.querySelector(".m-confirm").onclick = () =>
      close(inputType === "number" ? Number(input.value) : input.value.trim());
    overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

async function guardedPost(path, body, okMessage) {
  try {
    await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, source: "ui" }),
    });
    toast(okMessage);
  } catch (err) {
    toast(err.message, true);
  }
  await refresh();
}

// mode switch + power toggle (each behind a confirmation step)
document.addEventListener("click", async (e) => {
  const modeBtn = e.target.closest("[data-mode]");
  const powerBtn = e.target.closest("[data-power]");
  if (!modeBtn && !powerBtn) return;
  const card = e.target.closest("[data-pump]");
  if (!card) return;
  const id = card.dataset.pump;
  const s = state.snapshots[id] || {};
  const name = s.name || id;

  if (modeBtn) {
    const target = modeBtn.dataset.mode;
    if (target === s.mode_kind) return;  // already there
    const targetSp = target === "cooling" ? s.setpoint_cooling_c : s.setpoint_heating_c;
    const ok = await confirmDialog({
      title: `Switch ${name} to ${target === "cooling" ? "cooling" : "heating"}?`,
      body: `The unit will stop ${s.mode_kind === "cooling" ? "cooling" : "heating"} and chase ` +
            `the ${target} setpoint (${temp(targetSp, 0)}${unitLabel()}). ` +
            `Make sure the rest of the hydronic system expects this.`,
      confirmLabel: target === "cooling" ? "Switch to cooling" : "Switch to heating",
    });
    if (ok) await guardedPost(`/api/pumps/${id}/mode`, { value: target },
      `✓ ${name}: now in ${target} mode`);
  }

  if (powerBtn) {
    const turningOn = powerBtn.dataset.power === "on";
    const ok = await confirmDialog({
      title: `Turn ${name} ${turningOn ? "on" : "OFF"}?`,
      body: turningOn
        ? "The unit will resume following its setpoint."
        : "The unit will stop and ignore heating calls until turned back on " +
          "(here or at the wall controller).",
      confirmLabel: turningOn ? "Turn on" : "Turn off",
      danger: !turningOn,
    });
    if (ok) await guardedPost(`/api/pumps/${id}/power`, { value: turningOn },
      `✓ ${name}: turned ${turningOn ? "on" : "off"}`);
  }
});

// installer parameter edit + timers
document.addEventListener("click", async (e) => {
  const paramBtn = e.target.closest("[data-param]");
  const addTimer = e.target.closest("[data-add-timer]");
  const delTimer = e.target.closest("[data-del-timer]");
  if (!paramBtn && !addTimer && !delTimer) return;
  const card = e.target.closest("[data-pump]");
  if (!card) return;
  const id = card.dataset.pump;
  const s = state.snapshots[id] || {};
  const name = s.name || id;

  if (paramBtn) {
    const p = (s.parameters || []).find(x => x.key === paramBtn.dataset.param);
    if (!p) return;
    const value = await promptDialog({
      title: `Change "${p.label}"?`,
      body: `Installer setting on ${name}. The factory warns against casual changes ` +
            `(manual §2.8) — only proceed if you know why. Current value: ${p.value}.`,
      value: p.value, min: p.min, max: p.max,
      confirmLabel: "Write to unit", danger: true,
    });
    if (value === null || value === p.value) return;
    await guardedPost(`/api/pumps/${id}/parameter`, { key: p.key, value },
      `✓ ${name}: ${p.label} = ${value} (verified)`);
  }

  if (addTimer) {
    const timers = card.querySelector(".timer-add");
    const time = timers.querySelector(".t-time").value;
    const action = timers.querySelector(".t-action").value;
    if (!time) return;
    const ok = await confirmDialog({
      title: `Add daily timer on ${name}?`,
      body: `The bridge will turn the unit ${action.toUpperCase()} every day at ${time} ` +
            `(bridge local time). It fires through the same guarded, audited write path.`,
      confirmLabel: `Turn ${action} at ${time} daily`,
      danger: action === "off",
    });
    if (!ok) return;
    try {
      state.schedules[id] = await api(`/api/pumps/${id}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time, action }),
      });
      toast(`✓ ${name}: daily ${action} at ${time}`);
      renderDashboard();
    } catch (err) { toast(err.message, true); }
  }

  if (delTimer) {
    try {
      state.schedules[id] = await api(
        `/api/pumps/${id}/schedules/${delTimer.dataset.delTimer}`, { method: "DELETE" });
      toast(`Timer removed`);
      renderDashboard();
    } catch (err) { toast(err.message, true); }
  }
});

// gateway discovery: scan the LAN, pick the right W610 for an offline pump
document.addEventListener("click", async (e) => {
  const findBtn = e.target.closest("[data-find-gw]");
  if (!findBtn) return;
  const card = e.target.closest("[data-pump]");
  const id = card?.dataset.pump;
  if (!id) return;
  findBtn.disabled = true;
  findBtn.textContent = "Scanning…";
  let candidates = [];
  try {
    candidates = await api("/api/discover?probe=true");
  } catch (err) {
    toast(`scan failed: ${err.message}`, true);
    return;
  }
  const rows = candidates.map(c => {
    const badge = c.matches_pump === id
      ? '<span class="pill on">MAC matches this pump ✓</span>'
      : c.matches_pump ? `<span class="pill on bad">MAC of ${esc(c.matches_pump)}</span>`
      : c.in_use_by ? `<span class="pill">in use by ${esc(c.in_use_by)}</span>` : "";
    const temps = c.probe
      ? `heat pump ✓ · out ${temp(c.probe.outlet_c, 0)}° in ${temp(c.probe.inlet_c, 0)}°`
      : "no heat pump reply";
    return `<button class="gw-row" data-gw-host="${esc(c.ip)}" data-gw-port="${c.port || 8899}">
        <b>${esc(c.ip)}:${c.port || 8899}</b>
        <span>${c.mac ? esc(c.mac) : "MAC unknown"}</span>
        <span class="${c.probe ? "" : "dim"}">${temps}</span>${badge}
      </button>`;
  }).join("");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">
      <h3>Assign a gateway to ${esc(state.snapshots[id]?.name || id)}</h3>
      <p>${candidates.length ? "Gateways found on this network — tap one:"
                             : "No gateways found. Is the W610 powered and on the WiFi?"}</p>
      <div class="gw-list">${rows}</div>
      <div class="modal-actions"><button class="m-cancel">Cancel</button></div>
    </div>`;
  overlay.querySelector(".m-cancel").onclick = () => overlay.remove();
  overlay.addEventListener("click", ev => { if (ev.target === overlay) overlay.remove(); });
  overlay.querySelectorAll(".gw-row").forEach(row => row.onclick = async () => {
    overlay.remove();
    try {
      const r = await api(`/api/pumps/${id}/gateway`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: row.dataset.gwHost, port: Number(row.dataset.gwPort) }),
      });
      toast(r.online ? `✓ ${id} connected via ${row.dataset.gwHost}` :
        `assigned ${row.dataset.gwHost} — waiting for first poll`);
    } catch (err) { toast(err.message, true); }
    await refresh();
  });
  document.body.appendChild(overlay);
});

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
  if (state.view === "setup") renderSetup();
}));

// ---------- setup tab ----------
function renderSetup() {
  $("#pump-list").innerHTML = state.pumps.map(p => `
    <div class="pump-row">
      <div class="pump-row-main">
        <b>${esc(p.name)}</b>
        <span class="chip ${p.state}">${p.state}</span>
      </div>
      <div class="pump-row-detail">
        ${esc(p.host)}:${p.port} · ${p.mac ? esc(p.mac) : "MAC not verified"} ·
        writes ${p.write_enabled ? "enabled" : "disabled"} ·
        ${p.added ? "added via UI" : "from config.yaml"}
      </div>
      ${p.added ? `<button class="timer-del" data-remove-pump="${p.id}" title="Remove">×</button>` : ""}
    </div>`).join("") || `<div class="empty small">No pumps configured</div>`;
}

async function assignCandidate(c) {
  // chooser: existing pumps + "add as new"
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">
      <h3>${esc(c.ip)}:${c.port || 8899}</h3>
      <p>${c.mac ? esc(c.mac) + " · " : ""}${c.probe ? "responds like a heat pump ✓" : "no heat pump reply — assign anyway?"}</p>
      <div class="gw-list">
        ${state.pumps.map(p => `<button class="gw-row" data-assign="${p.id}">
            <b>Assign to ${esc(p.name)}</b><span class="dim">currently ${esc(p.host)}:${p.port}</span>
          </button>`).join("")}
        <button class="gw-row" data-assign="__new__"><b>＋ Add as a new heat pump</b></button>
        <button class="gw-row" data-assign="__configure__">
          <b>⚙ Auto-configure serial</b>
          <span class="dim">sets 2400 8N1 + transparent mode over the network (experimental)</span>
        </button>
      </div>
      <div class="modal-actions"><button class="m-cancel">Cancel</button></div>
    </div>`;
  overlay.querySelector(".m-cancel").onclick = () => overlay.remove();
  overlay.addEventListener("click", ev => { if (ev.target === overlay) overlay.remove(); });
  overlay.querySelectorAll("[data-assign]").forEach(btn => btn.onclick = async () => {
    overlay.remove();
    const target = btn.dataset.assign;
    try {
      if (target === "__configure__") {
        toast("configuring W610…");
        const r = await api("/api/w610/configure", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: c.ip }),
        });
        toast(r.ok
          ? (r.changed.length ? `✓ configured: ${r.changed.join("; ")} — rebooting` : "✓ already configured correctly")
          : r.error, !r.ok);
        return;
      }
      if (target === "__new__") {
        const name = await promptDialog({
          title: "Name the new heat pump",
          body: `It will be added at ${c.ip}:${c.port || 8899}, polling immediately, with writes disabled (Phase 1 rule).`,
          value: `Heat Pump ${state.pumps.length + 1}`, inputType: "text",
          confirmLabel: "Add pump",
        });
        if (!name) return;
        await api("/api/pumps", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, host: c.ip, port: c.port || 8899 }) });
        toast(`✓ ${name} added`);
      } else {
        await api(`/api/pumps/${target}/gateway`, { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: c.ip, port: c.port || 8899 }) });
        toast(`✓ gateway assigned to ${target}`);
      }
    } catch (err) { toast(err.message, true); }
    await refresh();
    renderSetup();
  });
  document.body.appendChild(overlay);
}

$("#scan-btn").addEventListener("click", async () => {
  const btn = $("#scan-btn");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  $("#scan-note").textContent = "sweeping the local network (~10s)";
  try {
    const candidates = await api("/api/discover?probe=true");
    $("#scan-results").innerHTML = candidates.map((c, i) => {
      const badge = c.matches_pump ? `<span class="pill on">MAC of ${esc(c.matches_pump)}</span>`
        : c.in_use_by ? `<span class="pill">in use by ${esc(c.in_use_by)}</span>` : "";
      const temps = c.probe
        ? `heat pump ✓ · out ${temp(c.probe.outlet_c, 0)}° in ${temp(c.probe.inlet_c, 0)}°`
        : "no heat pump reply";
      return `<button class="gw-row" data-candidate="${i}">
          <b>${esc(c.ip)}:${c.port || 8899}</b>
          <span>${c.mac ? esc(c.mac) : "MAC unknown"}</span>
          <span class="${c.probe ? "" : "dim"}">${temps}</span>${badge}
        </button>`;
    }).join("") || `<div class="empty small">Nothing found. Are the W610s powered, on this WiFi, and not on a guest/IoT network?</div>`;
    $("#scan-results").querySelectorAll("[data-candidate]").forEach(row =>
      row.onclick = () => assignCandidate(candidates[Number(row.dataset.candidate)]));
    $("#scan-note").textContent = `${candidates.length} found`;
  } catch (err) {
    toast(`scan failed: ${err.message}`, true);
    $("#scan-note").textContent = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan network";
  }
});

document.addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-remove-pump]");
  if (!rm) return;
  const id = rm.dataset.removePump;
  const p = state.pumps.find(x => x.id === id);
  const ok = await confirmDialog({
    title: `Remove ${p?.name || id}?`,
    body: "Stops polling and removes it from the dashboard. Its history and events stay in the database. The heat pump itself is not affected.",
    confirmLabel: "Remove", danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/pumps/${id}`, { method: "DELETE" });
    toast(`removed ${p?.name || id}`);
  } catch (err) { toast(err.message, true); }
  await refresh();
  renderSetup();
});

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
document.querySelectorAll("#event-filter .seg-btn").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#event-filter .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  state.eventsFilter = b.dataset.filter;
  loadEvents();
}));

async function loadEvents() {
  if (!state.eventsPump) return;
  try {
    const rows = (await api(`/api/pumps/${state.eventsPump}/events?days=7`))
      .filter(EVENT_FILTERS[state.eventsFilter] || EVENT_FILTERS.all);
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
