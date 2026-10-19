// @purpose Pure state mapping for the Control page's SPAN breaker card (remote breaker control,
// owner decision 2026-10-18): which buttons each allowlisted circuit gets and why one is disabled,
// and how a hub answer becomes the message the owner reads. The rule that matters: a success line
// appears ONLY when the hub returned the bridge's verified panel READ-BACK matching the request —
// never because a button was pressed or a request "went through". Tests: tests/breaker-state.test.ts.

export type BreakerAction = "power_cycle" | "close" | "open";

export type SpanCircuit = {
  name: string;
  found: boolean;
  circuit_id: string | null;
  relay_state: string | null;          // "CLOSED" (on) | "OPEN" (off) | null (not read yet)
  controllable: boolean | null;
  power_w: number | null;
  allow_cycle: boolean;
  allow_open: boolean;
  heat_pump: boolean;
};

export type BreakerResult = {
  ok?: boolean;
  refused?: boolean;
  circuit?: string;
  action?: string;
  relay_state?: string | null;
  expected?: string;
  verified?: boolean;
  detail?: string;
  off_s?: number;
};

export type SpanSnapshot = {
  ts: number | null;
  circuits: SpanCircuit[];
  busy: { circuit: string; action: string; started: number; off_s: number; source?: string } | null;
  pending_close: string[];
  last: BreakerResult | null;
  min_off_s: number;
  max_off_s: number;
};

/** The dashboard only offers the 60 s cycle: longer holds would outlive the serverless function
 *  that waits for the read-back (the bridge and hub accept up to 600 s from other callers). */
export const DASHBOARD_OFF_S = 60;
/** SPAN data older than this is shown but not acted on (the bridge refreshes it every ~25 s). */
export const STALE_AFTER_S = 120;

export type ButtonState = { action: BreakerAction; label: string; enabled: boolean; reason: string | null };
export type CircuitRow = {
  name: string;
  state: "on" | "off" | "unknown" | "missing";
  stateLabel: string;
  watts: string;
  note: string | null;          // in-flight / pending re-close / not controllable
  buttons: ButtonState[];
};

const ACTION_LABEL: Record<BreakerAction, string> = {
  power_cycle: `Power cycle ${DASHBOARD_OFF_S} s`,
  close: "On",
  open: "Off",
};

export function circuitRows(
  span: SpanSnapshot | null | undefined,
  ctx: { connected: boolean; armed: boolean; nowSec: number },
): CircuitRow[] {
  if (!span || !Array.isArray(span.circuits)) return [];
  const stale = span.ts == null || ctx.nowSec - span.ts > STALE_AFTER_S;
  const busy = span.busy;
  const pending = Array.isArray(span.pending_close) ? span.pending_close : [];
  return span.circuits.map((c) => {
    const state: CircuitRow["state"] = !c.found ? "missing"
      : c.relay_state === "CLOSED" ? "on" : c.relay_state === "OPEN" ? "off" : "unknown";
    const stateLabel = state === "on" ? "ON" : state === "off" ? "OFF"
      : state === "missing" ? "not found on panel" : "unknown";
    const watts = c.power_w == null || !Number.isFinite(c.power_w) ? "—" : `${Math.round(c.power_w)} W`;

    // Reasons, most fundamental first; the first one that applies disables every button.
    const common: string | null =
      !ctx.connected ? "Pi offline"
      : stale ? "SPAN data is stale — waiting for a fresh panel read"
      : !c.found ? "circuit not found on the panel"
      : c.controllable === false ? "panel reports this circuit is not user-controllable"
      : busy ? `another action is running (${busy.action.replace("_", " ")} on ${busy.circuit})`
      : !ctx.armed ? "arm write-mode controls (password) first"
      : null;

    const otherHpOff = c.heat_pump
      ? span.circuits.find((o) => o.heat_pump && o.name !== c.name && o.relay_state !== "CLOSED")
      : undefined;
    const offReason = (): string | null =>
      common ?? (pending.length ? `${pending.join(", ")} is not verified back ON yet`
        : state !== "on" ? "circuit is not ON"
        : otherHpOff ? `${otherHpOff.name} is not ON — never two heat pumps off at once`
        : null);

    const buttons: ButtonState[] = [];
    if (c.allow_cycle) {
      const reason = offReason();
      buttons.push({ action: "power_cycle", label: ACTION_LABEL.power_cycle, enabled: reason == null, reason });
    }
    {
      const reason = common ?? (state === "on" ? "already ON" : null);
      buttons.push({ action: "close", label: ACTION_LABEL.close, enabled: reason == null, reason });
    }
    if (c.allow_open) {
      const reason = offReason();
      buttons.push({ action: "open", label: ACTION_LABEL.open, enabled: reason == null, reason });
    }

    let note: string | null = null;
    if (busy && busy.circuit === c.name) {
      const end = busy.action === "power_cycle" ? busy.started + busy.off_s : null;
      note = end != null && end > ctx.nowSec
        ? `power cycle in progress — back ON in ~${Math.ceil(end - ctx.nowSec)} s`
        : `${busy.action.replace("_", " ")} in progress`;
    } else if (pending.includes(c.name)) {
      note = "COULD NOT be switched back ON — A2W keeps retrying; turn it on at the panel";
    }
    return { name: c.name, state, stateLabel, watts, note, buttons };
  });
}

export function confirmText(circuit: string, action: BreakerAction): { title: string; body: string } {
  if (action === "power_cycle") {
    return {
      title: `Power cycle ${circuit}`,
      body: `Switch ${circuit} OFF for ${DASHBOARD_OFF_S} seconds, then back ON? The heat pump loses power `
        + "for that minute (this is what clears a stuck E21). The bridge turns it back on even if this "
        + "page closes, and will refuse if the other heat pump is not ON.",
    };
  }
  if (action === "open") {
    return {
      title: `Switch ${circuit} OFF`,
      body: `Switch ${circuit} OFF and leave it off? It stays off until someone turns it back on.`,
    };
  }
  return { title: `Switch ${circuit} ON`, body: `Switch ${circuit} ON at the SPAN panel?` };
}

export type Outcome = { tone: "ok" | "warn" | "bad"; text: string };

/** Map the dashboard route's answer to the line shown under the card. `ok` tone ONLY for a
 *  verified read-back that matches what was asked. */
export function outcomeMessage(
  status: number,
  body: { ok?: boolean; detail?: string; error?: string; result?: BreakerResult | null } | null,
  req: { circuit: string; action: BreakerAction },
): Outcome {
  const r = body?.result ?? null;
  const detail = body?.detail || body?.error || "";
  const expected = req.action === "open" ? "OPEN" : "CLOSED";
  if (status === 200 && body?.ok === true && r && r.verified === true && r.relay_state === expected) {
    if (req.action === "power_cycle") {
      const off = typeof r.off_s === "number" ? `${Math.round(r.off_s)} s` : `${DASHBOARD_OFF_S} s`;
      return { tone: "ok", text: `${req.circuit} power-cycled: off ${off}, back ON — confirmed by the panel read-back.` };
    }
    return { tone: "ok", text: `${req.circuit} is ${expected === "OPEN" ? "OFF" : "ON"} — confirmed by the panel read-back.` };
  }
  if (status === 200) {
    return { tone: "warn", text: `Sent, but the panel read-back did not confirm it (${r?.detail || detail || "no read-back"}). Check the live state.` };
  }
  if (status === 502) {
    if (r?.refused) return { tone: "bad", text: `Refused — nothing was switched: ${r.detail || detail}` };
    if (r && r.relay_state === "OPEN" && req.action !== "open") {
      return { tone: "bad", text: `${req.circuit} may still be OFF: ${r.detail || detail}. A2W keeps retrying — turn it on at the panel if this persists.` };
    }
    return { tone: "warn", text: `Not confirmed: ${r?.detail || detail || "bridge error"}. Check the live state below.` };
  }
  if (status === 501) {
    return { tone: "warn", text: "The bridge on the Pi doesn't support breaker control yet — it needs the next bridge release. Nothing was switched." };
  }
  if (status === 504) {
    return { tone: "warn", text: "No answer in time — the action may still complete on the Pi. Watch the live state; don't retry until it settles." };
  }
  if (status === 503) return { tone: "bad", text: `Not sent: ${detail || "Pi offline"}. Nothing was switched.` };
  if (status === 401 || status === 403) return { tone: "bad", text: `Not sent: ${detail || "re-enter the password (arm) first"}.` };
  if (status === 400) return { tone: "bad", text: `Not sent: ${detail || "bad request"}.` };
  return { tone: "bad", text: `Failed (${status})${detail ? `: ${detail}` : ""}. Check the live state.` };
}
