/**
 * @purpose Extract the ECO-0600's configuration subset from a device object and diff two
 * snapshots. CONFIG_FIELDS are the parameters that define behavior (curve, differentials,
 * staging, backup triggers, demand modes, schedules) — live telemetry (temps, relays,
 * run-hour counters) is deliberately excluded so drift means "someone changed a setting".
 * Canonical as-found baseline: knowledge/reference/hbx-config-asfound-20260713.json.
 */

export const CONFIG_FIELDS = [
  // hot-tank curve + differential
  "dbt", "mbt", "dot", "wwsd", "htDif",
  // cold-tank twins (cooling; unused but drift is still worth knowing)
  "mst", "dst", "cdot", "cwsd", "clDif",
  // staging
  "numStg", "hpStg", "rotTi", "rotCy", "lagT", "lagOff", "stgSeq", "loLo", "twoS", "prior",
  // backup triggers (the 16.5 kW element — plan §5.5)
  "bkLag", "bkDif", "bkTemp", "bkOd", "bkTk",
  // demand + DHW modes
  "permHD", "permCD", "dhwOn", "dhwT", "dmd",
  // ECO clock / schedule
  "ecoCl", "pgm", "autoTm", "wwTime",
  "wkd1B", "wkd1T", "wkd2B", "wkd2T", "wkd3B", "wkd3T", "wkd4B", "wkd4T",
  "wke1B", "wke1T", "wke2B", "wke2T", "wke3B", "wke3T", "wke4B", "wke4T",
  // pumps / misc setup
  "auxDif", "wPDif", "tkPmp", "pmp1Set", "pmp2Set", "p1PP", "p2PP",
  "sDel1", "sDel2", "exTm", "hpSw", "webOut", "units", "aBut",
] as const;

export type HbxConfig = Record<string, unknown>;

export function extractConfig(device: Record<string, any>): HbxConfig {
  const cfg: HbxConfig = {};
  for (const f of CONFIG_FIELDS) {
    if (f in device) cfg[f] = device[f];
  }
  return cfg;
}

export interface FieldChange {
  old: unknown;
  new: unknown;
}

/** null when identical; otherwise {field: {old, new}} for every differing field. */
export function diffConfig(prev: HbxConfig, next: HbxConfig): Record<string, FieldChange> | null {
  const changes: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      changes[k] = { old: prev[k] ?? null, new: next[k] ?? null };
    }
  }
  return Object.keys(changes).length ? changes : null;
}
