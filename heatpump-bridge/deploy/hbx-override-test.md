# HBX-override test — the last Phase 2 gate

**The question:** when the HBX's dry-contact heat call and a Modbus write disagree,
**who wins?** If the contact wins, no software bug can ever stop heat — the founding
guarantee holds unconditionally. If Modbus wins, the built guardrails (winter floor,
no unattended power-writes, lease revert) become load-bearing and must stay strict.

**Why a DHW call is the ideal window:** the pumps serve hot water year-round, so any
hot-water draw triggers a real call — and the worst case during a 5-minute test is
slightly cooler tap water, not a cold house. Run this attended, at the dashboard,
ideally within sight of the wall controller.

**Time required:** ~10 minutes. **Risk:** negligible (one power-off/on cycle, same as
the wall controller's own power button).

---

## Steps

1. **Trigger or wait for a heat call.** Run a hot tap for a few minutes if you don't
   want to wait. Watch the dashboard: the serving pump's card shows the **Comp 1** pill
   lighting up, **Power > 0 W**, and the state changing. **Note WHICH pump takes the
   call** (this reveals how demand is routed between the two units).

2. **Enable writes on that pump:** tap the **🔒 read-only** pill in its card footer →
   confirm **Enable writes** in the dialog. (Expect the ntfy alert — enabling is
   deliberately loud.)

3. **Write OFF while the call is active:** tap the **power button (⏻)** on the card →
   confirm. The bridge does the guarded write (identity → write → read-back). The card
   should reflect `on: false` within a poll (~20 s).

4. **Observe for 2–3 minutes** — dashboard card + wall controller:

   | What you see | Meaning |
   |---|---|
   | **Compressor keeps running** (Comp 1 lit, power > 0) despite `on: false` | **The heat call wins.** Best outcome: Modbus cannot defeat the HBX — no software failure can stop heat. Record it; Phase 2 unlocks with confidence. |
   | **Compressor stops** within the window | **Modbus wins.** A wrong write CAN hold heat off. Record it; the guardrails are now load-bearing: writes stay attended-only until the winter-safe floor + watchdog posture is finalized. |
   | Compressor stops but restarts on its own a few minutes later | Grey zone — the controller may re-assert the call cyclically. Note the timing; effectively "call wins, slowly." |

5. **Restore immediately:** tap **⏻ → on**. ⚠️ The compressor may wait several minutes
   to restart — that's **anti-short-cycle protection, normal**, not a fault (P17-class
   behavior). Confirm the card returns to its normal state and the wall controller looks
   ordinary.

6. **Back to read-only:** tap the **🔓 control on** pill (instant, no dialog).

7. **Record the result** below and in the journal. If hot water was being used, tell
   the household the ~5-minute lukewarm blip was science.

---

## Result — ANSWERED

- Date/time: 2026-07-13 (evening, DHW call window)
- Outcome: ☑ **Modbus wins** — a Modbus power-off written during an active heat call
  stops the compressor. Software CAN hold heat off while the HBX is calling.
- Consequence: the write guardrails are **load-bearing**, not belt-and-suspenders:
  the winter-safe floor (`unattended_min_setpoint_c`), attended-only power/mode writes
  (`restrict_unattended_writes`), and the optimizer lease-revert are the mechanisms that
  keep a wrong write from freezing the house. They stay strict, permanently.
- Details/measurements: recorded in subsequent session journals (see also the I1-margin
  work measuring HBX termination behavior).
