"use client";
// @purpose Remote-control page. Cookie-gated (via middleware). Polls the server-side
// /api/hub/state proxy (~5s) for the latest Pi state the Railway hub holds, and POSTs
// setpoint changes to /api/hub/command. The browser NEVER sees HUB_CLIENT_TOKEN — both
// hops go through nodejs route handlers. Setpoint is the only action; power/mode/params
// stay human-only on the direct LAN/Funnel path and are not exposed here. Temps shown in
// °F (whole degrees) but commands SEND value_c in Celsius, since the hub/Pi are Celsius.
import { useCallback, useEffect, useRef, useState } from "react";
import { useModals } from "../ui/modal";

type Pump = {
  id: string;
  name?: string | null;
  online?: boolean;
  state?: string | null;
  mode_kind?: string | null;
  setpoint_c?: number | null;
  inlet_c?: number | null;
  outlet_c?: number | null;
  ambient_c?: number | null;
  power_w?: number | null;
  remote_lease_until?: number | null;
  write_enabled?: boolean;
};
type StateResp = { pi_connected?: boolean; ts?: number | null; pumps?: Pump[] };

const cToF = (c: number | null | undefined) =>
  c == null ? null : (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const fmt = (v: number | null | undefined, d = 0) =>
  v == null || !isFinite(v) ? "—" : v.toFixed(d);

export default function ControlClient() {
  const { confirm, prompt, Modals } = useModals();
  // Live clock so the armed countdown ticks down every second (and the window can expire).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [data, setData] = useState<StateResp | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Pending target (°F, whole degrees) per pump — separate from the live setpoint so the
  // poll never clobbers an edit in progress.
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/hub/state", { cache: "no-store" });
      const body: StateResp & { error?: string } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        setLoadErr(
          res.status === 503
            ? "Hub not configured (set HUB_URL / HUB_CLIENT_TOKEN)."
            : body?.error || `Hub error (${res.status}).`,
        );
      } else {
        setLoadErr("");
        setData(body);
        // Seed a target for any pump we haven't seen yet; leave existing edits alone.
        const cur = targetsRef.current;
        const seed: Record<string, number> = {};
        for (const p of body.pumps ?? []) {
          if (cur[p.id] == null) {
            const f = cToF(p.setpoint_c);
            if (f != null) seed[p.id] = Math.round(f);
          }
        }
        if (Object.keys(seed).length) setTargets((t) => ({ ...seed, ...t }));
      }
    } catch {
      setLoadErr("Could not reach the dashboard server.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [poll]);

  const bump = (id: string, delta: number, liveF: number | null) =>
    setTargets((t) => {
      const base = t[id] ?? (liveF != null ? Math.round(liveF) : 68);
      return { ...t, [id]: base + delta };
    });

  async function send(id: string, targetF: number) {
    setBusy((b) => ({ ...b, [id]: true }));
    setMsgs((m) => ({ ...m, [id]: "" }));
    try {
      const res = await fetch("/api/hub/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pi/hub take WHOLE °C — round here so an odd °F target can't become a fractional
        // °C the guard rejects (e.g. 70°F -> 21.11°C -> nack). Round-trips back as °F below.
        body: JSON.stringify({ pump_id: id, value_c: Math.round(fToC(targetF)) }),
      });
      const body: { ok?: boolean; setpoint_c?: number; detail?: string; error?: string } =
        await res.json().catch(() => ({}));
      let msg: string;
      if (res.ok && body.ok) {
        const f = cToF(body.setpoint_c ?? null);
        msg = `Set to ${f == null ? targetF : Math.round(f)}°F ✓`;
      } else if (res.status === 503) {
        msg = "Pi offline — command not sent.";
      } else if (res.status === 504) {
        msg = "Timed out waiting for the pump to acknowledge.";
      } else if (res.status === 502) {
        msg = `Rejected: ${body.detail || body.error || "guardrail nack"}`;
      } else {
        msg = body.detail || body.error || `Failed (${res.status}).`;
      }
      setMsgs((m) => ({ ...m, [id]: msg }));
    } catch {
      setMsgs((m) => ({ ...m, [id]: "Network error — try again." }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      poll();
    }
  }

  // --- write-mode arming (Gate 1: fresh password re-entry -> 5-min armed window) ---
  const [armedUntil, setArmedUntil] = useState<number | null>(null);
  const [armMsg, setArmMsg] = useState("");
  const armed = armedUntil != null && nowMs < armedUntil;
  // When the armed window elapses, flip the button back and clear armedUntil.
  useEffect(() => {
    if (armedUntil != null && nowMs >= armedUntil) setArmedUntil(null);
  }, [nowMs, armedUntil]);

  async function arm() {
    const password = await prompt({
      title: "Arm write-mode controls",
      body: "Re-enter the dashboard password to arm write-mode controls (5 min):",
      inputType: "password",
    });
    if (!password) return;
    setArmMsg("");
    try {
      const res = await fetch("/api/hub/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const out: { ok?: boolean; armed_seconds?: number; error?: string } = await res.json().catch(() => ({}));
      if (res.ok && out.ok) {
        setArmedUntil(Date.now() + (out.armed_seconds ?? 300) * 1000);
        setArmMsg("Armed for 5 minutes.");
      } else {
        setArmMsg(out.error || `Arm failed (${res.status}).`);
      }
    } catch {
      setArmMsg("Network error — try again.");
    }
  }

  async function toggleWrite(p: Pump) {
    const next = !(p.write_enabled === true);
    const name = p.name ?? p.id;
    if (!(await confirm({
      title: next ? "Enable remote writes" : "Disable remote writes",
      body: next
        ? `ENABLE remote writes for ${name}? This arms the pump's write path (audited; sends a high-priority push). Guardrails stay active.`
        : `Disable remote writes for ${name}? Setpoint commands will be refused until re-enabled.`,
      danger: true,
    }))) return;
    setMsgs((m) => ({ ...m, [p.id]: "" }));
    try {
      const res = await fetch("/api/hub/write-enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pump_id: p.id, enabled: next }),
      });
      const out: { ok?: boolean; detail?: string; error?: string } = await res.json().catch(() => ({}));
      setMsgs((m) => ({
        ...m,
        [p.id]: res.ok && out.ok
          ? `Write mode ${next ? "ENABLED" : "disabled"} ✓`
          : `Refused: ${out.error || out.detail || res.status}`,
      }));
    } catch {
      setMsgs((m) => ({ ...m, [p.id]: "Network error — try again." }));
    } finally {
      poll();
    }
  }

  const connected = data?.pi_connected === true;
  const pumps = data?.pumps ?? [];

  return (
    <>
      {Modals}
      <div className="meta" style={{ marginBottom: 12 }}>
        <span
          className={`chip ${connected ? "heating" : "offline"}`}
        >
          {connected ? "Pi connected" : "Pi offline"}
        </span>{" "}
        remote setpoint control · via hub
      </div>

      <div className="controls">
        <button type="button" onClick={arm} disabled={armed} style={{ marginLeft: "auto" }}>
          {armed ? `🔓 Armed (${Math.max(0, Math.ceil((armedUntil! - nowMs) / 60000))} min)` : "🔒 Arm write-mode controls"}
        </button>
      </div>
      {armMsg ? <div className="meta" style={{ marginTop: -8, marginBottom: 10 }}>{armMsg}</div> : null}

      {loadErr ? (
        <div className="empty">{loadErr}</div>
      ) : !loaded ? (
        <div className="empty">Loading…</div>
      ) : pumps.length === 0 ? (
        <div className="empty">
          {connected
            ? "Connected to the hub, but no pump state yet."
            : "The Pi is not connected to the hub. Setpoint changes cannot be sent right now."}
        </div>
      ) : (
        <div className="cards">
          {pumps.map((p) => {
            const liveF = cToF(p.setpoint_c);
            const target = targets[p.id] ?? (liveF != null ? Math.round(liveF) : 68);
            const online = p.online === true;
            const chip = online ? p.state ?? "idle" : "offline";
            const b = !!busy[p.id];
            const canSend = connected && !b;
            return (
              <div className="card" key={p.id}>
                <h2>
                  {p.name ?? p.id}
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span className={`chip ${p.write_enabled ? "heating" : "off"}`}>
                      writes {p.write_enabled ? "on" : "off"}
                    </span>
                    <span className={`chip ${chip}`}>{chip}</span>
                  </span>
                </h2>
                {armed && (
                  <div className="meta" style={{ marginBottom: 6 }}>
                    <button type="button" onClick={() => toggleWrite(p)} style={{ fontSize: 12, padding: "5px 10px" }}>
                      {p.write_enabled ? "Disable writes" : "Enable writes"}
                    </button>
                  </div>
                )}
                <div className="temps">
                  <div className="temp">
                    <div className="v">{fmt(liveF)}°</div>
                    <div className="l">Setpoint</div>
                  </div>
                  <div className="temp">
                    <div className="v">{fmt(cToF(p.outlet_c))}°</div>
                    <div className="l">Outlet</div>
                  </div>
                  <div className="temp">
                    <div className="v">{fmt(cToF(p.ambient_c))}°</div>
                    <div className="l">Outdoor</div>
                  </div>
                </div>

                <div
                  className="temps"
                  style={{ alignItems: "center", marginTop: 10 }}
                >
                  <button
                    type="button"
                    aria-label="decrease"
                    disabled={b}
                    onClick={() => bump(p.id, -1, liveF)}
                    style={{ flex: "0 0 auto" }}
                  >
                    −
                  </button>
                  <div className="temp" style={{ flex: 1 }}>
                    <div className="v">{target}°</div>
                    <div className="l">Target °F</div>
                  </div>
                  <button
                    type="button"
                    aria-label="increase"
                    disabled={b}
                    onClick={() => bump(p.id, +1, liveF)}
                    style={{ flex: "0 0 auto" }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => send(p.id, target)}
                    style={{ flex: "0 0 auto" }}
                  >
                    {b ? "…" : "Set"}
                  </button>
                </div>

                <div className="meta">
                  {fmt(p.power_w, 0)} W
                  {p.remote_lease_until
                    ? ` · lease until ${new Date(
                        p.remote_lease_until * 1000,
                      ).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : ""}
                  {msgs[p.id] ? (
                    <>
                      <br />
                      <span style={{ color: "var(--text)" }}>{msgs[p.id]}</span>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <HbxTargetCard />

      <StormCard />
    </>
  );
}

type HbxStatus = {
  tank_f: number | null; target_f: number | null; outdoor_f: number | null;
  commanded_target_f?: number | null; adoption_pending?: boolean;
  band: { lo: number; hi: number } | null;
  curve_overridden: boolean; baseline: { dbt: number; mbt: number } | null;
  last_write_at: string | null; i1_margin_f: number;
  active_boost?: { target_f: number; restore_at: string } | null;
  error?: string;
};

/** HBX tank-target control — human-only writes through the planner's guarded API
 *  (I4 outdoor-indexed envelope, I1 cross-check, rate limit, audit all enforced
 *  planner-side; this card just asks and reports). */
function HbxTargetCard() {
  const { confirm, Modals } = useModals();
  const [st, setSt] = useState<HbxStatus | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/target", { cache: "no-store" });
      const body: HbxStatus = await res.json().catch(() => ({} as HbxStatus));
      if (res.ok) {
        setSt(body);
        setTarget((t) => t ?? (body.target_f != null ? Math.round(body.target_f) : null));
      } else {
        setSt(null);
        setMsg(body.error || `Planner error (${res.status}).`);
      }
    } catch {
      setMsg("Could not reach the dashboard server.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(path: string, body?: unknown, confirmText?: string, confirmTitle?: string) {
    if (confirmText && !(await confirm({ title: confirmTitle ?? "Confirm", body: confirmText, danger: true }))) return;
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

  if (!st) return null;
  const band = st.band;
  return (
    <div className="cards" style={{ marginTop: 4 }}>
      {Modals}
      <div className="card">
        <h2>
          HBX tank target
          <span className={`chip ${st.adoption_pending ? "warn" : st.curve_overridden ? "ok" : "ok"}`}>
            {st.adoption_pending ? "adopting next cycle" : st.curve_overridden ? "curve set" : "as-found curve"}
          </span>
        </h2>
        <div className="temps">
          <div className="temp">
            <div className="v">
              {st.commanded_target_f != null ? st.commanded_target_f : st.target_f == null ? "—" : st.target_f.toFixed(0)}°
            </div>
            <div className="l">
              {st.adoption_pending && st.target_f != null
                ? `Commanded · adopting (now ${st.target_f.toFixed(0)}°)`
                : "Target"}
            </div>
          </div>
          <div className="temp"><div className="v">{st.tank_f == null ? "—" : st.tank_f.toFixed(1)}°</div><div className="l">Tank</div></div>
          <div className="temp"><div className="v">{band ? `${band.lo}–${band.hi}` : "—"}</div><div className="l">Allowed °F (I4)</div></div>
        </div>
        <div className="temps" style={{ alignItems: "center", marginTop: 10 }}>
          <button type="button" aria-label="decrease" disabled={busy || target == null} onClick={() => setTarget((t) => (t ?? 120) - 1)} style={{ flex: "0 0 auto" }}>−</button>
          <div className="temp" style={{ flex: 1 }}>
            <div className="v">{target ?? "—"}°</div>
            <div className="l">New target °F</div>
          </div>
          <button type="button" aria-label="increase" disabled={busy || target == null} onClick={() => setTarget((t) => (t ?? 120) + 1)} style={{ flex: "0 0 auto" }}>+</button>
          <button
            type="button"
            disabled={busy || target == null}
            onClick={() => act("/api/planner/target", { target_f: target },
              `Set the HBX tank target to ${target}°F? This writes a near-flat reset curve the buffer adopts on the next reheat cycle, until you restore it. Pump setpoints must stay ${st.i1_margin_f}°F above it (checked).`,
              "Set HBX tank target")}
            style={{ flex: "0 0 auto" }}
          >
            {busy ? "…" : "Set"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("/api/planner/restore", undefined,
              `Restore the as-found curve (${st.baseline ? `${st.baseline.dbt}/${st.baseline.mbt}°F` : "baseline"})?`,
              "Restore curve")}
            style={{ flex: "0 0 auto" }}
          >
            Restore curve
          </button>
          <button
            type="button"
            disabled={busy || !!st.active_boost}
            onClick={() => act("/api/planner/boost", { target_f: 131, minutes: 60 },
              "Boost the tank to 131°F for 60 minutes (sanitize soak / A-B charge)? The curve restores itself automatically — even if the planner restarts.",
              "Boost tank")}
            style={{ flex: "0 0 auto" }}
          >
            {st.active_boost ? "Boost active" : "Boost 131° / 1h"}
          </button>
        </div>
        {st.active_boost && (
          <div className="meta">
            Active boost: {st.active_boost.target_f}°F until{" "}
            {new Date(st.active_boost.restore_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {" "}(auto-restores).
          </div>
        )}
        <div className="meta">
          Writes go through the planner&apos;s guardrails: outdoor-indexed envelope, I1 check vs live pump
          setpoints, 15-min rate limit, read-back, audit. Restore is never rate-limited.
          {msg ? (<><br /><span style={{ color: "var(--text)" }}>{msg}</span></>) : null}
        </div>
      </div>
    </div>
  );
}

type StormStatus = {
  state?: string;
  trigger?: string | null;
  windowEnd?: string | null;
  enabled?: boolean;
};

/** Storm Mode card — manual arm/disarm through the planner's storm state machine
 *  (§6.11). The planner owns the real logic (triggers, only-raises shaping, event
 *  ledger); this card just asks and reports, same as the HBX target card above. */
function StormCard() {
  const [storm, setStorm] = useState<StormStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/storm", { cache: "no-store" });
      const body: { storm?: StormStatus | null; error?: string } = await res.json().catch(() => ({}));
      if (res.ok && body.storm) {
        setStorm(body.storm);
      } else {
        setStorm(null);
        setMsg(body.error || `Planner error (${res.status}).`);
      }
    } catch {
      setMsg("Could not reach the dashboard server.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(action: "arm" | "disarm") {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/planner/storm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "arm" ? { action, hours: 24 } : { action }),
      });
      const out: { state?: { kind?: string }; detail?: string; error?: string } =
        await res.json().catch(() => ({}));
      setMsg(res.ok
        ? `${action === "arm" ? "Armed" : "Disarmed"} ✓${out.state?.kind ? ` (now: ${out.state.kind})` : ""}`
        : `Rejected: ${out.error || out.detail || res.status}`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
      load();
    }
  }

  const active = storm?.state === "armed" || storm?.state === "active";
  return (
    <div className="cards" style={{ marginTop: 4 }}>
      <div className="card">
        <h2>
          Storm Mode
          <span className={`chip ${active ? "heating" : "off"}`}>
            {storm?.state ?? "unknown"}
          </span>
        </h2>
        <div className="meta">
          {active
            ? <>Banking heat — {storm?.trigger ?? "manual"}{storm?.windowEnd
                ? ` · until ${new Date(storm.windowEnd).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                : ""}</>
            : "Idle. Arming banks heat ahead of an outage window (only ever raises the plan)."}
          {storm?.enabled === false ? " Shaping flag is OFF — arming is notify-only." : ""}
        </div>
        <div className="temps" style={{ alignItems: "center", marginTop: 10 }}>
          <button type="button" disabled={busy} onClick={() => act("arm")} style={{ flex: "0 0 auto" }}>
            {busy ? "…" : "Arm 24h"}
          </button>
          <button type="button" disabled={busy} onClick={() => act("disarm")} style={{ flex: "0 0 auto" }}>
            {busy ? "…" : "Disarm"}
          </button>
        </div>
        <div className="meta">
          Manual arm/disarm wins over NWS/forecast/outage triggers until the window ends.
          {msg ? (<><br /><span style={{ color: "var(--text)" }}>{msg}</span></>) : null}
        </div>
      </div>
    </div>
  );
}
