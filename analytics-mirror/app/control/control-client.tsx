"use client";
// @purpose Remote-control page. Cookie-gated (via middleware). Polls the server-side
// /api/hub/state proxy (~5s) for the latest Pi state the Railway hub holds, and POSTs
// setpoint changes to /api/hub/command. The browser NEVER sees HUB_CLIENT_TOKEN — both
// hops go through nodejs route handlers. Setpoint is the only action; power/mode/params
// stay human-only on the direct LAN/Funnel path and are not exposed here. Temps shown in
// °F (whole degrees) but commands SEND value_c in Celsius, since the hub/Pi are Celsius.
import { useCallback, useEffect, useRef, useState } from "react";

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
};
type StateResp = { pi_connected?: boolean; ts?: number | null; pumps?: Pump[] };

const cToF = (c: number | null | undefined) =>
  c == null ? null : (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const fmt = (v: number | null | undefined, d = 0) =>
  v == null || !isFinite(v) ? "—" : v.toFixed(d);

export default function ControlClient() {
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

  const connected = data?.pi_connected === true;
  const pumps = data?.pumps ?? [];

  return (
    <>
      <header>
        <h1>A2W Control</h1>
        <span className="dim">remote setpoint control · via hub</span>
        <span
          className={`chip ${connected ? "heating" : "offline"}`}
          style={{ marginLeft: 4 }}
        >
          {connected ? "Pi connected" : "Pi offline"}
        </span>
        <form action="/api/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <div className="controls">
        <div className="seg">
          <a href="/">Analytics</a>
          <a className="active" href="/control">Control</a>
        </div>
      </div>

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
                  <span className={`chip ${chip}`}>{chip}</span>
                </h2>
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
    </>
  );
}
