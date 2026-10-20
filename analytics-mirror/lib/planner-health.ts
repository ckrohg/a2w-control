// @purpose Server-only read of the planner's /health `storm` block (#183). Shared by the storm
// banner (a server component on every page) and GET /api/planner/storm, so both read the same
// authority the same way. PLANNER_API_TOKEN stays on the server. A short timeout keeps a slow
// planner from holding up every page render; any failure returns { storm: null, error }.
import type { HealthStorm } from "./storm-state";

const TIMEOUT_MS = 4000;

export async function fetchPlannerStorm(): Promise<{ storm: HealthStorm | null; status: number; error?: string }> {
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) return { storm: null, status: 503, error: "planner not configured" };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const out: { storm?: unknown } = await res.json().catch(() => ({}));
    // /health goes 503 when polls are failing, but the storm field is still authoritative.
    const s = out.storm as Partial<HealthStorm> | null | undefined;
    if (s && typeof s === "object" && typeof s.state === "string") {
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
    return { storm: null, status: 502, error: `planner health gave no storm state (${res.status})` };
  } catch (e) {
    return { storm: null, status: 502, error: `planner unreachable: ${String(e)}` };
  }
}

/** The planner's /health `pump_health` block (pumphealth.ts), raw — lib/pump-health.ts normalizes it. Same auth + timeout. */
export async function fetchPlannerPumpHealth(): Promise<{ pumpHealth: unknown; status: number; error?: string }> {
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) return { pumpHealth: null, status: 503, error: "planner not configured" };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const out: { pump_health?: unknown } = await res.json().catch(() => ({}));
    return out.pump_health ? { pumpHealth: out.pump_health, status: 200 }
      : { pumpHealth: null, status: 502, error: `planner health gave no pump_health (${res.status})` };
  } catch (e) {
    return { pumpHealth: null, status: 502, error: `planner unreachable: ${String(e)}` };
  }
}
