// @purpose Pure view model for the backup-element gate card: the planner's /health.backup_gate (planner/src/backupgate.ts)
// → what a glance should say. The gate runs in SHADOW until the owner flips it live, so its "breaker state" is then
// VIRTUAL (what it would have done) — the card must never let that be mistaken for the real breaker, which is shown
// separately (relay, from the Pi's SPAN snapshot). Defensive about every field: an older planner without the block,
// a partial object, or a blind poll all render honestly ("unavailable" / "not judged"), never as "normal".

export interface GateClock { label: string; min: number; of: number }
export interface BackupGateView {
  available: boolean;
  mode: "shadow" | "live" | "off" | "unknown";
  reopenEnabled: boolean;
  /** the real Buffer Tank breaker */
  relay: string | null;
  elementW: number | null;
  /** the gate's own state (virtual in shadow) */
  gateState: "open" | "closed" | null;
  virtual: boolean;
  blind: string | null;
  error: string | null;
  clocks: GateClock[];
  rules: { failedNotRecovering: boolean | null; floor: boolean | null; recovered: boolean | null };
  conditions: { tankF: number | null; targetF: number | null; riseF: number | null; called: boolean | null; failed: string[] };
  floorF: number | null;
  floorHoldMin: number | null;
  deficitF: number | null;
  failHoldMin: number | null;
  lastEvent: { at: string; kind: string; title: string } | null;
  episodes7d: number | null;
  overrideUntil: string | null;
  piFallback: { mode: string; allDownMin: number | null; holdMin: number | null; down: string[]; last: string | null } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function backupGateView(raw: unknown): BackupGateView {
  const g = obj(raw);
  const empty: BackupGateView = {
    available: false, mode: "unknown", reopenEnabled: false, relay: null, elementW: null, gateState: null, virtual: true,
    blind: null, error: null, clocks: [], rules: { failedNotRecovering: null, floor: null, recovered: null },
    conditions: { tankF: null, targetF: null, riseF: null, called: null, failed: [] }, floorF: null, floorHoldMin: null,
    deficitF: null, failHoldMin: null,
    lastEvent: null, episodes7d: null, overrideUntil: null, piFallback: null,
  };
  if (!g) return empty;
  const t = obj(g.thresholds) ?? {};
  const c = obj(g.clocks) ?? {};
  const cond = obj(g.conditions) ?? {};
  const mode = g.mode === "shadow" || g.mode === "live" || g.mode === "off" ? g.mode : "unknown";
  const failed = Array.isArray(cond.failed)
    ? (cond.failed as unknown[]).map(obj).filter(Boolean).map((f) => `${str(f!.id) ?? "?"} ${str(f!.why) ?? ""}`.trim()) : [];
  const ev = obj(g.last_event);
  const pf = obj(g.pi_fallback);
  const pfDown = obj(pf?.down) ?? {};
  const pfLast = obj(pf?.last);
  return {
    available: true,
    mode,
    reopenEnabled: g.reopen_enabled === true,
    relay: str(g.relay),
    elementW: num(g.element_w),
    gateState: g.gate_state === "open" || g.gate_state === "closed" ? g.gate_state : null,
    virtual: g.gate_state_virtual !== false,
    blind: str(g.blind),
    error: str(g.error),
    clocks: [
      { label: "pump failed, tank not recovering", min: num(c.failed_not_recovering_min) ?? 0, of: num(t.fail_hold_min) ?? 90 },
      { label: `below ${num(t.floor_f) ?? "?"} °F, all pumps running`, min: num(c.floor_min) ?? 0, of: num(t.floor_hold_min) ?? 30 },
      ...(g.gate_state === "closed" ? [{ label: "recovered", min: num(c.recovered_min) ?? 0, of: num(t.open_hold_min) ?? 60 }] : []),
    ],
    rules: { failedNotRecovering: bool(cond.failed_not_recovering), floor: bool(cond.floor), recovered: bool(cond.recovered) },
    conditions: { tankF: num(cond.tank_f), targetF: num(cond.target_f), riseF: num(cond.rise_f), called: bool(cond.called), failed },
    floorF: num(t.floor_f),
    floorHoldMin: num(t.floor_hold_min),
    deficitF: num(t.deficit_f),
    failHoldMin: num(t.fail_hold_min),
    lastEvent: ev && str(ev.at) ? { at: str(ev.at)!, kind: str(ev.kind) ?? "?", title: str(ev.title) ?? "" } : null,
    episodes7d: num(g.episodes_7d),
    overrideUntil: str(g.override_until),
    piFallback: pf ? {
      mode: str(pf.mode) ?? "unknown",
      allDownMin: num(pf.all_down_min),
      holdMin: num(pf.hold_min),
      down: Object.entries(pfDown).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k} ${v}`),
      last: pfLast ? `${str(pfLast.outcome) ?? "?"}` : null,
    } : null,
  };
}

/** The card's chip: the gate's mode and, when it has acted (or would have), that first. */
export function gateChip(v: BackupGateView): { cls: string; text: string } {
  if (!v.available) return { cls: "offline", text: "unavailable" };
  if (v.mode === "off") return { cls: "off", text: "off" };
  if (v.gateState === "closed") return { cls: "warn", text: v.virtual ? "would be ON (shadow)" : "element available" };
  if (v.blind) return { cls: "offline", text: "not judged" };
  if (v.clocks.some((c) => c.min > 0 && c.label !== "recovered")) return { cls: "warn", text: "watching" };
  return { cls: "ok", text: v.mode === "shadow" ? "shadow · normal" : "normal" };
}

/** Real breaker line: what the panel says, with the element's draw. */
export function relayLine(v: BackupGateView): string {
  const r = v.relay === "OPEN" ? "OFF (open)" : v.relay === "CLOSED" ? "ON (closed)" : "unknown";
  return `Breaker: ${r}${v.elementW != null ? ` · element ${Math.round(v.elementW)} W` : ""}`;
}
