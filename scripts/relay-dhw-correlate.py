#!/usr/bin/env python3
"""
@purpose Relay-map self-calibration starter (TempIQ#1505 follow-up). Read-only.
Proposes the SensorLinx ECO-0600 relay index -> function map that #1505 currently
ships as generic `relay_N` (RELAY_FUNCTION_MAP_VERSION "1505-tbd-generic-v1"), by
correlating each relay's energized state against known demand signals:

  * DHW-draw windows  -> the DHW pump/diverter relay (identifiable YEAR-ROUND, since
                         hot-water draws happen every day — the fast win).
  * per-zone HEATING  -> that zone's circulator relay (needs HEATING-season data; in
                         summer the space zones are idle so those stay unresolved).

Method: for each relay index r and each demand signal s, compute the "lift"
    P(relay r energized | s active) / P(relay r energized overall).
A lift >> 1 means relay r tracks signal s -> r is s's pump/valve. The DHW relay is
whichever index has the highest lift against the draw signal.

DATA SOURCE (TempIQ DB — the per-relay truth; a2w only stores a coarse relay count):
  * Preferred once #1505 has deployed + synced: `hydronic_load_snapshots.relay_states`
    (jsonb array of 16) with `--snapshots`.
  * Available now historically: individual `relay_N_status` readings with `--readings`.
Both need a read-only connection in $TEMPIQ_DATABASE_URL. Nothing runs without it —
this is a ready-to-run starter, not a live result. Rerun after #1505 deploys, or point
it at historical relay_N_status readings today for the DHW relay.

Usage:
    export TEMPIQ_DATABASE_URL='postgres://...:5432/postgres?sslmode=require'
    python3 scripts/relay-dhw-correlate.py --readings --days 30
    python3 scripts/relay-dhw-correlate.py --snapshots --days 14   # post-#1505
"""
import argparse
import json
import os
import subprocess
import sys

# Property + signal conventions verified from the #1503/#1505 recon (2026-07-15):
#   readings.metadata->>'hvacStatus' = 'HEATING'  -> a space zone calling
#   readings.unit = 'gal' (streamlabs water meter)  -> DHW draw when bucket sum > 2 gal/h
#   readings.metric_type = 'relay_1_status'..'relay_16_status', value 0|1
PROPERTY_ID = "10ade374-bd2e-466b-83aa-6329b8f39c71"  # 6 Black Brook (a2w property)
DHW_GAL_PER_HOUR = 2.0


def psql(sql: str) -> list[dict]:
    """Run a read-only query via psql, return rows as dicts. Empty list on any error."""
    url = os.environ.get("TEMPIQ_DATABASE_URL")
    if not url:
        sys.exit(
            "TEMPIQ_DATABASE_URL is not set.\n"
            "This starter needs a read-only TempIQ DB connection. Export it and rerun:\n"
            "  export TEMPIQ_DATABASE_URL='postgres://...sslmode=require'\n"
            "(Until then the relay map stays the safe generic relay_N / tbd:true from #1505.)"
        )
    try:
        out = subprocess.run(
            ["psql", url, "-t", "-A", "-F", "\x1f", "--no-psqlrc", "-c", sql],
            capture_output=True, text=True, timeout=120, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"[warn] query failed: {e}", file=sys.stderr)
        return []
    rows = []
    for line in out.splitlines():
        if line.strip():
            rows.append(line.split("\x1f"))
    return rows


def lift_table(mode: str, days: int) -> None:
    # Draw windows (hour buckets with > DHW_GAL_PER_HOUR of metered flow) and zone-HEATING
    # hours are the demand signals; relay energization is the response we're mapping.
    relay_src = {
        "readings": """
            SELECT date_trunc('hour', r.timestamp) AS hour,
                   (regexp_replace(r.metric_type, '\\D', '', 'g'))::int AS relay_idx,
                   max(r.value) AS energized
            FROM readings r JOIN equipment e ON r.equipment_id = e.id
            WHERE e.property_id = %(pid)s AND r.metric_type LIKE 'relay_%%_status'
              AND r.timestamp > now() - interval '%(days)s days'
            GROUP BY 1, 2""",
        "snapshots": """
            SELECT date_trunc('hour', timestamp) AS hour,
                   idx + 1 AS relay_idx,
                   max((relay_states->>idx)::numeric) AS energized
            FROM hydronic_load_snapshots,
                 generate_series(0, 15) AS idx
            WHERE property_id = %(pid)s AND relay_states IS NOT NULL
              AND timestamp > now() - interval '%(days)s days'
            GROUP BY 1, 2""",
    }[mode]

    sql = f"""
    WITH relay AS ({relay_src}),
    draw AS (
        SELECT date_trunc('hour', r.timestamp) AS hour
        FROM readings r JOIN equipment e ON r.equipment_id = e.id
        WHERE e.property_id = %(pid)s AND r.unit = 'gal'
          AND r.timestamp > now() - interval '%(days)s days'
        GROUP BY 1 HAVING sum(r.value::float) > {DHW_GAL_PER_HOUR}
    )
    SELECT rl.relay_idx,
           count(*) FILTER (WHERE rl.energized > 0)::float / nullif(count(*), 0) AS p_overall,
           count(*) FILTER (WHERE rl.energized > 0 AND d.hour IS NOT NULL)::float
             / nullif(count(*) FILTER (WHERE d.hour IS NOT NULL), 0) AS p_during_draw,
           count(*) FILTER (WHERE d.hour IS NOT NULL) AS draw_hours
    FROM relay rl LEFT JOIN draw d ON rl.hour = d.hour
    GROUP BY rl.relay_idx ORDER BY rl.relay_idx
    """.replace("%(pid)s", f"'{PROPERTY_ID}'").replace("%(days)s", str(days))

    rows = psql(sql)
    if not rows:
        print(
            f"No relay data in the last {days}d via --{mode}.\n"
            + ("  hydronic_load_snapshots is empty until #1505 deploys + the ECO-0600 syncs — "
               "rerun then, or use --readings on historical relay_N_status.\n" if mode == "snapshots"
               else "  no relay_N_status readings found for this property/window.\n")
        )
        return

    print(f"\nRelay ↔ DHW-draw correlation (--{mode}, last {days}d)")
    print(f"{'relay':>5}  {'P(on)':>7}  {'P(on|draw)':>10}  {'lift':>6}  candidate")
    best_idx, best_lift = None, 0.0
    for idx, p_overall, p_draw, draw_h in rows:
        po = float(p_overall) if p_overall not in ("", None) else 0.0
        pd = float(p_draw) if p_draw not in ("", None) else 0.0
        lift = (pd / po) if po > 0 else 0.0
        flag = "← DHW pump?" if lift >= 1.5 and pd >= 0.3 else ""
        if lift > best_lift:
            best_idx, best_lift = idx, lift
        print(f"{idx:>5}  {po:>7.2f}  {pd:>10.2f}  {lift:>6.2f}  {flag}")

    print()
    if best_idx and best_lift >= 1.5:
        print(f"Proposed: relay {best_idx} = DHW pump (lift {best_lift:.2f}). Edit RELAY_FUNCTION_MAP")
        print(f'  index {best_idx}: {{ label: "dhw_pump", isCall: true, tbd: false }} and bump the map version.')
    else:
        print("No relay yet clears the lift≥1.5 / P(on|draw)≥0.3 bar — collect more days and rerun.")
    print("Zone circulators need HEATING-season data; extend this with a per-zone HEATING join once winter calls land.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Propose the ECO-0600 relay→function map from correlation.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--readings", action="store_const", dest="mode", const="readings", help="use historical relay_N_status readings (works now)")
    g.add_argument("--snapshots", action="store_const", dest="mode", const="snapshots", help="use hydronic_load_snapshots.relay_states (post-#1505)")
    ap.add_argument("--days", type=int, default=30, help="lookback window (default 30)")
    args = ap.parse_args()
    lift_table(args.mode or "readings", args.days)


if __name__ == "__main__":
    main()
