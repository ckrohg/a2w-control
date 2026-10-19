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

// ── #177: self-diagnosing foreign-curve alert ─────────────────────────────────────────────────────
// 2026-10-18 21:05:56Z and 22:05:56Z the drift poll paged "FOREIGN HBX CURVE WRITE" twice: 120/118 → 141/137 and
// 120/118 → 129/125, each exactly 1 °F under the planner's OWN flat band written shortly before (142/138 soak at
// 20:41Z, 130/126 bank at 21:36Z) and ~5 min after the planner replaced that band with the shaped curve. Nobody used
// the app and no second writer was found, but the row stored only CONFIG_FIELDS + the diff, so nothing recorded
// could tell a device/cloud echo of our own write from a real second writer. Everything below exists so the next
// such page explains itself: the raw device object on every version row, a re-read before paging, the planner's
// last write beside the row, and a verdict.

/** The reset-curve fields the planner writes (writes.ts setTarget: dbt/mbt; setCurve: dot/dbt/mbt + wwsd unchanged). */
export const CURVE_FIELDS = ["dbt", "mbt", "dot", "wwsd"] as const;
/** A changed curve field within this of a value the planner itself wrote is an echo suspect, not a second writer. */
export const ECHO_TOLERANCE_F = 2;
/** How far back a planner write counts as "ours" for the echo test. */
export const ECHO_WINDOW_MS = 60 * 60 * 1000;
/** Re-read delay: a stale cloud read must not be filed as a writer. */
export const REREAD_DELAY_MS = 30_000;

/**
 * Device-side provenance carried by the SensorLinx object (as-found 2026-07-13: changeSource "server",
 * updatedAt / connectedAt / createdAt ISO strings). The raw object keeps them whole; this is the readable subset
 * for pages and /health. Any other `…At` key the API adds later is picked up too.
 */
export function deviceMeta(dev: Record<string, any> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!dev || typeof dev !== "object") return out;
  for (const [k, v] of Object.entries(dev)) {
    if (k === "changeSource" || /At$/.test(k)) out[k] = v;
  }
  return out;
}

/** The PATCH response echo worth keeping beside an hbx_writes row: the written fields, the curve, provenance. */
export function patchEcho(dev: Record<string, any>, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(fields), ...CURVE_FIELDS])) if (k in dev) out[k] = dev[k];
  return { ...out, ...deviceMeta(dev) };
}

/** One accepted planner write, as hbx_writes records it. `requested` is what patch() sent (dbt/mbt[/dot/wwsd]). */
export interface PlannerWrite {
  at: string;
  source: string;
  action: string;
  requested: Record<string, unknown> | null;
  /** PATCH response echo (hbx_writes.response, #177); null on rows written before the column existed. */
  echo: Record<string, unknown> | null;
}

export type CurveVerdict = "echo_suspected" | "foreign";
export interface EchoMatch { field: string; value: unknown; written: number | null; written_at: string | null; delta_f: number | null }

/**
 * The verdict for a curve change: `echo_suspected` when EVERY changed curve field's new value is within
 * ECHO_TOLERANCE_F of a value the planner wrote to that same field in the ECHO_WINDOW_MS before `atMs`;
 * otherwise `foreign`. null when no curve field changed (not a curve event). Pure.
 */
export function curveVerdict(
  changes: Record<string, FieldChange>,
  writes: PlannerWrite[],
  atMs: number,
): { verdict: CurveVerdict; matches: EchoMatch[] } | null {
  const fields = CURVE_FIELDS.filter((f) => f in changes);
  if (!fields.length) return null;
  const inWindow = writes.filter((w) => {
    const t = Date.parse(w.at);
    return Number.isFinite(t) && t <= atMs && atMs - t <= ECHO_WINDOW_MS;
  });
  const matches: EchoMatch[] = fields.map((field) => {
    const value = changes[field].new;
    let best: EchoMatch = { field, value, written: null, written_at: null, delta_f: null };
    if (typeof value !== "number") return best;
    for (const w of inWindow) {
      const v = w.requested?.[field];
      if (typeof v !== "number") continue;
      const delta = Math.round((value - v) * 10) / 10;
      if (best.delta_f === null || Math.abs(delta) < Math.abs(best.delta_f)) {
        best = { field, value, written: v, written_at: w.at, delta_f: delta };
      }
    }
    return best;
  });
  const echo = matches.every((m) => m.delta_f !== null && Math.abs(m.delta_f) <= ECHO_TOLERANCE_F);
  return { verdict: echo ? "echo_suspected" : "foreign", matches };
}

/** A row for hbx_config_versions. `raw` = the poll read that saw the change; `rereadRaw` = the confirmation read. */
export interface ConfigVersionRecord {
  config: HbxConfig;
  changes: Record<string, FieldChange> | null;
  raw: Record<string, any> | null;
  rereadRaw?: Record<string, any> | null;
  verdict?: CurveVerdict | "reverted" | null;
  diagnosis?: CurveDiagnosis | null;
}

/** What /health.drift.last_foreign and the version row's `diagnosis` carry. */
export interface CurveDiagnosis {
  at: string;
  /** The curve change that stands (prev → re-read); for `reverted`, the transient first-read change. */
  fields: Record<string, FieldChange>;
  /** unconfirmed = no confirmation read (failed / shutdown): never recorded, never paged, re-checked next poll. */
  verdict: CurveVerdict | "reverted" | "unconfirmed";
  /** true = the re-read still showed the change; false = it reverted (no page); null = no re-read (failed / shutdown). */
  reread_confirmed: boolean | null;
  reread_at: string | null;
  reread_error: string | null;
  /** A planner write self-recorded a new version during the wait; the re-read was judged against it. */
  baseline_moved: boolean;
  first_read_at: string;
  planner_last_write: PlannerWrite | null;
  planner_writes_60m: PlannerWrite[];
  matches: EchoMatch[];
  device_before: Record<string, unknown>;
  device_after: Record<string, unknown>;
  paged: "high" | "default" | null;
}

export interface DriftDeps {
  /** Re-read the device (index.ts: slx.getDevice). */
  reread: () => Promise<Record<string, any>>;
  /** Sleep ms; resolves false when cut short (shutdown) — the re-read is then skipped, never delayed past a handover. */
  wait: (ms: number) => Promise<boolean>;
  /** The newest accepted planner write, and every accepted write since sinceMs (hbx_writes). */
  plannerWrites: (sinceMs: number) => Promise<{ last: PlannerWrite | null; recent: PlannerWrite[] }>;
  record: (row: ConfigVersionRecord) => Promise<void>;
  /**
   * The newest recorded version, re-fetched after the wait: a dashboard write (boost, manual target) can land during
   * the 30 s and self-record its own version — the re-read must be judged against THAT, or our own write would be
   * filed as a curve change. Optional; without it the poll-time baseline stands.
   */
  latest?: () => Promise<{ config: HbxConfig; raw: Record<string, any> | null } | null>;
  notify: (title: string, body: string, priority: string, opts?: { email?: boolean }) => Promise<void>;
  /** writes.ts withDeviceLock — serialises the re-read → record with the planner's own PATCH → record. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface DriftOutcome {
  kind: "seeded" | "unchanged" | "config_drift" | "curve";
  /** The config now on record (the re-read's when one was taken) — what the rest of the poll should use. */
  config: HbxConfig;
  /** The device object `config` came from. */
  device: Record<string, any>;
  /** Changes recorded (null when nothing changed for good). */
  changes: Record<string, FieldChange> | null;
  diagnosis: CurveDiagnosis | null;
}

const curveChanged = (c: Record<string, FieldChange> | null): boolean => !!c && ("dbt" in c || "mbt" in c);
const fmtChanges = (c: Record<string, FieldChange>): string =>
  Object.entries(c).map(([k, v]) => `${k}: ${v.old} -> ${v.new}`).join("\n");
const fmtMeta = (m: Record<string, unknown>): string =>
  Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ") : "(none in object)";
const fmtWrite = (w: PlannerWrite | null): string => {
  if (!w) return "none on record";
  const req = w.requested ? Object.entries(w.requested).map(([k, v]) => `${k} ${v}`).join(" / ") : "—";
  const echo = w.echo ? Object.entries(w.echo).map(([k, v]) => `${k} ${v}`).join(" / ") : "not recorded";
  return `${w.at} ${w.source}:${w.action} requested ${req}; PATCH echo ${echo}`;
};

/** The evidence block both curve pages carry — enough to tell an echo from a writer without opening the DB. */
export function diagnosisBody(d: CurveDiagnosis): string {
  const reread = d.reread_confirmed === true ? `confirmed at ${d.reread_at}`
    : d.reread_confirmed === false ? `REVERTED at ${d.reread_at}`
    : `not taken (${d.reread_error ?? "unknown"})`;
  const matches = d.matches.map((m) => m.written === null
    ? `${m.field} ${m.value}: no planner write of ${m.field} in the last 60 min`
    : `${m.field} ${m.value}: planner wrote ${m.written} at ${m.written_at} (Δ ${m.delta_f} °F)`).join("\n");
  return [
    `Changed (recorded → device):\n${fmtChanges(d.fields)}`,
    `First read ${d.first_read_at}; re-read after ${REREAD_DELAY_MS / 1000} s: ${reread}`,
    `Nearest planner-written values (±${ECHO_TOLERANCE_F} °F = echo):\n${matches}`,
    `Planner's last write: ${fmtWrite(d.planner_last_write)}`,
    `Device metadata before: ${fmtMeta(d.device_before)}`,
    `Device metadata after:  ${fmtMeta(d.device_after)}`,
    `Verdict: ${d.verdict}. Raw device objects: hbx_config_versions.raw / reread_raw (#177).`,
  ].join("\n\n");
}

export const ECHO_TITLE = "HBX curve differs from our write (possible device/cloud transform)";
export const FOREIGN_TITLE = "⚠ Foreign HBX curve write — single-writer invariant";

/**
 * The drift detector's whole decision for one poll: seed, record a non-curve drift, or — on a dbt/mbt diff —
 * re-read after REREAD_DELAY_MS, page only if the change persists, and say whether it looks like an echo of the
 * planner's own write (default page, no single-writer claim) or a foreign writer (today's high page). Every curve
 * event records a row with both reads, even one that reverted (changed_fields null then, so the mirror's drift
 * badge and the TempIQ window closer — which read changed_fields — never count a transient as a curve change).
 */
export async function handlePolledConfig(
  prev: { config: HbxConfig; raw: Record<string, any> | null } | null,
  dev: Record<string, any>,
  deps: DriftDeps,
): Promise<DriftOutcome> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const config = extractConfig(dev);
  const lock = deps.lock ?? (<T>(fn: () => Promise<T>) => fn());
  // Every baseline-changing record happens under the device lock, after re-checking that no planner write has
  // self-recorded a newer version since this poll read `prev` (codex pass 2: an unlocked insert of a stale
  // observation would make it the latest config again over our own write). A moved baseline means this poll's
  // observation is already history — record nothing; the next poll diffs against the new baseline.
  const baselineMoved = async (): Promise<boolean> => {
    if (!deps.latest) return false;
    const cur = await deps.latest();
    return JSON.stringify(cur?.config ?? null) !== JSON.stringify(prev?.config ?? null);
  };
  const stale: DriftOutcome = { kind: "unchanged", config, device: dev, changes: null, diagnosis: null };
  if (prev === null) {
    const seeded = await lock(async () => {
      if (await baselineMoved()) return false;
      await deps.record({ config, changes: null, raw: dev });
      return true;
    });
    return seeded ? { kind: "seeded", config, device: dev, changes: null, diagnosis: null } : stale;
  }
  const changes = diffConfig(prev.config, config);
  if (!changes) return { kind: "unchanged", config, device: dev, changes: null, diagnosis: null };

  if (!curveChanged(changes)) {
    const recorded = await lock(async () => {
      if (await baselineMoved()) return false;
      await deps.record({ config, changes, raw: dev });
      return true;
    });
    if (!recorded) { log("HBX config drift seen, but a planner write moved the baseline meanwhile — re-checked next poll"); return stale; }
    const summary = fmtChanges(changes);
    log(`HBX CONFIG DRIFT (outside the planner):\n${summary}`);
    // ~0.98/day of foreign edits — genuine drift signal, but it belongs in the versioned
    // history and the /hbx page, not in a daily email that would dilute the warn tier.
    await deps.notify("HBX config changed (outside the planner)", summary, "high", { email: false });
    return { kind: "config_drift", config, device: dev, changes, diagnosis: null };
  }

  const firstAtMs = now();
  const lookupWrites = async (atMs: number): Promise<{ last: PlannerWrite | null; recent: PlannerWrite[] }> => {
    try { return await deps.plannerWrites(atMs - ECHO_WINDOW_MS); }
    catch (e) { log(`planner-write lookup failed (verdict defaults to foreign): ${(e as Error).message}`); return { last: null, recent: [] }; }
  };
  const diagnose = (
    o: { fields: Record<string, FieldChange>; verdict: CurveDiagnosis["verdict"]; confirmed: boolean | null; rereadAt: string | null;
         rereadError: string | null; baselineMoved: boolean; writes: { last: PlannerWrite | null; recent: PlannerWrite[] };
         matches: EchoMatch[]; before: Record<string, any> | null; after: Record<string, any> },
  ): CurveDiagnosis => ({
    at: new Date(firstAtMs).toISOString(),
    fields: o.fields,
    verdict: o.verdict,
    reread_confirmed: o.confirmed,
    reread_at: o.rereadAt,
    reread_error: o.rereadError,
    baseline_moved: o.baselineMoved,
    first_read_at: new Date(firstAtMs).toISOString(),
    planner_last_write: o.writes.last,
    planner_writes_60m: o.writes.recent,
    matches: o.matches,
    device_before: deviceMeta(o.before),
    device_after: deviceMeta(o.after),
    paged: o.verdict === "foreign" ? "high" : o.verdict === "echo_suspected" ? "default" : null,
  });
  // No confirmation read (it failed, or SIGTERM cut the wait / the read short): NOTHING is recorded and nobody is
  // paged — the change has not been shown to persist (#177), and recording the first read would advance the
  // baseline over whatever a planner write may have put there meanwhile (codex pass 1). latestConfig() stays put, so
  // the next poll (or the successor's first poll) sees the same diff and runs the whole check again.
  const unconfirmed = async (why: string): Promise<DriftOutcome> => {
    const writes = await lookupWrites(firstAtMs);
    const diagnosis = diagnose({
      fields: changes, verdict: "unconfirmed", confirmed: null, rereadAt: null, rereadError: why, baselineMoved: false, writes,
      matches: curveVerdict(changes, writes.recent, firstAtMs)?.matches ?? [], before: prev.raw, after: dev,
    });
    log(`HBX curve change seen but not confirmed (${why}) — not recorded, not paged; the next poll re-checks:\n${fmtChanges(changes)}`);
    return { kind: "curve", config, device: dev, changes: null, diagnosis };
  };
  if (!(await deps.wait(REREAD_DELAY_MS))) return unconfirmed("re-read skipped: planner shutting down");

  // Re-read → baseline → verdict → record, all under the device lock (writes.ts withDeviceLock): no planner write can
  // land between the confirmation read and the row, so the read is judged against every write that has completed.
  type Locked = { unconfirmed: string } | { diagnosis: CurveDiagnosis; finalDev: Record<string, any>; finalConfig: HbxConfig; finalChanges: Record<string, FieldChange> | null };
  const locked: Locked = await lock(async (): Promise<Locked> => {
    let reread: Record<string, any>;
    try { reread = await deps.reread(); }
    catch (e) { return { unconfirmed: `re-read failed: ${(e as Error).message}` }; }
    const rereadAtMs = now();
    const rereadAt = new Date(rereadAtMs).toISOString();
    // A planner write may have self-recorded a version during the wait: judge the re-read against THAT.
    let base = prev;
    if (deps.latest) {
      try { base = (await deps.latest()) ?? prev; }
      catch (e) { return { unconfirmed: `latest-version re-fetch failed: ${(e as Error).message}` }; }
    }
    const moved = JSON.stringify(base.config) !== JSON.stringify(prev.config);
    const finalConfig = extractConfig(reread);
    const finalChanges = diffConfig(base.config, finalConfig);
    const confirmed = curveChanged(finalChanges);
    // The standing change is the RE-READ's, so the echo window ends at the re-read: a planner write that landed
    // during the wait counts as ours (codex pass 2 — anchored at the first read, a 1 °F transform of a write made
    // during the 30 s would have paged high as foreign).
    const writes = await lookupWrites(rereadAtMs);
    // A reverted curve keeps the first read's change in the diagnosis but is not a curve event.
    const fields = confirmed ? (finalChanges as Record<string, FieldChange>) : changes;
    const v = curveVerdict(fields, writes.recent, confirmed ? rereadAtMs : firstAtMs);
    const verdict: CurveDiagnosis["verdict"] = confirmed ? (v?.verdict ?? "foreign") : "reverted";
    const diagnosis = diagnose({
      fields, verdict, confirmed, rereadAt, rereadError: null, baselineMoved: moved, writes, matches: v?.matches ?? [],
      before: base.raw, after: reread,
    });
    await deps.record({ config: finalConfig, changes: finalChanges, raw: dev, rereadRaw: reread, verdict: verdict as ConfigVersionRecord["verdict"], diagnosis });
    return { diagnosis, finalDev: reread, finalConfig, finalChanges };
  });
  if ("unconfirmed" in locked) return unconfirmed(locked.unconfirmed);
  const { diagnosis, finalDev, finalConfig, finalChanges } = locked;
  const verdict = diagnosis.verdict;

  if (verdict === "reverted") {
    // The change did not persist — a stale/transient cloud read (or superseded by our own write), not a writer.
    // Both reads are recorded; nobody is paged. A NON-curve field that did change for good is still drift.
    log(`HBX curve change reverted on re-read (transient, not paged):\n${fmtChanges(changes)}`);
    if (finalChanges) await deps.notify("HBX config changed (outside the planner)", fmtChanges(finalChanges), "high", { email: false });
    return { kind: "curve", config: finalConfig, device: finalDev, changes: finalChanges, diagnosis };
  }

  const evidence = diagnosisBody(diagnosis);
  if (verdict === "echo_suspected") {
    log(`HBX curve differs from our write — echo suspected (#177):\n${fmtChanges(diagnosis.fields)}`);
    await deps.notify(
      ECHO_TITLE,
      `The reset curve on the device no longer matches the planner's last write, but every changed field is within ` +
        `${ECHO_TOLERANCE_F} °F of a value the planner itself wrote in the last 60 min — the signature of the device or ` +
        `the SensorLinx cloud echoing/transforming an earlier planner write, not of a second writer.\n\n${evidence}`,
      "default",
      { email: true }, // the email IS the evidence (#177 acceptance)
    );
  } else {
    log(`FOREIGN HBX CURVE WRITE — single-writer violation:\n${fmtChanges(diagnosis.fields)}`);
    // A foreign change to the reset curve (dbt/mbt) — the exact target the autopilot manages
    // — is a single-writer-invariant VIOLATION: someone wrote the HBX outside the guarded
    // path (a direct-to-SensorLinx script or a second planner instance). Name it loudly so
    // it's actioned, not mistaken for a benign schedule tweak. See README §Single-writer, #36.
    await deps.notify(
      FOREIGN_TITLE,
      `A writer OTHER than the planner moved the reset curve, bypassing I4/I1/rate-limit/audit:\n${fmtChanges(diagnosis.fields)}\n\nThe deployed a2w-planner must be the SOLE HBX writer — retire any direct-to-SensorLinx script or parallel instance (README §Single-writer invariant, #36).\n\n${evidence}`,
      "high",
    );
  }
  return { kind: "curve", config: finalConfig, device: finalDev, changes: finalChanges, diagnosis };
}
