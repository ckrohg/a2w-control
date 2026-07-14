#!/usr/bin/env python3
# @purpose Dev-time extractor for the /curve page: bakes the FROZEN before-era
# (2025-11-22 → 2026-07-13, pre-A-6-freeze) out of TempIQ's Supabase Postgres into
# lib/curve-history.json so the dashboard never gains a runtime dependency on TempIQ
# (CLAUDE.md architecture rule). Read-only against TempIQ; re-runnable; stdlib-only
# (shells out to psql). Sources: SensorLinx tank/target/outdoor readings, SPAN circuit
# daily kWh, cop_measurements (tank-calorimetry). Counterfactual targets mirror
# planner/src/shadow.ts (DEFAULT_OPTS + bandFor + curveTargetF) — keep in sync by hand.
import csv, io, json, math, os, subprocess, sys
from collections import defaultdict
from datetime import datetime, timezone

TEMPIQ_ENV = os.path.expanduser("~/Documents/Claude/TempIQv2/.env")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "lib", "curve-history.json")

# Era boundary: optimization era began 2026-07-14 (A-6 baseline freeze). Naive UTC.
ERA_END_UTC = "2026-07-14 04:00:00"  # midnight 2026-07-14 America/New_York

EQ_TANK = "dd51c859-852f-425c-92da-eba45c305959"
EQ_TARGET = "228c1de9-c62d-498e-a2a9-48205b54a637"
EQ_OUTDOOR = "a4e5975b-76c0-494f-bf19-e491812123e7"
CIRCUITS = {
    "aw1": "1f8e4fd4-5d37-4a1e-aacd-80d6e117f6e5",   # Air-Water 1 (HP1)
    "aw2": "d121131a-fda2-4a42-9393-e5dfeb5f74e1",   # Air-Water 2 (HP2)
    "element": "115b9ea0-1e13-43f4-9d60-0853b6014be4",  # Buffer Tank 16.5 kW backup element
    "circ": "29c162fa-de48-4b3a-a96e-67ba1b869676",  # Hydronic Zone Pumps & Control
    "glycol": "06e2107e-010a-4970-81b7-a86c1205dcf4",  # Glycol Feeder
}
COP_SYSTEM = "a69cfb88-3c0f-4e8b-bb60-80c241754249"  # current hydronic system (calc v3)

RATE_USD_KWH = 0.368  # TempIQ utility_config 2026-07-01, flat, 1:1 net metering
ETA_BASE = 0.43       # TempIQ zone-cop-calculator default; no learned system_cop_eta row

# As-found regime (knowledge/reference/hbx-curve-asfound.md, a6-baseline.md)
ASFOUND = {
    "cfg": {"dot": 5, "dbt": 165, "wwsd": 125, "mbt": 145},  # configured HBX reset curve
    "mined_fit": {"a": 165.5, "b": -0.161, "sigma": 0.38},   # A-0: target = a + b*outdoor
    "hp1_setpoint_f": 167.0,   # 75 °C, parked 24/7
    "hp2_setpoint_f": 159.8,   # 71 °C, parked 24/7
}
# Optimizer (planner/src/shadow.ts DEFAULT_OPTS — keep in sync)
OPTS = {"dhwWindows": [[6, 9], [17, 22]], "dhwFloorF": 120, "idleF": 110,
        "i1MarginF": 5, "winterGuardF": 50, "sanitizeF": 131, "strictCapF": 135}


def tempiq_db_url():
    with open(TEMPIQ_ENV) as fh:
        for line in fh:
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not found in TempIQv2/.env")


def q(db, sql):
    # session pooler (port 5432): SET persists for the connection, overriding the
    # role's short default statement_timeout that a 430k-row scan trips.
    p = subprocess.run(["psql", db, "--csv", "-v", "ON_ERROR_STOP=1",
                        "-c", "SET statement_timeout = '300s'", "-c", sql],
                       capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"psql failed:\n{sql}\n{p.stderr}")
    # two -c commands -> psql prints both results; the SET output is "SET\n"
    out = p.stdout.split("SET\n", 1)[-1]
    return list(csv.DictReader(io.StringIO(out)))


def curve_target_f(out_f):
    c = ASFOUND["cfg"]
    t = c["dbt"] + (out_f - c["dot"]) * (c["mbt"] - c["dbt"]) / (c["wwsd"] - c["dot"])
    return max(min(t, max(c["dbt"], c["mbt"])), min(c["dbt"], c["mbt"]))


def band_for(out_f):
    t = min(max(out_f, 5), 55)
    lo = 95 + ((55 - t) / 50) * 40
    hi = min(curve_target_f(out_f) + 3, OPTS["strictCapF"])
    return lo, max(hi, lo)


def cop_surface(out_f, water_f):
    """TempIQ zone-cop-calculator.ts:864-871 Carnot-style fit; clamped to [1, 6]
    like TempIQ's MAX_VALID_COP. Valid for lift > 5 °F; tiny lifts clamp at 6."""
    lift = water_f - out_f
    if lift <= 5:
        return 6.0
    eta = max(0.30, ETA_BASE - max(0.0, 17 - out_f) * 0.001)
    return max(1.0, min(6.0, eta * (water_f + 459.67) / lift))


def in_window(h):
    return any(a <= h < b for a, b in OPTS["dhwWindows"])


def cop_summary(pts):
    """Per-calc-version summary — the versions must never be blended (the blend is
    what produced the bogus 'flat 2.33'). v3 = auditable session calculator."""
    def med(vs):
        vs = sorted(vs)
        return round(vs[len(vs) // 2], 2) if vs else None
    v1 = [p["cop"] for p in pts if (p["v"] or 0) < 3]
    v3 = [p["cop"] for p in pts if (p["v"] or 0) >= 3]
    v3_mild = [p["cop"] for p in pts if (p["v"] or 0) >= 3 and p["o"] < 65]
    v3_warm = [p["cop"] for p in pts if (p["v"] or 0) >= 3 and p["o"] >= 65]
    return {"v1_n": len(v1), "v1_median": med(v1), "v3_n": len(v3),
            "v3_median_mild": med(v3_mild), "v3_median_warm": med(v3_warm)}


def counterfactual_targets(hours_by_day):
    """Mirror shadow.ts: DHW floors + daily sanitize in warmest hour + optional winter
    guard, clamped to the I4 band. Returns {hour_key: (cur, pot)} — 'cur' = planner as
    currently built (winter guard mimics HBX curve), 'pot' = envelope potential (winter
    solver serves the I4 lower line instead)."""
    out = {}
    for day, rows in hours_by_day.items():
        warmest = max(rows, key=lambda r: r["out"])
        for r in rows:
            base = OPTS["dhwFloorF"] if in_window(r["lh"]) else OPTS["idleF"]
            if r is warmest and len(rows) >= 6:
                base = max(base, OPTS["sanitizeF"])
            lo, hi = band_for(r["out"])
            cur = base
            if r["out"] < OPTS["winterGuardF"]:
                cur = max(cur, curve_target_f(r["out"]))
            out[r["h"]] = (min(max(cur, lo), hi), min(max(base, lo), hi))
    return out


def main():
    db = tempiq_db_url()

    series = {}
    for name, eq in (("tank", EQ_TANK), ("tgt", EQ_TARGET), ("outdoor", EQ_OUTDOOR)):
        print(f"querying hourly SensorLinx series: {name} …", file=sys.stderr)
        series[name] = {
            r["h"]: float(r["v"]) for r in q(db, f"""
              SELECT to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'),
                             'YYYY-MM-DD"T"HH24:00') AS h,
                     avg(value) AS v
              FROM readings
              WHERE equipment_id = '{eq}'
                AND timestamp < '{ERA_END_UTC}'
                AND value BETWEEN -50 AND 250
              GROUP BY 1 ORDER BY 1""")
        }
    hourly = [{"h": h, "tank": series["tank"].get(h), "tgt": series["tgt"].get(h),
               "outdoor": series["outdoor"][h]}
              for h in sorted(series["outdoor"])]

    print("querying SPAN daily kWh …", file=sys.stderr)
    ids = ", ".join(f"'{v}'" for v in CIRCUITS.values())
    span = q(db, f"""
        SELECT to_char((bucket_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
                       'YYYY-MM-DD') AS d,
               equipment_id, sum(energy_wh) / 1000.0 AS kwh
        FROM span_circuit_aggregations
        WHERE equipment_id IN ({ids}) AND bucket_start < '{ERA_END_UTC}'
        GROUP BY 1, 2 ORDER BY 1""")

    print("querying cop_measurements …", file=sys.stderr)
    # calc_version matters: v1 (Nov 25–Mar 26, winter-only, unauditable, inflated —
    # beats the machine's 1.96 spec ceiling at A-12C/W75C) vs v3 (Mar–Jul, session-based,
    # auditable). Mixing them across seasons is what manufactured the flat-COP artifact
    # (2026-07-14 forensics). Keep both, tagged, and never blend their medians.
    cop_rows = q(db, f"""
        SELECT to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'),
                       'YYYY-MM-DD"T"HH24:00') AS h,
               outdoor_temp_f, cop, sink_temp_f, calc_version
        FROM cop_measurements
        WHERE system_id = '{COP_SYSTEM}' AND cop BETWEEN 0.8 AND 8
        ORDER BY timestamp""")

    # ---- hourly rows -> working set --------------------------------------------------
    rows = []
    for r in hourly:
        if not (r["tank"] and r["outdoor"]):
            continue
        rows.append({
            "h": r["h"], "lh": int(r["h"][11:13]),
            "tank": float(r["tank"]), "tgt": float(r["tgt"]) if r["tgt"] else None,
            "out": float(r["outdoor"]),
        })
    tank_by_hour = {r["h"]: r["tank"] for r in rows}
    by_day = defaultdict(list)
    for r in rows:
        by_day[r["h"][:10]].append(r)
    cf = counterfactual_targets(by_day)

    # ---- density bins (2 °F) ---------------------------------------------------------
    def bins(key):
        acc = defaultdict(int)
        for r in rows:
            v = r[key]
            if v is None:
                continue
            acc[(2 * round(r["out"] / 2), 2 * round(v / 2))] += 1
        return [[o, t, n] for (o, t), n in sorted(acc.items())]

    bins_tank = bins("tank")
    bins_target = bins("tgt")

    # ---- daily rollup + counterfactual COP ratios ------------------------------------
    span_daily = defaultdict(dict)
    inv = {v: k for k, v in CIRCUITS.items()}
    for r in span:
        span_daily[r["d"]][inv[r["equipment_id"]]] = float(r["kwh"])

    daily, est = [], {"cur_kwh_saved": 0.0, "pot_kwh_saved": 0.0, "hp_kwh_measured": 0.0}
    for day in sorted(by_day):
        rs = by_day[day]
        outs = [r["out"] for r in rs]
        # demand-proxy weights for intra-day COP averaging only (heating + DHW floor)
        w = [max(2.0, 65 - o) for o in outs]
        cop_af = [cop_surface(r["out"], r["tank"]) for r in rs]
        cop_cur = [cop_surface(r["out"], cf[r["h"]][0]) for r in rs]
        cop_pot = [cop_surface(r["out"], cf[r["h"]][1]) for r in rs]
        wavg = lambda vs: sum(v * wi for v, wi in zip(vs, w)) / sum(w)
        d_af, d_cur, d_pot = wavg(cop_af), wavg(cop_cur), wavg(cop_pot)
        sp = span_daily.get(day, {})
        hp_kwh = sp.get("aw1", 0) + sp.get("aw2", 0)
        if hp_kwh > 0.5:
            est["hp_kwh_measured"] += hp_kwh
            est["cur_kwh_saved"] += hp_kwh * (1 - d_af / d_cur)
            est["pot_kwh_saved"] += hp_kwh * (1 - d_af / d_pot)
        daily.append({
            "d": day,
            "out": round(sum(outs) / len(outs), 1),
            "out_lo": round(min(outs), 1), "out_hi": round(max(outs), 1),
            "tank": round(sum(r["tank"] for r in rs) / len(rs), 1),
            "tgt": round(sum(r["tgt"] for r in rs if r["tgt"]) / max(1, sum(1 for r in rs if r["tgt"])), 1),
            "kwh": {k: round(v, 2) for k, v in sp.items()},
            "cop_af": round(d_af, 2), "cop_cur": round(d_cur, 2), "cop_pot": round(d_pot, 2),
            "tgt_cur": round(sum(cf[r["h"]][0] for r in rs) / len(rs), 1),
            "tgt_pot": round(sum(cf[r["h"]][1] for r in rs) / len(rs), 1),
        })

    # ---- measured COP points (join tank temp for rows missing sink_temp_f) -----------
    cop_pts = []
    for r in cop_rows:
        sink = float(r["sink_temp_f"]) if r["sink_temp_f"] else tank_by_hour.get(r["h"])
        cop_pts.append({
            "o": round(float(r["outdoor_temp_f"]), 1) if r["outdoor_temp_f"] else None,
            "cop": round(float(r["cop"]), 2),
            "sink": round(sink, 1) if sink else None,
            "v": int(r["calc_version"]) if r["calc_version"] else None,
        })
    cop_pts = [p for p in cop_pts if p["o"] is not None]

    # ---- per-outdoor-bin receipt lines (5 °F bins) ------------------------------------
    def median(vs):
        vs = sorted(vs); n = len(vs)
        return vs[n // 2] if n % 2 else (vs[n // 2 - 1] + vs[n // 2]) / 2

    meas_v1 = defaultdict(list)   # legacy winter calculator — inflated, keep separate
    meas_v3 = defaultdict(list)   # session-based, auditable
    for p in cop_pts:
        (meas_v1 if (p["v"] or 0) < 3 else meas_v3)[5 * round(p["o"] / 5)].append(p["cop"])
    model_bins = defaultdict(lambda: {"af": [], "cur": [], "pot": []})
    for r in rows:
        b = model_bins[5 * round(r["out"] / 5)]
        b["af"].append(cop_surface(r["out"], r["tank"]))
        b["cur"].append(cop_surface(r["out"], cf[r["h"]][0]))
        b["pot"].append(cop_surface(r["out"], cf[r["h"]][1]))
    receipt = []
    for o in sorted(set(meas_v1) | set(meas_v3) | set(model_bins)):
        e = {"o": o}
        if o in meas_v1:
            e["measured_v1"] = round(median(meas_v1[o]), 2)
            e["n_v1"] = len(meas_v1[o])
        if o in meas_v3:
            e["measured_v3"] = round(median(meas_v3[o]), 2)
            e["n_v3"] = len(meas_v3[o])
        if o in model_bins:
            for k in ("af", "cur", "pot"):
                e[k] = round(median(model_bins[o][k]), 2)
        receipt.append(e)

    # ---- totals ----------------------------------------------------------------------
    tot = defaultdict(float)
    for d in span_daily.values():
        for k, v in d.items():
            tot[k] += v

    out = {
        "meta": {
            "extracted_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "era": {"from": rows[0]["h"][:10], "to": rows[-1]["h"][:10]},
            "hours": len(rows),
            "rate_usd_kwh": RATE_USD_KWH,
            "eta_base": ETA_BASE,
            "asfound": ASFOUND,
            "opts": OPTS,
            "totals_kwh": {k: round(v) for k, v in tot.items()},
            "estimates": {
                "hp_kwh_measured": round(est["hp_kwh_measured"]),
                "cur_kwh_saved": round(est["cur_kwh_saved"]),
                "pot_kwh_saved": round(est["pot_kwh_saved"]),
                "cur_usd_saved": round(est["cur_kwh_saved"] * RATE_USD_KWH),
                "pot_usd_saved": round(est["pot_kwh_saved"] * RATE_USD_KWH),
            },
            "cop": cop_summary(cop_pts),
            "mfr_ratings_w75": [  # spec PDF section II.1, water outlet 75°C
                {"o": 10.4, "cop": 1.96}, {"o": 44.6, "cop": 2.43},
            ],
            "notes": [
                "before-era only (pre A-6 freeze 2026-07-14); winter conflated with HP2 degradation + disabled element",
                "COP surface + counterfactuals are MODEL numbers; SPAN kWh + cop_measurements are measured",
                "counterfactual scales HP circuits only; element shown as measured, never scaled",
                "the old 'flat COP 2.33' was a calc-version artifact (v1 winter rows inflated + v3 summer draw-contaminated); 2026-07-14 forensics",
            ],
        },
        "bins_tank": bins_tank,
        "bins_target": bins_target,
        "daily": daily,
        "cop_points": cop_pts,
        "receipt": receipt,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {OUT_PATH}: {os.path.getsize(OUT_PATH)//1024} KB, "
          f"{len(rows)} hours, {len(daily)} days, {len(cop_pts)} COP points, "
          f"{len(bins_tank)} tank bins", file=sys.stderr)
    print(json.dumps(out["meta"], indent=2))


if __name__ == "__main__":
    main()
