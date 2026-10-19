// @purpose Pure state mapping for a REAL tank boost (#186): what the confirm modal says will be
// written, the planner's verdict on the POST, and the read-back confirmation states driven by the
// writer status (GET /api/planner/target → planner /api/hbx/target). No React, no fetch, no "@/"
// imports — so scripts/test-*.ts can run it under tsx. The planner is the authority on every limit
// here (writes.ts boost(): 15–120 min, I4 envelope ≤ strictCapF, I1, 15-min rate limit); these
// constants only shape the UI so it never offers something the planner is certain to refuse.

/** writes.ts DEFAULT_OPTS.strictCapF — the everyday ceiling on a dashboard boost. */
export const STRICT_CAP_F = 135;
/** writes.ts boost(): minutes must be 15–120. A longer boost is refused with 422. */
export const BOOST_MIN_MINUTES = 15;
export const BOOST_MAX_MINUTES = 120;
/** How long after an accepted POST we wait for the writer status to show the boost row. */
export const READBACK_TIMEOUT_MS = 90_000;
/** A writer status older than this is not a confirmation (Codex pass 1): a hung poll must not keep "in force" up. */
export const READBACK_STALE_MS = 90_000;
/** writes.ts status(): adoption_pending = |commanded − operative| > 3. Same tolerance here. */
const ADOPT_TOL_F = 3;

/** The subset of the planner's writer status (writes.ts status()) this module reads. */
export type WriterStatus = {
  tank_f: number | null;
  target_f: number | null; // OPERATIVE — temp1.target the HBX is actually driving to
  commanded_target_f?: number | null; // midpoint of the curve we last wrote
  adoption_pending?: boolean;
  band?: { lo: number; hi: number } | null; // I4 envelope at the live outdoor
  i1_margin_f?: number;
  active_boost?: { target_f: number; restore_at: string } | null;
};

/** The subset of the hub's /api/state this module reads (planner hub.ts HubState). */
export type HubPump = { id: string; name?: string | null; online?: boolean; state?: string | null; setpoint_c?: number | null };
export type HubState = { pi_connected?: boolean; ts?: number | null; pumps?: HubPump[] };

export type BoostRequest = { target_f: number; minutes: number };

/** writes.ts PI_STATE_FRESH_MS — the planner refuses I1 against hub state older than this. */
const PI_FRESH_S = 10 * 60;

const cToF = (c: number) => (c * 9) / 5 + 32;
const r0 = (v: number) => Math.round(v);

/** Hour of day (0–23) in America/New_York — the Plan chart's 24 blocks are Eastern hours. */
export function etHour(ms: number): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" }).format(new Date(ms)));
  return Number.isFinite(h) ? h % 24 : 0;
}

/**
 * The chart span of a boost on record: from the current Eastern hour through the hour its timer
 * ends. Eastern offsets are whole hours, so UTC hour boundaries are Eastern hour boundaries.
 */
export function boostChartSpan(nowMs: number, restoreAtIso: string): { start: number; hours: number } | null {
  const end = Date.parse(restoreAtIso);
  if (!Number.isFinite(end) || nowMs >= end) return null; // expired → nothing to draw
  const hourStart = nowMs - (nowMs % 3_600_000);
  const hours = Math.max(1, Math.ceil((end - hourStart) / 3_600_000));
  return { start: etHour(nowMs), hours: Math.min(hours, 24) };
}

export function fmtMinutes(min: number): string {
  if (min % 60 === 0) return `${min / 60} h`;
  if (min > 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${min} min`;
}

/** The exact request body, clamped/rounded the way it will be sent. */
export function boostBody(target_f: number, minutes: number): BoostRequest {
  return { target_f: Math.round(target_f), minutes: Math.round(minutes) };
}

/**
 * Things the planner will (or very likely will) refuse, checked against the latest writer status
 * and hub state BEFORE sending. Advisory only — the request is still sent if the owner confirms,
 * because the planner, not this page, is the guardrail.
 */
export function preflight(req: BoostRequest, st: WriterStatus | null, hub: HubState | null, nowS: number): string[] {
  const out: string[] = [];
  if (req.minutes < BOOST_MIN_MINUTES || req.minutes > BOOST_MAX_MINUTES) {
    out.push(`${req.minutes} min is outside the planner's ${BOOST_MIN_MINUTES}–${BOOST_MAX_MINUTES} min boost limit — it will be refused.`);
  }
  if (req.target_f > STRICT_CAP_F) out.push(`${req.target_f} °F is above the ${STRICT_CAP_F} °F everyday cap — it will be refused.`);
  if (st?.band && (req.target_f < st.band.lo || req.target_f > st.band.hi)) {
    out.push(`${req.target_f} °F is outside the planner's I4 envelope right now (${st.band.lo}–${st.band.hi} °F) — it will be refused.`);
  }
  if (st?.active_boost) out.push(`A boost to ${st.active_boost.target_f} °F is already active.`);
  if (hub) {
    const age = hub.ts != null ? nowS - hub.ts : null;
    if (hub.pi_connected === false || age == null || age > PI_FRESH_S) {
      out.push("The Pi's pump state is not live, so the planner cannot run the I1 check — it will refuse the write.");
    } else if (st?.i1_margin_f != null) {
      const need = req.target_f + st.i1_margin_f;
      for (const p of hub.pumps ?? []) {
        if (p.online && p.setpoint_c != null && cToF(p.setpoint_c) < need) {
          out.push(`I1: ${p.name ?? p.id} setpoint ${cToF(p.setpoint_c).toFixed(1)} °F is below ${need} °F (target + ${st.i1_margin_f} °F margin) — the planner will refuse unless the setpoints rise first.`);
        }
      }
    }
  }
  return out;
}

/** The confirm-modal body: exactly what goes over the wire and what the planner then does. */
export function confirmText(req: BoostRequest, nowMs: number): string {
  const until = new Date(nowMs + req.minutes * 60_000);
  return (
    `Writes POST /api/hbx/boost {"target_f": ${req.target_f}, "minutes": ${req.minutes}} to the planner. ` +
    `If the planner accepts, it sets the HBX reset curve so the tank target is ${req.target_f} °F, and at about ` +
    `${until.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ` +
    `(${fmtMinutes(req.minutes)} from now) it restores the curve automatically — that timer is stored in the database, ` +
    `so a planner restart does not strand it. The HBX adopts the new target only at its next reheat cycle. ` +
    `It does not change pump setpoints, staging or the element breaker.`
  );
}

export type RejectionKind = "network" | "i1" | "rate_limit" | "envelope" | "invalid" | "pi_state" | "lease" | "unreachable" | "auth" | "other";

/** Classify a non-2xx planner answer. The planner's text is kept VERBATIM for display. */
export function classifyRejection(status: number, error: string): { kind: RejectionKind; label: string; text: string } {
  const e = error || `HTTP ${status}`;
  let kind: RejectionKind = "other";
  if (status === 0) kind = "network";
  else if (status === 409 || /^I1 conflict/i.test(e)) kind = "i1";
  else if (status === 429 || /rate limited/i.test(e)) kind = "rate_limit";
  else if (/I4 envelope/i.test(e)) kind = "envelope";
  else if (status === 422) kind = "invalid";
  else if (status === 423) kind = "lease";
  else if (status === 401) kind = "auth";
  else if (status === 502 || /unreachable|not configured/i.test(e)) kind = "unreachable";
  else if (status === 503) kind = "pi_state";
  const label: Record<RejectionKind, string> = {
    network: "Unknown — no answer from the dashboard server",
    i1: "Refused by the I1 check",
    rate_limit: "Refused — rate limit",
    envelope: "Refused — outside the I4 envelope",
    invalid: "Refused — invalid request",
    pi_state: "Refused — the planner cannot verify the plant right now",
    lease: "Refused — another planner instance holds the write lease",
    unreachable: "Not sent — the planner could not be reached",
    auth: "Not sent — signed out",
    other: "Refused by the planner",
  };
  return { kind, label: label[kind], text: e };
}

export type Tone = "neutral" | "pending" | "ok" | "bad";
export type BoostPhase =
  | { phase: "idle" }
  | { phase: "sending"; req: BoostRequest }
  | { phase: "rejected"; req: BoostRequest; status: number; error: string }
  // seen = the read-back has shown this boost at least once (set by the caller from boostView)
  | { phase: "accepted"; req: BoostRequest; atMs: number; restoreAt: string | null; seen?: boolean };

export type BoostView = { key: "idle" | "sending" | "rejected" | "verifying" | "unconfirmed" | "commanded" | "in_force" | "superseded" | "ended" | "expired_unrestored" | "stale"; tone: Tone; text: string };

function sameRestore(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= 60_000;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

/**
 * The ONLY place a success message is produced, and only from read-back. An accepted POST says
 * nothing about the device until the writer status shows the boost row AND the commanded curve;
 * "in force" needs the operative target (temp1.target) to have landed on it.
 */
export function boostView(p: BoostPhase, st: WriterStatus | null, nowMs: number, stAtMs: number | null = nowMs): BoostView {
  const v = boostViewFresh(p, st, nowMs);
  // A read-back is only as good as its age: past READBACK_STALE_MS nothing reads as confirmed.
  if (st != null && stAtMs != null && nowMs - stAtMs > READBACK_STALE_MS && v.key !== "sending" && v.key !== "rejected") {
    const min = Math.max(1, Math.round((nowMs - stAtMs) / 60_000));
    return { key: "stale", tone: "pending", text: `writer status not refreshed for ${min} min — last read-back said: ${v.text}` };
  }
  return v;
}

function boostViewFresh(p: BoostPhase, st: WriterStatus | null, nowMs: number): BoostView {
  if (p.phase === "idle") {
    if (st?.active_boost) return activeView(st.active_boost, st, nowMs);
    return { key: "idle", tone: "neutral", text: "no boost active" };
  }
  if (p.phase === "sending") return { key: "sending", tone: "pending", text: `sending boost to ${p.req.target_f} °F…` };
  if (p.phase === "rejected") {
    const r = classifyRejection(p.status, p.error);
    return { key: "rejected", tone: "bad", text: `${r.label}: ${r.text}` };
  }
  // accepted — confirm from read-back only
  const ab = st?.active_boost ?? null;
  const ours = ab != null && ab.target_f === p.req.target_f && (p.restoreAt == null || sameRestore(ab.restore_at, p.restoreAt));
  if (!ours) {
    if (p.seen && ab == null && st != null) {
      // The row drops out of active_boost when restore_at passes, WHETHER OR NOT expireBoosts() has
      // restored the curve yet (store.ts activeBoost: restore_at > now()). Only a commanded target that
      // has moved off the boost says the curve changed — and even then we say what it is, not why.
      const cmd = st.commanded_target_f;
      if (cmd != null && Math.abs(cmd - p.req.target_f) > ADOPT_TOL_F) {
        return { key: "ended", tone: "neutral", text: `boost to ${p.req.target_f} °F ended — commanded target is now ${cmd} °F` };
      }
      return { key: "expired_unrestored", tone: "pending", text: `boost timer for ${p.req.target_f} °F has passed, but the writer status still shows commanded ${cmd ?? "?"} °F — the restore is not confirmed yet` };
    }
    if (nowMs - p.atMs > READBACK_TIMEOUT_MS) {
      return {
        key: "unconfirmed",
        tone: "bad",
        text: `planner answered OK, but its writer status does not show this boost (${ab ? `active boost ${ab.target_f} °F` : "no active boost"}, commanded ${st?.commanded_target_f ?? "?"} °F) — NOT confirmed`,
      };
    }
    return { key: "verifying", tone: "pending", text: "planner accepted the request — reading back the writer status…" };
  }
  return activeView(ab, st!, nowMs);
}

function activeView(ab: { target_f: number; restore_at: string }, st: WriterStatus, nowMs: number): BoostView {
  const until = fmtClock(ab.restore_at);
  // The timer has run out since this read-back: whatever it said is no longer the state (Codex pass 3).
  const endMs = Date.parse(ab.restore_at);
  if (Number.isFinite(endMs) && nowMs >= endMs) {
    return { key: "expired_unrestored", tone: "pending", text: `boost timer for ${ab.target_f} °F ended at ${until} — waiting for the writer status to show the restore` };
  }
  const cmd = st.commanded_target_f;
  // The boost row exists but the curve no longer centres on it: something wrote over it (an armed
  // auto-pilot tick, a manual write) — say so rather than claim the boost is running.
  if (cmd != null && Math.abs(cmd - ab.target_f) > ADOPT_TOL_F) {
    return { key: "superseded", tone: "bad", text: `boost to ${ab.target_f} °F is on record until ${until}, but the commanded target is now ${cmd} °F — another write replaced it` };
  }
  const op = st.target_f;
  const inForce = st.adoption_pending === false && op != null && Math.abs(op - ab.target_f) <= ADOPT_TOL_F;
  if (inForce) return { key: "in_force", tone: "ok", text: `in force: tank target ${r0(op!)} °F until ${until}, then the curve restores` };
  return {
    key: "commanded",
    tone: "pending",
    text: `commanded ${ab.target_f} °F · adopts on the next reheat cycle (HBX still on ${op != null ? `${r0(op)} °F` : "?"}) · restores at ${until}`,
  };
}

/** "HP1 heating · HP2 idle" from the hub's latest Pi frame — or why it can't be said. */
export function pumpsLine(hub: HubState | null, nowS: number, err?: string): string {
  if (!hub) return err ? `pump state unavailable (${err})` : "pump state loading…";
  const pumps = hub.pumps ?? [];
  if (!pumps.length) return "pump state unavailable (hub has no Pi frame)";
  const age = hub.ts != null ? Math.round((nowS - hub.ts) / 60) : null;
  const parts = pumps.map((p) => `${p.name ?? p.id} ${p.online === false ? "offline" : p.state ?? "unknown"}`);
  const heating = pumps.filter((p) => p.online !== false && p.state === "heating").length;
  const stale = hub.pi_connected === false || age == null || age > 10;
  const head = stale ? `last known (${age == null ? "age unknown" : `${age} min old`}${hub.pi_connected === false ? ", Pi disconnected" : ""}): ` : "";
  return `${head}${parts.join(" · ")}${stale ? "" : heating === 0 ? " — no pump is heating" : ""}`;
}

/**
 * Hot-water estimate (the mockup's TempIQ model: ≈3.4 gal per °F above 110 °F, ~2 gal/min shower).
 * `now` starts from the CURRENT tank; `ifCompletes` is the tank AT the boost target and is labelled
 * that way by the caller — it is not a promise.
 */
export function hotWater(tankF: number): { gal: number; showerMin: number } {
  const gal = Math.max(0, Math.round((tankF - 110) * 3.4));
  return { gal, showerMin: Math.round(gal / 2) };
}

export function estimateLines(tankNowF: number | null, targetF: number): { now: string; ifCompletes: string } {
  const now = tankNowF == null
    ? "tank temperature unavailable — no estimate"
    : (() => { const h = hotWater(tankNowF); return `now (tank ${r0(tankNowF)} °F): ≈ ${h.gal} gal of hot water · about ${h.showerMin} min of showers`; })();
  const h2 = hotWater(targetF);
  return { now, ifCompletes: `if the boost completes (tank at ${targetF} °F): ≈ ${h2.gal} gal · about ${h2.showerMin} min of showers` };
}
