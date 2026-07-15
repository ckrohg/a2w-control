#!/usr/bin/env python3
"""
@purpose Relay-map self-calibration (TempIQv2#1505 follow-up). Read-only. Proposes the
SensorLinx ECO-0600 relay index -> function labels that RELAY_FUNCTION_MAP still leaves
generic (relays 6-16, and confirming relay 5), by correlating each relay's energized
state against demand signals:

  * DHW-draw hours   -> the DHW pump/diverter relay (draws happen YEAR-ROUND).
  * per-zone HEATING -> that zone's circulator relay (needs HEATING-season data; the
                        space zones are idle in summer, so 6-16 mostly stay 0 until winter).

DATA SOURCE (verified against prod 2026-07-15):
  * Relays: `hydronic_load_snapshots.relay_states` — the jsonb 16-element array the #1505
    writer now populates (was 0 rows before #1505). This is the authoritative per-relay
    source; a2w only stores a coarse relay bitmask.
  * DHW draws: `readings` rows with `unit = 'gallons'` (the streamlabs water meter).
    NOTE: the `readings` table has NO top-level metric column — signal identity lives in
    `metadata` jsonb; the water meter is distinguished here by `unit='gallons'`.

Needs a read-only connection in $TEMPIQ_DATABASE_URL (e.g. TempIQ's Supabase session
pooler). Rows accrue from the #1505 deploy forward, so run with more `--days` as history
builds; zone-circulator resolution (relays 6-16) needs winter heat calls.

Usage:
    export TEMPIQ_DATABASE_URL='postgresql://...pooler.supabase.com:5432/postgres'
    python3 scripts/relay-dhw-correlate.py --days 30
"""
import argparse
import os
import subprocess
import sys

PROPERTY_ID = "10ade374-bd2e-466b-83aa-6329b8f39c71"  # 6 Black Brook
DHW_GAL_PER_HOUR = 2.0  # a "draw hour" — >2 gal of metered water in the hour


def psql(sql: str) -> list[list[str]]:
    """Run a read-only query via psql; return rows as field lists. Exits on connect error."""
    url = os.environ.get("TEMPIQ_DATABASE_URL")
    if not url:
        sys.exit(
            "TEMPIQ_DATABASE_URL is not set.\n"
            "This needs a read-only TempIQ DB connection (Supabase session pooler). Export it:\n"
            "  export TEMPIQ_DATABASE_URL='postgresql://...:5432/postgres'\n"
        )
    try:
        out = subprocess.run(
            ["psql", url, "-t", "-A", "-F", "\x1f", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True, text=True, timeout=120, check=True,
        ).stdout
    except subprocess.CalledProcessError as e:
        print(f"[error] query failed:\n{e.stderr.strip()}", file=sys.stderr)
        return []
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"[error] {e}", file=sys.stderr)
        return []
    return [line.split("\x1f") for line in out.splitlines() if line.strip()]


def correlate(days: int) -> None:
    pid, thr = PROPERTY_ID, DHW_GAL_PER_HOUR
    sql = f"""
    WITH relay AS (
        SELECT date_trunc('hour', timestamp) AS hour,
               idx + 1 AS relay_idx,
               max((relay_states->>idx)::int) AS energized
        FROM hydronic_load_snapshots, generate_series(0, 15) AS idx
        WHERE property_id = '{pid}' AND relay_states IS NOT NULL
          AND timestamp > now() - interval '{days} days'
        GROUP BY 1, 2
    ),
    draw AS (
        SELECT date_trunc('hour', r.timestamp) AS hour
        FROM readings r JOIN equipment e ON r.equipment_id = e.id
        WHERE e.property_id = '{pid}' AND r.unit = 'gallons'
          AND r.timestamp > now() - interval '{days} days'
        GROUP BY 1 HAVING sum(r.value::float) > {thr}
    )
    SELECT rl.relay_idx,
           round(avg((rl.energized > 0)::int)::numeric, 3)                                   AS p_overall,
           round(avg((rl.energized > 0)::int) FILTER (WHERE d.hour IS NOT NULL)::numeric, 3) AS p_draw,
           count(*)                                                                          AS hours,
           count(*) FILTER (WHERE d.hour IS NOT NULL)                                        AS draw_hours
    FROM relay rl LEFT JOIN draw d ON rl.hour = d.hour
    GROUP BY rl.relay_idx ORDER BY rl.relay_idx
    """
    rows = psql(sql)
    if not rows:
        print(f"No snapshot rows in the last {days}d. hydronic_load_snapshots accrues from the "
              f"#1505 deploy forward — rerun with more history.")
        return

    total_hours = rows[0][3] if rows else "0"
    draw_hours = rows[0][4] if rows else "0"
    print(f"\nRelay correlation — {total_hours} snapshot-hours ({draw_hours} with a DHW draw), last {days}d")
    print(f"{'relay':>5}  {'P(on)':>7}  {'P(on|draw)':>10}  {'lift':>6}  note")
    best_idx, best_lift = None, 0.0
    for idx, p_overall, p_draw, _h, _dh in rows:
        po = float(p_overall) if p_overall not in ("", None) else 0.0
        pd = float(p_draw) if p_draw not in ("", None) else 0.0
        lift = (pd / po) if po > 0 else 0.0
        note = ""
        if po >= 0.98:
            note = "always-on (circulator/system pump — not a call)"
        elif lift >= 1.5 and pd >= 0.3:
            note = "← DHW pump candidate"
        elif po == 0:
            note = "never energized in window"
        if lift > best_lift and po < 0.98:
            best_idx, best_lift = idx, lift
        print(f"{idx:>5}  {po:>7.3f}  {pd:>10.3f}  {lift:>6.2f}  {note}")

    print()
    if best_idx and best_lift >= 1.5:
        print(f"Proposed: relay {best_idx} = DHW pump (lift {best_lift:.2f}). In RELAY_FUNCTION_MAP set "
              f"index {best_idx}: {{ label: \"dhw_pump\", isCall: false, tbd: false }} and bump the version.")
    else:
        print("No relay clears the lift>=1.5 / P(on|draw)>=0.3 bar yet — need more DHW-draw hours.")
    print("Zone circulators (relays 6-16) need winter heat calls; extend this with a per-zone "
          "HEATING join (readings metadata->>'hvacStatus'='HEATING') once heating season lands.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Propose ECO-0600 relay->function labels from correlation.")
    ap.add_argument("--days", type=int, default=30, help="lookback window (default 30)")
    ap.parse_args()
    correlate(ap.parse_args().days)


if __name__ == "__main__":
    main()
