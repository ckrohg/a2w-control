# MAHRW030ZA(BEH2) Modbus RTU Register Map — distilled

> Source of truth: `A2W Modbus.docx` (Winnie @ Guangdong Macon). This file is a
> cleaned-up transcription of that doc (converted from a messy Word table — see
> caveats at bottom). On any conflict, the docx wins; on ambiguity, verify against
> hardware during Phase 1 commissioning.

## Transport

- Modbus **RTU**, half-duplex, **2400 baud, 8N1** (8 data bits, no parity, 1 stop bit)
- Master = our bridge (via W610 transparent TCP); **slave = heat pump main control board**
- Slave address: **1–16, set by SW2 DIP** on the board (default assumed 1 — unconfirmed)
- Function codes: **0x03** read holding, **0x06** write single, **0x10** write multiple
- ⚠️ The doc describes the CRC as "CRC-16/X25, X16+X12+X5+1" (the CCITT polynomial),
  which is *not* the standard Modbus CRC-16 (X16+X15+X2+1). Almost certainly a doc
  error — try standard pymodbus RTU framing first; if CRC errors on every frame, this
  is the first thing to suspect.

## Holding registers — R/W (0x03/0x06/0x10)

| Reg | Content | Range / values | Default |
|---|---|---|---|
| 2000 | System on/off switch | 0–1 | |
| 2001 | System mode | 0 cooling, 1 floor heating, 2 fan-coil heating, 3 curve heating, 4 time-division heating, 5 hot water | doc: only 0–1 are stable — **do not write modes 2–5** |
| 2002 | Cooling setpoint | 10–25 °C | |
| **2003** | **Heating setpoint** (primary write target) | **20 °C – value of reg 2027** | |
| 2004 | Hot water setpoint | 20 °C – value of reg 2027 | |
| 2005 | Emergency switch override | 0 use hardware input, 1 force on, 2 force off | 0 |
| 2010 | Heating start return difference (hysteresis) | 2–18 | 5 |
| 2011 | Cooling start return difference | 2–18 | 5 |
| 2012 | Water pump working mode | 0–2 | 2 |
| 2013 | Water pump switching interval | 2–20 min | 5 |
| 2014 | Compressor cumulative runtime before defrost | 20–90 min | 45 |
| 2015 | Outdoor coil temp to enter defrost | −15…−1 °C | −3 |
| 2016 | Max defrost time | 5–20 min | 8 |
| 2017 | Coil temp to exit defrost | 1–40 °C | 13 |
| 2018 | Ambient temp for extended defrost cycle | −30…5 °C | −10 |
| 2019 | Extended defrost cycle | 20–90 min | 45 |
| 2020 | Ambient−coil ΔT to lengthen defrost | 0–30 °C | 10 |
| 2021 | Ambient-too-low protection threshold | −41…0 °C | −35 |
| 2022 | Low-ambient protection (cooling mode) | −1…20 °C | 5 |
| 2023 | EEV operation cycle | 20–90 s | 30 |
| 2024 | Fixed-freq target superheat | −10…15 °C | 5 |
| 2025 | Fixed-freq EEV manual/auto | 0 manual, 1 auto | 1 |
| 2026 | Fixed-freq EEV manual steps | 0–480 | 400 |
| **2027** | **Max water temp setting** (= upper bound for 2003/2004) | 20–90 °C | **55** |
| 2028 | Cooling min water temp | 3–15 °C | 12 |
| 2029 | Electric heating installed | 0 no, 1 yes | 1 |
| 2030 | Ambient temp to enable electric heater | −41…45 °C | −20 |
| 2031 | Electric heating start delay | 0–60 min | 30 |
| 2032 | Fixed-freq compressor current protection | 0–50 A | 15 |
| 2033 | Reduce working frequency | 0 off, 1 on | 0 |
| 2034 | Inverter main EEV target superheat | −10…15 °C | 5 |
| 2035 | Centralized control scheme | 0 fast heating, 1 energy saving | 0 |
| 2036 | Module adjustment cycle | 5–240 | 20 |
| 2037 | Forced pump emptying function | 0 off, 1 on | 0 |
| 2038 | Low-temp forced water pump ambient setting | −25…5 °C | −10 |
| 2039 | Timing limit lock unit | 0–99 | 0 |
| 2006–2009, 2040–2049 | Reserved | | |

## Read-only registers (0x03)

### Temps & per-system telemetry

| Reg | Content | Notes |
|---|---|---|
| 2050 | **Water inlet temp** | −40…99 °C |
| 2051 | **Water outlet temp** | −40…99 °C |
| 2052 | **Ambient temp** | −40…99 °C |
| 2053 | Sys1 inverter aux-circuit EEV opening | 0–500 |
| 2054 | Sys2 inverter aux-circuit EEV opening | 0–500 |
| 2055 | Sys1 inverter discharge temp | 0–150 °C |
| 2056 | Sys1 inverter coil temp | |
| 2057 | Sys1 inverter suction temp | |
| 2058 | Sys1 inverter AC current input | 0–99 A |
| 2059 | Sys1 inverter main EEV opening | actual = value × 2 |
| 2060 | Sys1 inverter cooling coil temp | |
| 2061 | Sys1 inverter bus voltage | actual = value × 10 |
| 2062 | Sys1 inverter IPM module temp | |
| **2063** | **Sys1 inverter real power** | units unconfirmed (W?) — verify |
| 2064 | Sys1 inverter fan motor speed | |
| 2065 | Sys1 inverter high pressure | |
| 2066 | Sys1 inverter low pressure | |
| 2067 | Sys1 inverter AC voltage input | |
| 2068 | Sys1 inverter compressor actual frequency | |
| 2069/2070 | Sys1 inverter EE high/low | |
| 2071–2075 | Sys1 fixed-freq: discharge temp, coil temp, suction temp, compressor current (0–99 A), main EEV (×2) | |
| 2076 | Fixed-speed DC fan speed | |
| 2077 | Fixed-speed AC input voltage | |
| 2078/2079 | Fixed-freq EE high/low | |
| 2080–2095 | Sys2 inverter block, same layout as Sys1: 2080 discharge, 2081 coil, 2082 suction, 2083 AC current, 2084 main EEV (×2), 2085 cooling coil, 2086 bus voltage, 2087 IPM temp, **2088 = Sys2 inverter actual power**, 2089 fan speed, 2090 high pressure, 2091 low pressure, 2092 AC current(sic — doc says current; Sys1 equivalent is AC voltage), 2093 compressor frequency, 2094/2095 EE | |
| 2096–2100 | Sys2 fixed-freq: discharge, coil, suction, current, EEV (×2) | |

**Resolves handoff §4 open item:** 2063 vs 2088 are not two candidates for one value —
**2063 = System 1 (R410A stage) inverter power, 2088 = System 2 (R134a stage) inverter power.**
Neither includes the fixed-frequency (on/off) compressors; estimate those from current
(2074/2099) × AC voltage (2077) if total-unit power matters. Sum + verify against a
clamp meter during commissioning.

### Status & fault bitfields

**2110 — System status** (bit set = active):
| Bit | Meaning |
|---|---|
| 0 | Wire controller switch status |
| 1 | Compressor 1 running |
| 2 | Compressor 2 running |
| 3/4/5 | Fan high/medium/low speed (any set = fan running) |
| 6 | Circulating water pump |
| 7 / 8 | Four-way valve 1 / 2 |
| 9 / 10 | Crankcase heater 1 / 2 |
| 11 | Electric heating active |
| 12 | Chassis heating |
| 13–15 | Reserved |

**2111 — Fixed-speed system errors** (bit → fault code):
| Bit | Code | Meaning |
|---|---|---|
| 0 | E02 | Sys1 fixed-freq discharge sensor error |
| 1 | E04 | Sys2 fixed-freq discharge sensor error |
| 2 | E06 | Sys1 fixed-freq coil sensor error |
| 3 | E08 | Sys2 fixed-freq coil sensor error |
| 4 | E10 | Sys1 fixed-freq suction sensor error |
| 5 | E12 | Sys2 fixed-freq suction sensor error (doc says "System 1" — likely typo) |
| 6 | E39 | Comms failure fixed-freq board ↔ inverter board 1 |
| 7 | E40 | Comms failure fixed-freq board ↔ inverter board 2 |
| 8 | E28 | Fixed-freq system EE error |
| 9 | FA | Fixed-freq inverter fan error |
| 10 | E19 | Water inlet temp sensor error |
| 11 | E18 | Water outlet temp sensor error |
| 12 | E22 | Ambient temp sensor error |
| 13 | E21 | Comms failure with wall controller |
| 14 | E23 | Time-limited locking unit |
| 15 | — | Reserved |

**2112 — System 1 inverter errors:**
| Bit | Code | Meaning |
|---|---|---|
| 0 | E01 | Sys1 inverter discharge sensor fault |
| 1 | E05 | Sys1 inverter outer coil fault |
| 2 | E09 | Sys1 inverter suction fault |
| 3 | E13 | Sys1 inverter inner coil fault |
| 5 | E41 | Comms fault inverter main board 1 ↔ driver board |
| 6 | E43 | Inverter main board 1 EE fault |
| 7 | R13 | Inverter drive 1 IPM module failure |
| 8 | R02 | Drive 1 compressor abnormal start (phase loss / reverse) |
| 9 | E43 | Inverter drive 1 EE fault |

**2113 — System 2 inverter errors:** same layout → E03, E07, E11, E15, E42, E44, R30, R26 (start), E44 (drive EE)

**2114–2115 — Fixed-frequency protections** (32-bit, spans two registers):
| Bit | Code | Meaning |
|---|---|---|
| 0 | **P01** | **Water flow switch protection** (critical) |
| 1 | P10 | Fixed-freq board phase-sequence protection |
| 2 | P03 | Sys1 fixed-freq high-pressure switch |
| 3 | P05 | Sys2 fixed-freq high-pressure switch |
| 4 | P07 | Sys1 fixed-freq low-pressure switch |
| 5 | P09 | Sys2 fixed-freq low-pressure switch |
| 6 | P12 | Sys1 fixed-freq discharge over-temp |
| 7 | P14 | Sys2 fixed-freq discharge over-temp |
| 8 | P15 | Inlet/outlet ΔT too large |
| 9 | P16 | Cooling over-cool protection |
| 10 | **P17** | **Stage 1 anti-freeze protection (NORMAL in winter — info, not error)** |
| 11 | **P17** | **Stage 2 anti-freeze protection (same)** |
| 12 | P18 | Electric heating overheat protection |
| 13 | P20(?) | Sys1 fixed-freq AC current protection |
| 14 | P22(?) | Sys2 fixed-freq AC current protection |
| 15 | — | Fan overload protection |
| 16 | PC(?) | Low ambient temp protection |
| 17–31 | — | Reserved (doc garbled here: "P20P22P24PC reserved" — verify bits 13/14/16 codes on hardware) |

**2116 — System 1 inverter protections:**
| Bit | Code | Meaning |
|---|---|---|
| 0 | P02 | High-pressure switch |
| 1 | P06 | Low-pressure switch |
| 2 | P11 | Discharge temp too high |
| 3 | P19 | AC current protection |
| 4 | P31 | Cooling outdoor coil overheat |
| 5 | P33 | Cooling indoor coil overheat |
| 6 | R01 | IPM over-temperature |
| 7 | R06 | Compressor current protection |
| 8 | R10 | AC voltage protection |
| 9 | R11 | Bus voltage protection |
| 10 | R20 | Compressor shell-top protection |

**2117 — System 2 inverter protections:** same layout → P04, P08, P13, P21, P32, P34, R25, R27, R28, R29, R31

**2118 — System switch status** (raw hardware switch states, not faults):
| Bit | Meaning |
|---|---|
| 0/1 | Sys1 fixed-freq high/low pressure switch |
| 2/3 | Sys2 fixed-freq high/low pressure switch |
| 4 | AC online switch |
| 5 | Water flow switch |
| 6 | Emergency switch |
| 7 | Electric heating overheat switch |

## Commissioning verification checklist (Phase 1)

- [ ] Register addressing offset: doc addresses (2000+) vs pymodbus 0-based — read 2050–2052 and sanity-check against wall controller display
- [ ] Temp scaling: ranges are quoted in whole °C (−40…99) suggesting 1 °C resolution, but Macon boards often use ×0.1 — verify
- [ ] Signedness of temps (need negative ambient to decode correctly — NH winter)
- [ ] Units of 2063/2088 power (W? ×10?) — verify against clamp meter or known draw
- [ ] CRC: standard Modbus CRC-16 vs the doc's claimed CCITT polynomial
- [ ] Slave address (SW2 DIP setting per unit)
- [ ] Setpoint write: reg 2003 respects 20–reg2027 bounds; confirm reg 2027 value (default 55 °C) on the actual units
- [ ] Bit-13/14/16 codes in 2114–2115 (garbled in doc)

## Code coverage of this document (audited 2026-07-04)

Every non-reserved register in the protocol doc is decoded by `heatpump-bridge`
(`bridge/registers.py` + `bridge/faults.py`): control/setpoints 2000–2005 (writes:
2002/2003 only, mode-aware; 2004 refused; 2000/2001/2005 read-only by design),
all wire parameters 2010–2039 (snapshot `parameters`, shown in the UI "Unit parameters"
panel), all telemetry 2050–2100 incl. aux EEVs 2053/2054 and EE codes
(2069/2070, 2078/2079, 2094/2095, exposed raw), and all status/fault/switch words
2110–2118. Register 2092 is decoded raw (`ac_input_raw`) — the doc calls it "AC current
input" but its System-1 twin (2067) is AC *voltage*; resolve during commissioning.
Unused by design: function code 0x10 (multi-write; single 0x06 writes only).

## Caveats

Converted from a Word table with merged cells; the original docx had duplicated/
garbled rows in the bitfield section (transcribed here with best-effort cleanup and
`(?)` markers). The docx itself remains the authority: `A2W Modbus.docx` in this folder.
