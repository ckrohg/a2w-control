// @purpose I1 conflict banner (plan §3, kanban quick-win) — server component rendered on
// every authed page. Computes the invariant directly from Neon (latest HBX tank target
// from slx_readings + latest per-pump setpoint from the Pi-pushed readings) — no planner
// dependency, so the flag stays visible even if the planner service is down. Renders
// nothing when data is stale/missing or the invariant holds.
import { sql } from "@vercel/postgres";

const I1_MARGIN_F = 8;
const SLX_FRESH_S = 20 * 60;
const PUMP_FRESH_S = 15 * 60;

const f = (c: number) => (c * 9) / 5 + 32;

export async function I1Banner() {
  try {
    const t = await sql`
      SELECT tank_target_f::float8 AS target, EXTRACT(EPOCH FROM ts)::float8 AS ts
      FROM slx_readings WHERE tank_target_f IS NOT NULL ORDER BY ts DESC LIMIT 1`;
    if (!t.rowCount) return null;
    const { target, ts } = t.rows[0] as { target: number; ts: number };
    const now = Date.now() / 1000;
    if (now - ts > SLX_FRESH_S) return null;

    const p = await sql`
      SELECT DISTINCT ON (pump_id) pump_id, name, online, setpoint_c::float8 AS setpoint_c, ts
      FROM readings ORDER BY pump_id, ts DESC`;
    const required = target + I1_MARGIN_F;
    const offenders = p.rows
      .filter((r) => r.online && r.setpoint_c != null && now - Number(r.ts) <= PUMP_FRESH_S)
      .filter((r) => f(Number(r.setpoint_c)) < required)
      .map((r) => `${r.name ?? r.pump_id} at ${f(Number(r.setpoint_c)).toFixed(1)}°F`);
    if (!offenders.length) return null;

    return (
      <div className="banner">
        ⚠ <b>I1 conflict:</b> HBX tank target {target.toFixed(1)}°F needs pump setpoints ≥ {required.toFixed(0)}°F,
        but {offenders.join(" and ")} {offenders.length > 1 ? "are" : "is"} below it — the tank can never
        satisfy calls (deadlock → backup timer). Raise the pump setpoint or lower the target.
      </div>
    );
  } catch {
    return null;
  }
}
