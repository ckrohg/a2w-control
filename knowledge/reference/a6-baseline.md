# A-6 — the frozen as-found baseline (2026-07-14)

> The "before" that all savings claims are measured against (plan §8.1). Two halves:
> the **consumption model** (below, FITTED) and the **register/config snapshot**
> (as-found HP setpoints + reg 2027 + HBX config — captured via the full-snapshot feed
> shipped in `release-20260714-1`, plus `hbx-config-asfound-20260713.json`).

## The weather-normalized consumption model (v1)

Fitted on TempIQ's SPAN daily ledger — **the full §8.1 ledger set**: Air-Water 1 + 2 +
16.5 kW element + hydronic circulators — joined to daily mean outdoor temp and solar
radiation, using **healthy-capacity windows only** (2025-12-07→12-31 and 2026-03; summer
2026-06-15→07-13 anchors the DHW base; Jan–Feb excluded for HP2 degradation, Apr+ for
HP2 outage):

```
daily_kWh = 36.05 + 2.119 × HDD50 − 0.0896 × solar_Wm2      (balance point 50 °F)
r² = 0.655   residual σ = 22.0 kWh/day   n = 85 days
```

Stored in Neon `baseline_model` (row 1). Sanity: predicts ~100 kWh for the 11 °F Dec 9
(actual 126 — a cold+cloudy outlier day), ~14–18 kWh for July days (actuals 12–16).

## How it may be used (honesty constraints)

- **Claim-grade at MONTHLY aggregation** (σ/√30 ≈ 4 kWh/day ≈ 4–6 % of winter usage).
  Weekly = indicative. Daily = never (±22 kWh noise: tub days, occupancy, wind).
- The balance point of 50 °F (not 65) and the significant solar term are consistent with
  a high-gain envelope — solar-aware weather normalization is NOT optional for this house.
- **Leak found by the excluded-window check:** Jan–Feb ran ~10 kWh/day BELOW model while
  HP2 was degraded — consistent with comfort shifting to the (off-ledger) mini-splits.
  Confirms §8.1's rule: mini-split circuits must be *watched* in any savings claim.

## Improvement path

1. Winter 2026-27 delivers the first clean two-pump heating season → refit (target r² ≥ 0.8).
2. Optional mid-season **baseline week** (planner paused, as-found settings) recalibrates.
3. TempIQ#1470 automates the ledger pull; until then the fit is reproducible from
   `span_circuit_aggregations` with the query in the session journal (2026-07-14).

## Register/config half — ✅ CAPTURED (2026-07-14, via release-20260714-1's snapshot feed)

- HBX as-found: `hbx-config-asfound-20260713.json` (curve 165/5 ↔ 145/125, diff 4).
- HP as-found (Neon `pump_snapshots`, 31 wire parameters each): **reg 2027 = 75 °C on
  BOTH units** (installer-raised from the 55 °C factory default — owner's "75 °C at all
  times" confirmed at the register; Phase B's 75 °C cap is exact). Setpoints as-found:
  pump1 **75 °C**, pump2 **71 °C**. write_enabled at capture: pump1 false, pump2 true.
