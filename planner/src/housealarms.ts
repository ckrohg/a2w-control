/**
 * @purpose The state logic of three house alarms, pure and clock-free so each edge can be tested: freeze risk, DHW
 * shortfall (both paged by housepages.ts) and the backup-element call (index.ts checkBackupCalled). Each evaluator takes
 * the previous state and this poll's reading and returns the next state plus the edge it crossed: 'open', 'clear' or
 * null. A null reading can't judge, so it changes nothing.
 *
 * Freeze risk has hysteresis (bug, 2026-11-04): it raised at outdoor ≤ 5 °F with the tank < 105 °F and cleared the moment
 * either crossed back, so an outdoor reading hovering between 5 and 6 °F on a design-cold night sent the URGENT page and
 * its all-clear (push and email) every 5-min poll — on the nights the owner most needs to trust it. Now it clears only
 * once outdoor > FREEZE_OUTDOOR_F + FREEZE_CLEAR_OUTDOOR_MARGIN_F or tank ≥ FREEZE_TANK_F + FREEZE_CLEAR_TANK_MARGIN_F.
 *
 * No I/O, no sends: the callers keep every title, tier, key and fact.
 */

export type AlarmAction = "open" | "clear" | null;
export interface AlarmStep<S> { state: S; action: AlarmAction }

// ── freeze risk ────────────────────────────────────────────────────────────────────────────────────────────────
export const FREEZE_OUTDOOR_F = 5;  // design-day outdoor
export const FREEZE_TANK_F = 105;   // buffer has fallen below the DHW-ready floor while it's this cold out
/**
 * The clear band above the raise thresholds. A conservative default, NOT an owner decision yet: the owner should review
 * it. Wide enough that sensor jitter and a slow overnight drift around 5 °F can't flap the page; narrow enough that a
 * real recovery (a sunny morning, the pumps catching the tank back up) clears it within an hour or so.
 */
export const FREEZE_CLEAR_OUTDOOR_MARGIN_F = 3; // clears once outdoor > 8 °F
export const FREEZE_CLEAR_TANK_MARGIN_F = 5;    // ...or the tank ≥ 110 °F

export interface FreezeState { open: boolean }
export const FREEZE_INITIAL: FreezeState = { open: false };

export function evalFreezeRisk(prev: FreezeState, r: { outdoorF: number | null; tankF: number | null }): AlarmStep<FreezeState> {
  const { outdoorF, tankF } = r;
  if (outdoorF == null || tankF == null) return { state: prev, action: null };
  if (!prev.open) {
    return outdoorF <= FREEZE_OUTDOOR_F && tankF < FREEZE_TANK_F ? { state: { open: true }, action: "open" } : { state: prev, action: null };
  }
  const clear = outdoorF > FREEZE_OUTDOOR_F + FREEZE_CLEAR_OUTDOOR_MARGIN_F || tankF >= FREEZE_TANK_F + FREEZE_CLEAR_TANK_MARGIN_F;
  return clear ? { state: { open: false }, action: "clear" } : { state: prev, action: null };
}

// ── DHW shortfall ──────────────────────────────────────────────────────────────────────────────────────────────
export const DHW_SHORTFALL_F = 113;   // below the 45 °C unattended floor → clearly cold for delivery (normal cycle bottoms ~117°F)
export const DHW_SHORTFALL_POLLS = 12; // ~60 min sustained at the 5-min poll — a draw dip recovers well inside that (alert-policy.md)

/** streak: consecutive polls below DHW_SHORTFALL_F (0 = the last judged reading was at or above it) */
export interface DhwState { streak: number; open: boolean }
export const DHW_INITIAL: DhwState = { streak: 0, open: false };

export function evalDhwShortfall(prev: DhwState, tankF: number | null): AlarmStep<DhwState> {
  if (tankF == null) return { state: prev, action: null };
  if (tankF >= DHW_SHORTFALL_F) return { state: { streak: 0, open: false }, action: prev.open ? "clear" : null };
  const streak = prev.streak + 1;
  const open = streak >= DHW_SHORTFALL_POLLS;
  return { state: { streak, open }, action: open && !prev.open ? "open" : null };
}

// ── backup element called ──────────────────────────────────────────────────────────────────────────────────────
export interface BackupState { called: boolean }
export const BACKUP_INITIAL: BackupState = { called: false };

export function evalBackupCalled(prev: BackupState, called: boolean | null): AlarmStep<BackupState> {
  if (called === true && !prev.called) return { state: { called: true }, action: "open" };
  if (called === false && prev.called) return { state: { called: false }, action: "clear" };
  return { state: prev, action: null };
}
