/**
 * @purpose The single parsing seam from a raw SensorLinx ECO-0600 device object (api.sensorlinx.co) to the narrow
 * SlxReading every planner alarm and the Phase B command read: tank actual/target (temp1), outdoor (temp3), the hd/cd
 * demands by name, the per-stage call flags, the backup call, the relStat → relays bitmask (bit i = relay i+1) and
 * connected. Pure: anything absent maps to null — never 0, never a throw — so an upstream shape change reads as
 * "unknown", not as a plausible value. Pinned by slx-reading.test.ts.
 */

import type { SlxReading } from "./store";

export function toReading(dev: Record<string, any>, now: Date = new Date()): SlxReading {
  const demands: { name: string; activated: boolean }[] = dev.demands ?? [];
  const byName = (n: string) => demands.find((d) => d.name === n)?.activated ?? null;
  const relStat: number[] | undefined = dev.relStat;
  return {
    ts: now,
    tankF: dev.temps?.temp1?.actual ?? null,
    tankTargetF: dev.temps?.temp1?.target ?? null,
    outdoorF: dev.temps?.temp3?.actual ?? null,
    hdActive: byName("hd"),
    cdActive: byName("cd"),
    stagesCalled: Array.isArray(dev.stages)
      ? dev.stages.map((s: { activated?: boolean }) => s.activated === true)
      : null,
    backupCalled: dev.backup?.activated ?? null,
    relays: Array.isArray(relStat)
      ? relStat.reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0)
      : null,
    connected: dev.connected ?? null,
  };
}
