# Pump health — measured baseline and the thresholds it sets (2026-10-19)

Owner ask (2026-10-19): detect a heat pump that runs, or draws power, **without producing heat** while it shows
no fault code, and track each pump's daily performance so a slow decline shows up. Everything below was measured
before any threshold was chosen. The checks ship in **shadow** (`planner/src/pumphealth.ts`).

## Data source, and why it is not `analyze-local.sh`

`scripts/analyze-local.sh` could not run on this Mac: the backup passphrase is not in its Keychain
(`a2w-backup-passphrase` is missing), so the Postgres dump cannot be decrypted. The numbers instead come from the
**Pi's own nightly SQLite backup**, `~/bridge-data/backups/bridge-20261019.db`, written 03:30 ET. It was copied with `scp`
and opened locally with `immutable=1`. The live `bridge.db` and the production database were never queried.

That backup has more detail than the mirror. It holds 20 s pump samples with the raw status word (compressor,
four-way valve, electric heater bits), 25 s SPAN-local samples, and the remote-contact (HBX call) edges. It does
**not** hold the HBX tank temperature (`slx_readings` lives only in Postgres). §5 is therefore a proxy, and it
says so.

Window: 97 days (2026-07-13 → 2026-10-19), with headline numbers on the last 60. Pump samples: 377 838 (pump1)
and 374 944 (pump2). SPAN: 287 992 per circuit. Gaps: Oct 7–11 (Pi offline) and Aug 20–23.

**Mapping.** `pump1 ↔ "Air-Water 1"`, `pump2 ↔ "Air-Water 2"`. The owner confirmed it, and so did the live SPAN data
(the self-heal block in the Pi config, 2026-10-19). Every "running" sample below draws kW on its own circuit,
which proves the mapping again.

**Sign.** SPAN reports consumption as **negative** watts (min −6 556 W, max +5.8 W on the buffer-tank circuit).
Every number below is `|power_w|`.

Scripts (scratch, not committed): `overview.py`, `measure.py`, `rolling.py`, `episodes.py`, `drift.py`,
`called.py`, `defrost.py`. Each is a plain `sqlite3` reader over the backup.

The cadence the planner will see is mirror `readings` at ~60 s (one per exporter push) and `span_readings` at
~25 s. The rolling-window figures in §1–§3 down-sample the Pi rows to every 3rd 20 s sample (~60 s) to match.

## 1. Outlet − inlet ΔT while heating

Temperatures are **whole °C** (register resolution), so ΔT moves in 1 °C steps.

| minutes since compressor start | pump1 p1 / p5 / p50 | pump2 p1 / p5 / p50 |
|---|---|---|
| 0–2   | −2 / −2 / 2 | −2 / −1 / 2 |
| 2–5   | 2 / 3 / 4 | 3 / 4 / 5 |
| 5–10  | 4 / 4 / 5 | 5 / 5 / 6 |
| 10–20 | 3 / 4 / 5 | 4 / 5 / 6 |
| 20+   | 1 / 3 / 4 | 2 / 3 / 5 |

Instantaneous ΔT is noisy and transient after a start or a defrost. The check therefore uses a **window mean**
over steady heating: compressor ≥ 5 min into the run, ≥ 5 min after any defrost, and the whole window heating.

| 97 d, steady windows | pump1 min / p1 / p5 / p50 | pump2 min / p1 / p5 / p50 |
|---|---|---|
| 10-min mean ΔT | 3.10 / 3.30 / 3.55 / 5.00 | 3.60 / 3.82 / 4.00 / 5.82 |
| 15-min mean ΔT | **3.40** / 3.40 / 3.53 / 4.60 | **3.93** / 4.00 / 4.13 / 5.27 |
| 20-min mean ΔT | 3.35 / 3.45 / 3.55 / 4.20 | 4.00 / 4.05 / 4.15 / 4.85 |

The lowest windows all fall on 2026-10-18 at −2 °C outdoor, the coldest data in the set: lift capacity falls with
outdoor temperature. Outlet rise over the first 10 min of a run is p5 3 °C / p50 14 °C for pump1, and p5 5 /
p50 14 for pump2. It is too dependent on where the tank sits to be a trigger, so it is reported in the episode
detail only.

## 2. SPAN circuit draw, heating vs idle

| state (bridge-derived) | pump1 \|W\| p1 / p50 / p99 | pump2 \|W\| p1 / p50 / p99 |
|---|---|---|
| heating, ≥ 2 min into run | 3 353 / 5 443 / 6 292 | 3 359 / 5 348 / 6 173 |
| heating, first 2 min | 177 / 3 338 / 5 049 | 181 / 3 324 / 4 904 |
| defrost | 50 / 217 / 2 476 | 223 / 764 / 2 836 |
| idle / off | 5.5 / 8.3 / 66 | 5.4 / 8.5 / 68 |

The windowed figures are the ones the check uses:

- **Heating, trailing 5-min SPAN mean** (steady heating): the minimum over 97 d is **3 707 W** (pump1) and **2 851 W** (pump2).
  A heating sample ≥ 2 min into a run drew < 1 000 W exactly once per pump in 60 d (one sample).
- **Idle ≥ 5 min, trailing 4-min mean**: p99.9 is 90 W / 92 W and the maximum is **672 W** / **415 W**. Idle samples
  > 1 kW exist (0.1 %), but every one is a single isolated sample, ≤ 0.8 min long. That is 20 s/25 s sampling
  misalignment at a start or stop. There was **no sustained idle draw in 97 days**.
- The electric-heating status bit (status word bit 11) was **never set** in 97 days.
- Standby energy: ~0.19 kWh/day (≈ 8 W). On pump2's idle days in the E21 period (Oct 6–17) it rose to 0.5–1.2 kWh/day
  (25–50 W, crankcase heating). That is real, but far below a stuck-contactor signature.

## 3. Defrost — frequency and duration vs outdoor temperature

There is little defrost data yet: the first defrost in the whole record is **2026-10-16**, with 16 episodes since.

| outdoor bin | pump1 run-h / defrosts / per run-h / durations min | pump2 |
|---|---|---|
| −3…0 °C | 3.4 / 4 / 1.18 / 7.7–8.3 | 2.1 / 3 / 1.40 / 6.0–8.7 |
| 0…3 °C  | 2.5 / 2 / 0.81 / 8.3–9.0 | 0.6 / 2 / 3.3 / 4.0–8.0 |
| 3…6 °C  | 2.0 / 3 / 1.47 / 4.0, **31.0**, **83.0** | 1.1 / 1 / 0.9 / 8.0 |
| ≥ 6 °C  | 23 / 1 / 0.04 / 4.0 | 6+ / 0 / 0 / — |

Normal defrosts last **4.0–9.4 min**, about every 50–55 min of running below 0 °C. The unit's own maximum defrost
time (register 2016) accepts only 5–20 min.

**Two spells were not defrosts.** Both were on pump1:

- **2026-10-18 02:07–03:29Z, 82.6 min.** Status 721/4817: four-way valve 1 + water pump + fan, compressor
  **off**, chassis heater cycling. SPAN mean 226 W. Outlet fell 59 → 52 °C. The HBX call (remote contact) stayed
  on from 01:36 to 03:36, and pump2 was dropping off Modbus at the same time.
- **2026-10-19 00:55–01:26Z, 31 min.** Same signature; SPAN mean 86 W.

`stagewatch.ts` **suspends** its unserved clock while a pump reports `defrost`. A stuck or false "defrost" while
called is therefore invisible to every existing alarm. That makes it the clearest real instance of "running but
not doing its job, no fault code" in the record. It gets its own check (`defrost_overlong`).

## 4. Starts per hour (short cycling)

Over 60 d, pump1 had 222 starts and pump2 150. Run length p50 is 10.7 / 11.3 min and p90 20 / 22 min, in the
shoulder season with DHW-sized calls. The most starts in any trailing 60 min was **4** (pump1) and **3** (pump2).
On the cold days (Oct 16–18) pump1 had 15–17 starts/day. The HBX call → compressor start lag is p99 4.3 min and
max 8.3 min.

## 5. Tank response while a stage is called — proxy only

`slx_readings` (tank_f, stages_called) is Postgres-only, so this could not be measured directly. The proxy is the
pump's **inlet (return ≈ tank) temperature** over 40-min windows that were ≥ 90 % heating inside a remote-contact
call. On the first cold night (2026-10-17 20:36Z, 6 °C outdoor), inlet fell **13 °C** in 40 min while pump1 heated
normally (ΔT 4–5 °C at 5+ kW). House load can exceed one pump's output, so a flat or falling tank is **not**
evidence of a sick pump by itself.

Physics: C_eff = 110 gal × 8.34 = 917 BTU/°F. One pump at ~5.3 kW electric and COP ~2.5–3 delivers ~45–55 kBTU/h,
about +50–60 °F/h with no load. Standby loss is `tank_ua` × (T − 65) °F/h, ≈ 0.6 °F/h at 100 °F.

The threshold for `called_tank_flat` is **provisional**: net rise ≤ +2 °F over 45 min of called + heating, after
adding back standby loss (≈ 0.75 °F at 118 °F). That is ~5 % of one pump's no-load rise (~40 °F in 45 min). The check also records the pump's own ΔT and draw, so a reader can tell a load problem
(pump healthy) from a pump problem. It stays shadow until the slx distribution has been measured with the query in
the appendix.

## 6. Degradation index and its noise

The lift index is `Σ(ΔT·h) / Σ kWh` over heating (not defrost) samples, pooled per **5 °C outdoor bin**. It is a
*relative* index (no flow meter, so not absolute kW of heat). Its level by bin, over 97 d:

| bin | pump1 | pump2 |
|---|---|---|
| −5 °C | 0.78 (3.4 h) | 1.01 (2.3 h) |
| 5 °C | 0.81 (12.3 h) | 1.02 (2.7 h) |
| 10 °C | 0.85 (13.4 h) | 1.01 (7.8 h) |
| 15 °C | 0.91 (15.6 h) | 1.06 (11.8 h) |
| 20 °C | 1.00 (18.2 h) | 1.12 (5.0 h) |

**The twins are not equal.** pump1 sits ~16 % below pump2 at every bin (daily ratio p50 0.84, p5–p95 0.65–1.03),
probably a flow difference. A twin check must compare against the *learned* ratio, never 1.0.

Noise of the trend statistic: the trailing 7-day pooled index vs the 14 days before, same bin, with ≥ 2 run-h on
both sides.

- pump1: 28 comparisons; |drift| p50 2.8 %, p95 11.2 %, **max 12.1 %**
- pump2: 19 comparisons; |drift| p50 4.5 %, p95 12.7 %, **max 12.7 %**
- twin ratio: only 1 comparison so far (2.3 %). Summer runs alternate and are short. Winter fills this in.

A **20 %** flag sits ~1.6× above the worst week-over-baseline swing seen.

## Thresholds chosen (all shadow)

| check | condition | margin vs measured |
|---|---|---|
| `running_no_lift` | 15 min of steady heating (≥ 5 min into the run, ≥ 5 min after defrost), mean ΔT **< 1.5 °C** while SPAN draws ≥ 1 kW | observed min 3.4 / 3.9 °C (cold); 1.5 leaves room for winter's lower lift |
| `heating_no_draw` | reported heating ≥ 7 min, trailing 5-min SPAN mean **< 1 000 W** | observed min 2 851 W |
| `idle_draw` | reported idle/off ≥ 10 min, trailing 9-min SPAN mean **> 1 000 W** | observed max 672 W; isolated > 1 kW samples last ≤ 0.8 min |
| `defrost_overlong` | continuous `defrost` **> 20 min** (the unit's own max defrost setting caps at 20) | normal 4–9.4 min; the two real anomalies were 31 and 83 min |
| `called_tank_flat` | stage called + mapped pump heating ≥ 90 % of 45 min; tank net rise + standby loss **≤ 2 °F** | **provisional** (§5): ~5 % of one pump's no-load capacity |
| daily `lift_drift` | 7-d pooled lift index vs own prior 14 d, same 5 °C bin (≥ 2 run-h each), **≤ −20 %** | noise max 12.7 % |
| daily `twin_drift` | p1/p2 index ratio vs its own 14-d baseline, same bin, **≥ 20 %** change | 1 comparison so far |
| daily `short_cycling` | **> 6** starts in any trailing 60 min | observed max 4 |

Stale-data gating follows stagewatch. Nothing is evaluated when the hub has no live Pi frame (#167
`piStateUnverifiable`). The newest mirror reading must be ≤ 3 min old after correcting for the measured Pi clock
offset. A window with a reading gap > 150 s or a SPAN gap > 120 s is "unknown", and unknown never opens or closes
an episode.

## Re-measure

- When the backup passphrase is on this Mac, run `scripts/analyze-local.sh` and the appendix query, then replace
  §5's proxy.
- After ≥ 2 weeks below 0 °C, re-run `rolling.py` and `defrost.py` on a fresh Pi backup. The −5…0 °C bins hold
  < 4 run-h today.

## Appendix — called_tank_flat on a restored backup (run locally only)

```sql
-- 45-min windows in which a stage was called on every slx reading: tank rise + standby credit (tank_ua 0.017)
SELECT percentile_cont(array[0.01, 0.05, 0.1, 0.5]) WITHIN GROUP (ORDER BY (a.tank_f - w.t0) + 0.017 * (w.t0 - 65) * 0.75)
FROM slx_readings a
CROSS JOIN LATERAL (
  SELECT (array_agg(tank_f ORDER BY ts))[1] AS t0, count(*) AS n,
         bool_and(coalesce(stages_called[1], false) OR coalesce(stages_called[2], false)) AS called
  FROM slx_readings b WHERE b.ts BETWEEN a.ts - interval '45 minutes' AND a.ts
) w
WHERE a.ts > now() - interval '60 days' AND w.called AND w.n >= 8;
```
