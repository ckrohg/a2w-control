// @purpose Pure state mapping for the Home "backup element" line (#184). The last heat tier is the
// 16.5 kW element on SPAN circuit "Buffer Tank"; whether it CAN fire is the circuit's relay
// (span_arm_state.relay_state, mirrored from the bridge's SPAN local poller: "OPEN" = breaker off,
// "CLOSED" = available). Whether the HBX ASKED for it is slx_readings.backup_called. Those are two
// different facts and the card shows them as two lines; neither ever renders a ✓. No "@/" imports so
// scripts/test-*.ts can run it under tsx.

/** SPAN data older than this is reported as unknown, with its age, instead of as a state. */
export const SPAN_STALE_S = 15 * 60;
/** A "Buffer Tank" draw above this proves the relay is closed even when the relay row is stale. */
const DRAWING_W = 500;

export type BackupInputs = {
  nowS: number;
  /** span_arm_state row (single row, id = 1). ts = the Pi's sample time, unix seconds. */
  relay: { relay_state: string | null; ts: number | null } | null;
  /** newest span_readings row for "Buffer Tank" (power only, no relay state). */
  latestPower: { ts: number; power_w: number | null } | null;
  episodes7d: number;
  lastCalled: number | null;
  calledNow: boolean;
};

export type BackupView = {
  tone: "red" | "amber" | "unknown";
  chip: string;
  headline: string;
  /** the separate 7-day HBX-called line */
  calledLine: string;
};

/** The Pi stamps seconds; tolerate a millisecond stamp rather than call it 55 years stale. */
const asSeconds = (t: number) => (t > 1e12 ? t / 1000 : t);

function fmtWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

export function backupView(i: BackupInputs): BackupView {
  const relayTs = i.relay?.ts != null ? asSeconds(i.relay.ts) : null;
  const relayAge = relayTs != null ? i.nowS - relayTs : null;
  const powerTs = i.latestPower ? asSeconds(i.latestPower.ts) : null;
  const powerAge = powerTs != null ? i.nowS - powerTs : null;
  const relayFresh = relayAge != null && relayAge <= SPAN_STALE_S;
  const drawingFresh = powerAge != null && powerAge <= SPAN_STALE_S && (i.latestPower?.power_w ?? 0) > DRAWING_W;

  let state: "OPEN" | "CLOSED" | null = null;
  let why = "";
  const rs = i.relay?.relay_state?.toUpperCase() ?? null;
  if (relayFresh && (rs === "OPEN" || rs === "CLOSED")) state = rs;
  else if (drawingFresh) { state = "CLOSED"; why = ` (element drawing ${Math.round(i.latestPower!.power_w!)} W)`; }

  const n = i.episodes7d;
  const last = i.lastCalled != null ? ` · last ${fmtWhen(i.lastCalled)}` : "";

  if (state === "OPEN") {
    return {
      tone: "red",
      chip: "backup unavailable",
      headline: "Backup unavailable — element breaker OPEN. The 16.5 kW element cannot fire even if the HBX calls it.",
      calledLine: i.calledNow
        ? `HBX is calling the backup NOW and it cannot run · ${n}× in 7 d${last}`
        : `HBX would have called it ${n}× in 7 d${last}`,
    };
  }
  if (state === "CLOSED") {
    return {
      tone: "amber",
      chip: "backup available",
      headline: n === 0 && !i.calledNow
        ? `Backup available, not called in 7 d — element breaker CLOSED${why}.`
        : `Backup available — element breaker CLOSED${why}.`,
      calledLine: i.calledNow ? `HBX is calling the backup NOW · ${n}× in 7 d${last}` : `HBX called it ${n}× in 7 d${last}`,
    };
  }
  // unknown — say how old the newest SPAN data is (whichever source is newest)
  const ages = [relayAge, powerAge].filter((a): a is number => a != null);
  const newest = ages.length ? Math.min(...ages) : null;
  const ageTxt = newest == null ? "no SPAN data" : `SPAN data ${Math.max(0, Math.round(newest / 60))} min old`;
  const odd = relayFresh && rs != null ? `relay state "${i.relay!.relay_state}" not recognised` : ageTxt;
  return {
    tone: "unknown",
    chip: "backup unknown",
    headline: `Backup element state unknown (${odd}).`,
    calledLine: i.calledNow ? `HBX is calling the backup NOW · ${n}× in 7 d${last}` : `HBX called (or would have called) it ${n}× in 7 d${last}`,
  };
}
