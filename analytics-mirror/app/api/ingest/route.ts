import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Pi POSTs a state snapshot here every ~60s. Bearer-token auth (INGEST_TOKEN) — the
// only unauthenticated-by-cookie route, because the Pi has no cookie. Read-only mirror:
// this never sends anything back to the Pi.
export async function POST(req: Request) {
  const token = process.env.INGEST_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const ts = Number(body?.ts);
  const pumps = Array.isArray(body?.pumps) ? body.pumps : [];
  if (!ts || !pumps.length) {
    return NextResponse.json({ error: "empty snapshot" }, { status: 400 });
  }

  await ensureSchema();
  for (const p of pumps) {
    await sql`INSERT INTO readings
      (ts, pump_id, name, online, state, mode_kind, setpoint_c, inlet_c, outlet_c,
       ambient_c, power_w, active_faults, error_rate)
      VALUES (${ts}, ${p.id}, ${p.name ?? null}, ${!!p.online}, ${p.state ?? null},
              ${p.mode_kind ?? null}, ${p.setpoint_c ?? null}, ${p.inlet_c ?? null},
              ${p.outlet_c ?? null}, ${p.ambient_c ?? null}, ${p.power_w ?? null},
              ${p.active_faults ?? null}, ${p.error_rate ?? null})`;
  }
  // retention: keep ~90 days (free-tier friendly)
  await sql`DELETE FROM readings WHERE ts < ${ts - 90 * 86400}`;
  return NextResponse.json({ ok: true, stored: pumps.length });
}
