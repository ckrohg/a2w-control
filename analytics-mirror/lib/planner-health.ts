// @purpose Server-only reads of the planner's /health blocks (#183 storm; pump_health; backup_gate).
// Shared by the storm banner (a server component on every page), GET /api/planner/storm, and the
// pump-health / backup-gate cards, so every caller reads the same authority the same way.
// PLANNER_API_TOKEN stays on the server. A short timeout keeps a slow planner from holding up every
// page render; any failure returns a null block plus { status, error }. The env check, fetch, auth
// header and timeout live in ONE place (fetchPlannerHealthBlock) — change them there, not per block.
import type { HealthStorm } from "./storm-state";

const TIMEOUT_MS = 4000;

type HealthKey = "storm" | "pump_health" | "backup_gate";

/**
 * One /health round trip, returning the named top-level block raw (or null with status + error).
 * status 503 = mirror not configured; 502 = planner unreachable, non-JSON, or block missing.
 * /health itself goes 503 when polls are failing, but a block that is present is still
 * authoritative, so the planner's own HTTP status is NOT a failure here — only a missing block is.
 */
async function fetchPlannerHealthBlock(key: HealthKey): Promise<{ block: unknown; status: number; error?: string }> {
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) return { block: null, status: 503, error: "planner not configured" };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const out: Partial<Record<HealthKey, unknown>> = await res.json().catch(() => ({}));
    const block = out && typeof out === "object" ? out[key] : undefined;
    if (block) return { block, status: 200 };
    return { block: null, status: 502, error: `planner health gave no ${key} (${res.status})` };
  } catch (e) {
    return { block: null, status: 502, error: `planner unreachable: ${String(e)}` };
  }
}

export async function fetchPlannerStorm(): Promise<{ storm: HealthStorm | null; status: number; error?: string }> {
  const r = await fetchPlannerHealthBlock("storm");
  if (r.status !== 200) return { storm: null, status: r.status, error: r.error };
  const s = r.block as Partial<HealthStorm>;
  if (typeof s === "object" && typeof s.state === "string") {
    return {
      storm: {
        state: s.state,
        trigger: typeof s.trigger === "string" ? s.trigger : null,
        windowEnd: typeof s.windowEnd === "string" ? s.windowEnd : null,
        enabled: s.enabled === true,
        startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
      },
      status: 200,
    };
  }
  return { storm: null, status: 502, error: "planner health gave no storm state" };
}

/** The planner's /health `pump_health` block (pumphealth.ts), raw — lib/pump-health.ts normalizes it. Same auth + timeout. */
export async function fetchPlannerPumpHealth(): Promise<{ pumpHealth: unknown; status: number; error?: string }> {
  const r = await fetchPlannerHealthBlock("pump_health");
  return r.status === 200 ? { pumpHealth: r.block, status: 200 } : { pumpHealth: null, status: r.status, error: r.error };
}

/** The planner's /health `backup_gate` block (backupgate.ts), raw — lib/backup-gate.ts normalizes it. Same auth + timeout. */
export async function fetchPlannerBackupGate(): Promise<{ backupGate: unknown; status: number; error?: string }> {
  const r = await fetchPlannerHealthBlock("backup_gate");
  return r.status === 200 ? { backupGate: r.block, status: 200 } : { backupGate: null, status: r.status, error: r.error };
}
