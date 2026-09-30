/**
 * @purpose gtm#1616 / #137: assertions for the identification driver. a2w-control has no JS test
 * runner (CI = tsc build + this assertion loop), so run with: npx tsx planner/src/identify.test.ts —
 * exits non-zero on failure. Pinned here: the pure decision rules (which cell, the draw, the target
 * inside the actuator's bounds, when to abort) and the state machine against fakes (idle → hold /
 * arming → active → ended, the auto-pilot hold, Phase B lead, the rate-limit retry, the abort
 * restore, and that a shadow window never writes or posts).
 */
import assert from "node:assert/strict";
import {
  pickCell, drawArm, probeTarget, abortReason, deficitZones, planConflictAhead, windowPayload, probeSource, cleanupSource,
  IdentificationDriver, type IdentPlan, type PlanCell, type IdentWindow, type IdentStore, type IdentDeps, currentPlanTargetF } from "./identify";
import { WriteError } from "./writes";

const T0 = new Date("2026-11-20T12:00:00Z");
const cell = (over: Partial<PlanCell> & { band: [number, number] }, sug: Partial<NonNullable<PlanCell["suggest"]>> = {}): PlanCell => ({
  zoneId: "z-lr", zoneName: "Living Room Baseboard", deliveryType: "baseboard", deliveryTypeSource: "owner_verified", status: "unidentified",
  suggest: { direction: "up", magnitudeF: 8, durationMin: 120, assignmentProbability: 0.5, informationGain: 0.5, baseAwtF: 135, aboveEverydayCap: true, forecastComplete: true, safeToProbe: { ok: true, binding: null }, ...sug },
  ...over,
});

async function main(): Promise<void> {
  // ── pickCell ──
  {
    const plan: IdentPlan = { generatedAt: T0.toISOString(), cells: [
      cell({ band: [30, 45] }, { informationGain: 0.4 }),
      cell({ band: [30, 45], zoneId: "z-mud", zoneName: "Mud Room", deliveryType: "radiant_floor" }, { informationGain: 0.9, direction: "up", baseAwtF: 120, aboveEverydayCap: false }),
      cell({ band: [45, 60] }, { informationGain: 1.0 }),                                   // wrong band
      cell({ band: [30, 45], zoneId: "z-x", deliveryTypeSource: "seeded" }, { informationGain: 2 }), // not owner-verified
      cell({ band: [30, 45], zoneId: "z-y" }, { informationGain: 2, safeToProbe: { ok: false, binding: "envelope_unlearned" } }), // unsafe
      cell({ band: [30, 45], zoneId: "z-z", status: "identified" }, { informationGain: 2 }),
      cell({ band: [30, 45], zoneId: "z-d" }, { informationGain: 3, direction: "down", forecastComplete: false }), // down needs a complete forecast
    ] };
    assert.equal(pickCell(plan, 40)!.zoneId, "z-mud", "top gain among eligible, in-band cells");
    assert.equal(pickCell(plan, 50)!.band[0], 45);
    assert.equal(pickCell(plan, 10), null);
  }
  // ── drawArm ──
  {
    assert.deepEqual(drawArm(0.5, () => 0.2), { arm: "probe", seed: "0.200000" });
    assert.deepEqual(drawArm(0.5, () => 0.7), { arm: "hold", seed: "0.700000" });
    assert.equal(drawArm(0.5, () => 0.5).arm, "hold"); // u < p is the probe
    const draws = Array.from({ length: 200 }, () => drawArm(0.5).arm);
    const probes = draws.filter((a) => a === "probe").length;
    assert.ok(probes > 60 && probes < 140, `the real RNG is fair-ish: ${probes}/200`);
  }
  // ── probeTarget: the actuator's bounds ──
  {
    const B = { dhwFloorF: 120, strictCapF: 135, identificationCapF: 145 };
    assert.deepEqual(probeTarget({ direction: "up", baseF: 135, magnitudeF: 8, aboveEverydayCap: true, ...B }), { targetF: 143, capF: 145, stepF: 8 });
    assert.deepEqual(probeTarget({ direction: "up", baseF: 140, magnitudeF: 8, aboveEverydayCap: true, ...B }), { targetF: 145, capF: 145, stepF: 5 }); // trimmed to the identification cap
    assert.equal(probeTarget({ direction: "up", baseF: 143, magnitudeF: 8, aboveEverydayCap: true, ...B }), null);                                    // < 3 °F of room
    assert.deepEqual(probeTarget({ direction: "up", baseF: 128, magnitudeF: 8, aboveEverydayCap: false, ...B }), { targetF: 135, capF: 135, stepF: 7 }); // everyday cap when not flagged
    assert.deepEqual(probeTarget({ direction: "up", baseF: 120, magnitudeF: 8, aboveEverydayCap: false, ...B }), { targetF: 128, capF: 135, stepF: 8 });
    assert.deepEqual(probeTarget({ direction: "down", baseF: 130, magnitudeF: 8, aboveEverydayCap: false, ...B }), { targetF: 122, capF: 135, stepF: 8 });
    assert.deepEqual(probeTarget({ direction: "down", baseF: 124, magnitudeF: 8, aboveEverydayCap: false, ...B }), { targetF: 120, capF: 135, stepF: 4 }); // clamped at the DHW floor
    assert.equal(probeTarget({ direction: "down", baseF: 122, magnitudeF: 8, aboveEverydayCap: false, ...B }), null);                                  // floor leaves < 3 °F
  }
  // ── abortReason ──
  {
    const ok = { arm: "probe" as const, direction: "down" as const, i1Violated: false, slxFresh: true, hubOnline: true, stormActive: false, boostActive: false, deficitZones: [] as string[], dhwDrawDetected: false };
    assert.equal(abortReason(ok), null);
    assert.equal(abortReason({ ...ok, i1Violated: true }), "i1_violated");
    assert.equal(abortReason({ ...ok, slxFresh: false }), "slx_stale");
    assert.equal(abortReason({ ...ok, hubOnline: false }), "hub_offline");
    assert.equal(abortReason({ ...ok, stormActive: true }), "storm_active");
    assert.equal(abortReason({ ...ok, boostActive: true }), "boost_active");
    assert.equal(abortReason({ ...ok, deficitZones: ["z-lr"] }), "room_deficit:z-lr");
    assert.equal(abortReason({ ...ok, dhwDrawDetected: true }), "dhw_draw");
    // an UP probe or a HOLD ignores room deficit / draws (hotter is never the hazard; a hold is the base)
    assert.equal(abortReason({ ...ok, direction: "up", deficitZones: ["z-lr"], dhwDrawDetected: true }), null);
    assert.equal(abortReason({ ...ok, arm: "hold", deficitZones: ["z-lr"], dhwDrawDetected: true }), null);
  }
  // ── deficitZones / planConflictAhead ──
  {
    const zones: any[] = [
      { id: "a", roomF: 66.5, setpointF: 68 }, { id: "b", roomF: 67.5, setpointF: 68 }, { id: "c", roomF: null, setpointF: 68 }, { id: "d", roomF: 60, setpointF: 68 },
    ];
    assert.deepEqual(deficitZones(zones, ["a", "b", "c"]), ["a"]);
    const plan = [
      { ts: new Date(T0.getTime() + 1 * 3600_000).toISOString(), reason: "DHW window floor" },
      { ts: new Date(T0.getTime() + 2 * 3600_000).toISOString(), reason: "daily sanitize to 140°F", sani: true },
    ];
    assert.equal(planConflictAhead(plan, T0.getTime(), 3), true);
    assert.equal(planConflictAhead(plan, T0.getTime(), 1.5), false);
    assert.equal(planConflictAhead(null, T0.getTime(), 3), false);
  }
  // ── windowPayload ──
  {
    const w: IdentWindow = {
      id: 7, createdAt: T0, state: "active", arm: "probe", direction: "up", zoneIds: ["z-lr", "z-mud"], bandLo: 30, bandHi: 45, magnitudeF: 8, baseF: 135, targetF: 143, capF: 145,
      drawProbability: 0.5, drawSeed: "0.2", startedAt: T0, endedAt: null, endReason: null, durationMin: 120, writeId: 11, writeAccepted: true, dryRun: false,
      postedOpen: false, postedClosed: false, cell: { x: 1 }, safeToProbe: { ok: true }, armingTicks: 0, writeAttempts: 1,
      cleanupState: "none", cleanupDetail: null, cleanupAttempts: 0,
    };
    const open = windowPayload(w, null);
    assert.equal(open.externalId, "a2w-ident-7");
    assert.equal(open.kind, "awt_identification");
    assert.deepEqual(open.assignment, { arm: "up", magnitudeF: 8, drawnWithProbability: 0.5, seed: "0.2" });
    assert.equal(open.endedAt, null);
    assert.equal(open.commandedTargetF, 143);
    assert.deepEqual(open.zoneIds, ["z-lr", "z-mud"]);
    const closed = windowPayload({ ...w, arm: "hold", endedAt: new Date(T0.getTime() + 7200_000) }, { achievedAwtF: 141.26, compliance: 0.9126, outdoorLowF: 38, outdoorHighF: 41 });
    assert.equal((closed.assignment as any).arm, "hold");
    assert.equal(closed.achievedAwtF, 141.3);
    assert.equal(closed.compliance, 0.913);
    assert.equal(typeof closed.endedAt, "string");
  }

  // ── the driver against fakes ──
  type Post = { url: string; body: any };
  function harness(over: { plan?: IdentPlan; rng?: () => number; mode?: "off" | "shadow" | "armed"; commanded?: number | null; operative?: number | null; adoptionPending?: boolean; autopilotDryRun?: boolean; pumpsCoverF?: number; i1?: boolean; zones?: any[]; slxAgeMs?: number; outdoorF?: number; lastEnd?: Date | null; writeFails?: Array<number | null>; restoreFails?: number; acceptedFor?: Record<string, { id: number; ts: Date; targetF: number | null }>; planBlocks?: any[]; seedRows?: IdentWindow[]; statusFailsAfterWrite?: boolean; liveCommanded?: () => Promise<number | null> }) {
    const rows: IdentWindow[] = [...(over.seedRows ?? [])];
    const posts: Post[] = [];
    const writes: Array<{ targetF: number; source: string; capF: number }> = [];
    const restores: string[] = [];
    const holds: Array<{ until: Date | null; reason: string }> = [];
    const probeTargets: Array<number | null> = [];
    const notes: string[] = [];
    let clock = T0.getTime();
    const now = () => new Date(clock);
    const writeFails = [...(over.writeFails ?? [])];
    const store: IdentStore = {
      async getLatestSlx() { return { ts: new Date(clock - (over.slxAgeMs ?? 60_000)), tankF: 130, targetF: over.commanded ?? 135, outdoorF: over.outdoorF ?? 40 }; },
      async activeBoost() { return null; },
      async recentPlans() { return [{ computedAt: now(), plan: over.planBlocks ?? [] }]; },
      async getRecentSeries() { return []; },
      async openIdentificationWindow() { return rows.find((r) => r.state !== "ended") ?? null; },
      async lastIdentificationWindowEnd() { return over.lastEnd ?? null; },
      async insertIdentificationWindow(w) { const id = rows.length + 1; rows.push({ id, ...w }); return id; },
      async updateIdentificationWindow(id, patch) { Object.assign(rows.find((r) => r.id === id)!, patch); },
      async unpostedIdentificationWindows() { return rows.filter((r) => !r.dryRun && ((r.state === "ended" && !r.postedClosed) || (r.state === "active" && !r.postedOpen))); },
      async cleanupPendingIdentificationWindows() { return rows.filter((r) => r.state === "ended" && r.cleanupState === "pending"); },
      async acceptedWriteFor(source) {
        if (over.acceptedFor && source in over.acceptedFor) return over.acceptedFor[source];
        // after a successful fake write, the audit row for that source exists
        return writes.some((x) => x.source === source) ? { id: 99, ts: now(), targetF: writes.find((x) => x.source === source)!.targetF } : null;
      },
      async windowStats() { return { achievedAwtF: 140, compliance: 0.8, outdoorLowF: 38, outdoorHighF: 42, samples: 20 }; },
    };
    const deps: IdentDeps = {
      store,
      writer: {
        async setTarget(targetF: number, source: string, capF?: number) {
          const f = writeFails.shift();
          if (f != null) throw new WriteError(f, f === 429 ? "rate limited" : "rejected");
          writes.push({ targetF, source, capF: capF ?? 135 }); return { ok: true };
        },
        async restore(source: string) {
          if ((over.restoreFails ?? 0) > restores.filter((r) => r.startsWith("FAIL")).length) { restores.push("FAIL"); throw new WriteError(502, "SensorLinx write failed"); }
          restores.push(source); return { ok: true };
        },
        async status() {
          if (over.statusFailsAfterWrite && writes.length) throw new Error("SensorLinx unreachable");
          // the device commands the last ACCEPTED write when there was one, else the configured base
          const last = writes.at(-1);
          const c = last ? last.targetF : (over.commanded === undefined ? 135 : over.commanded);
          return { commanded_target_f: c, target_f: last ? last.targetF : (over.operative === undefined ? c : over.operative), adoption_pending: over.adoptionPending ?? false };
        },
      } as any,
      autopilot: { setHold: (until, reason) => { holds.push({ until, reason }); }, isDryRun: over.autopilotDryRun ?? false } as any,
      phaseB: { setProbeTarget: (t) => { probeTargets.push(t); } } as any,
      demandFeed: { zones: () => over.zones ?? [], refresh: async () => {}, isHealthy: () => true } as any,
      hub: { getState: async () => ({ pumps: [{ id: "pump1", online: true, setpoint_c: ((over.pumpsCoverF ?? 150) - 32) * 5 / 9 }] }) } as any,
      baseUrl: "https://tempiq.test", token: "tok",
      notify: async (t, b) => { notes.push(t); },
      isI1Violated: () => over.i1 ?? false,
      isStormActive: () => false,
      // the live device mirrors the last accepted write unless a test overrides it (a human moved the curve)
      liveCommandedTargetF: over.liveCommanded ?? (async () => {
        if (over.statusFailsAfterWrite && writes.length) throw new Error("SensorLinx unreachable");
        const last = writes.at(-1);
        return last ? last.targetF : (over.commanded === undefined ? 135 : over.commanded);
      }),
      fetchImpl: (async (url: any, init: any) => {
        const u = String(url);
        if (u.includes("/identification-plan")) return { ok: true, status: 200, json: async () => over.plan ?? { generatedAt: now().toISOString(), cells: [] } } as any;
        posts.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ upserted: 1, rejected: [] }) } as any;
      }) as any,
      rng: over.rng ?? (() => 0.2),
      now,
    };
    const driver = new IdentificationDriver(deps, over.mode ?? "armed");
    return { driver, rows, posts, writes, restores, holds, probeTargets, notes, advance: (min: number) => { clock += min * 60_000; } };
  }
  const upPlan: IdentPlan = { generatedAt: T0.toISOString(), cells: [cell({ band: [30, 45] })] };

  // 0. The base must be where the PLAN wants the plant (cold-day rehearsal finding): the driver ticks before
  //    the auto-pilot, so a freshly raised floor is not written yet — drawing would freeze the old target.
  {
    const blockNow = { ts: new Date(T0.getTime() - 20 * 60_000).toISOString(), outdoor_f: 38, tank_target_f: 132, hp1_setpoint_f: 137, reason: "binding zone: Living Room Baseboard needs 137°F" };
    const blockLater = { ts: new Date(T0.getTime() + 40 * 60_000).toISOString(), outdoor_f: 37, tank_target_f: 140, hp1_setpoint_f: 145, reason: "later" };
    assert.equal(currentPlanTargetF([blockLater, blockNow], T0.getTime()), 132, "the block in force is the newest one at or before now");
    assert.equal(currentPlanTargetF([], T0.getTime()), null);
    assert.equal(currentPlanTargetF(null, T0.getTime()), null);
    const unsettled = harness({ plan: upPlan, commanded: 128, operative: 128, planBlocks: [blockNow, blockLater] });
    await unsettled.driver.tick();
    assert.equal(unsettled.rows.length, 0, "no window while the plan (132) is above the plant (128)");
    assert.match(unsettled.driver.status().lastResult ?? "", /plan wants 132 °F but the plant is at 128 °F/);
    assert.equal(unsettled.holds.filter((h) => h.until != null).length, 0, "the auto-pilot is NOT held (only the routine hold-clear ran) — it must be free to write the floor");
    const settled = harness({ plan: upPlan, commanded: 132, operative: 132, planBlocks: [blockNow, blockLater] });
    await settled.driver.tick();
    assert.equal(settled.rows.length, 1, "once the plant sits at the plan target, the window opens");
    assert.equal(settled.rows[0].baseF, 132);
    const within = harness({ plan: upPlan, commanded: 130, operative: 130, planBlocks: [blockNow, blockLater] });
    await within.driver.tick();
    assert.equal(within.rows.length, 1, "a difference below MIN_STEP_F is settled enough (the auto-pilot would not write it either)");
  }
  const downPlan: IdentPlan = { generatedAt: T0.toISOString(), cells: [cell({ band: [30, 45] }, { direction: "down", baseAwtF: 130, aboveEverydayCap: false, magnitudeF: 6 })] };

  // 1. UP probe: arming (Phase B lead, autopilot held, no write) → active once setpoints cover → write with the identification cap → posted open.
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 130 }); // setpoints do NOT yet cover 143+4.5
    await h.driver.tick();
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].state, "arming");
    assert.equal(h.rows[0].targetF, 143);
    assert.equal(h.rows[0].capF, 145);
    assert.equal(h.probeTargets.at(-1), 143, "Phase B is told to lead (an idle tick first clears any stale probe target)");
    assert.ok(h.holds.at(-1)!.until && h.holds.at(-1)!.reason.includes("identification #1"), "auto-pilot held");
    assert.equal(h.writes.length, 0, "no write until the setpoints cover the target");
    assert.equal(h.posts.length, 0, "an arming window is not yet a window");
    // next tick, still not covered
    await h.driver.tick();
    assert.equal(h.rows[0].state, "arming");
    assert.equal(h.rows[0].armingTicks, 1, "the first tick opened the row; each later tick counts one arming attempt");
  }
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150 });
    await h.driver.tick();                 // arming
    await h.driver.tick();                 // covered → write
    assert.equal(h.rows[0].state, "active");
    assert.deepEqual(h.writes, [{ targetF: 143, source: "identification#1", capF: 145 }]);
    assert.equal(h.rows[0].writeId, 99);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].body.windows[0].externalId, "a2w-ident-1");
    assert.equal(h.posts[0].body.windows[0].endedAt, null);
    assert.equal(h.posts[0].body.windows[0].assignment.arm, "up");
    assert.equal(h.rows[0].postedOpen, true);
    assert.ok(h.notes.includes("Identification probe started"));
    // runs to completion → ended, Phase B released, hold released, posted closed with stats
    h.advance(121);
    await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].endReason, "completed");
    assert.equal(h.probeTargets.at(-1), null, "Phase B probe target cleared");
    assert.equal(h.holds.at(-1)!.until, null, "hold released");
    assert.equal(h.posts.length, 2);
    assert.equal(typeof h.posts[1].body.windows[0].endedAt, "string");
    assert.equal(h.posts[1].body.windows[0].achievedAwtF, 140);
    assert.equal(h.rows[0].postedClosed, true);
    // the driver returns the plant to its base ITSELF (codex critical): a guarded re-command of baseF
    assert.deepEqual(h.writes.at(-1), { targetF: 135, source: "identification-end#1", capF: 135 });
    assert.equal(h.rows[0].cleanupState, "done");
    assert.match(h.rows[0].cleanupDetail ?? "", /re-commanded base 135/);
    assert.equal(h.restores.length, 0, "the base re-command succeeded, so no as-found restore");
  }
  // 2. Arming times out after ARMING_MAX_TICKS without setpoint coverage.
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 130 });
    for (let i = 0; i < 5; i++) await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].endReason, "arming_timeout");
    assert.equal(h.writes.length, 0);
  }
  // 3. HOLD arm: active immediately, no write, auto-pilot held at the base, posted with arm 'hold'.
  {
    const h = harness({ plan: upPlan, commanded: 135, rng: () => 0.9 });
    await h.driver.tick();
    assert.equal(h.rows[0].arm, "hold");
    assert.equal(h.rows[0].state, "active");
    assert.equal(h.rows[0].targetF, 135);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.probeTargets.filter((t) => t != null), [], "Phase B is not involved in a hold");
    assert.equal(h.posts[0].body.windows[0].assignment.arm, "hold");
    assert.equal(h.posts[0].body.windows[0].commandedTargetF, 135);
  }
  // 4. DOWN probe: pending_write → written → active; a room deficit aborts it; the base re-command is
  //    rate-limited (inside 15 min of the probe write) so the as-found curve is RESTORED; close posted.
  {
    const h = harness({ plan: downPlan, commanded: 130, zones: [{ id: "z-lr", roomF: 66, setpointF: 68 }], writeFails: [null, 429] });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    assert.deepEqual(h.writes, [{ targetF: 124, source: "identification#1", capF: 135 }]);
    assert.equal(h.rows[0].zoneIds.includes("z-lr"), true);
    assert.equal(h.posts.length, 1, "posted open after the ACCEPTED write");
    h.advance(10);
    await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].endReason, "aborted:room_deficit:z-lr");
    assert.deepEqual(h.restores, ["identification-abort#1"]);
    assert.equal(h.rows[0].cleanupState, "done");
    assert.match(h.rows[0].cleanupDetail ?? "", /as-found curve restored/);
    assert.ok(h.notes.includes("Identification probe aborted"));
    assert.equal(h.posts.length, 2);
  }
  // 4b. Cleanup is DURABLE: a re-command that fails for a non-rate-limit reason stays pending and is retried on later ticks.
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, writeFails: [null, 503, null] });
    await h.driver.tick(); await h.driver.tick();          // arming → active
    h.advance(121);
    await h.driver.tick();                                  // completed; re-command fails 503 → pending
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].cleanupState, "pending");
    assert.match(h.rows[0].cleanupDetail ?? "", /re-command failed/);
    await h.driver.tick();                                  // cleanupPending retries → succeeds
    assert.equal(h.rows[0].cleanupState, "done");
    assert.deepEqual(h.writes.at(-1), { targetF: 135, source: "identification-end#1", capF: 135 });
  }
  // 5. Rate limit (codex high): a 429 keeps the row in pending_write — NOT posted, NOT active — and is
  //    retried on the next ticks; it becomes active (startedAt = acceptance) only once a write is accepted.
  {
    const h = harness({ plan: downPlan, commanded: 130, writeFails: [429, 429, null] });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "pending_write");
    assert.equal(h.writes.length, 0);
    assert.equal(h.posts.length, 0, "an unwritten arm is not evidence");
    assert.match(h.driver.status().lastResult ?? "", /rate-limited/);
    h.advance(5); await h.driver.tick();
    assert.equal(h.rows[0].state, "pending_write");
    assert.equal(h.rows[0].writeAttempts, 2);
    h.advance(5); await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    assert.equal(h.rows[0].startedAt!.getTime(), T0.getTime() + 10 * 60_000, "startedAt is the acceptance, not the draw");
    assert.deepEqual(h.writes, [{ targetF: 124, source: "identification#1", capF: 135 }]);
    assert.equal(h.posts.length, 1);
  }
  {
    const h = harness({ plan: downPlan, commanded: 130, writeFails: [429, 429, 429] });
    await h.driver.tick(); await h.driver.tick(); await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.match(h.rows[0].endReason ?? "", /^write_rejected:429/);
    assert.equal(h.posts.length, 0, "never written → never posted");
    assert.equal(h.rows[0].cleanupState, "none", "nothing was written, nothing to return");
    assert.equal(h.restores.length, 0);
  }
  // 5b. CRASH RECOVERY (codex pass 2, critical): a row left in pending_write whose write the device DID
  //     accept (an audit row exists since the draw) is promoted to active on restart — not retried, not
  //     ended as unwritten — and cleanup later returns the plant to base.
  {
    const seed: IdentWindow = {
      id: 1, createdAt: new Date(T0.getTime() - 5 * 60_000), state: "pending_write", arm: "probe", direction: "down", zoneIds: ["z-lr"], bandLo: 30, bandHi: 45,
      magnitudeF: 6, baseF: 130, targetF: 124, capF: 135, drawProbability: 0.5, drawSeed: "0.2", startedAt: new Date(T0.getTime() - 5 * 60_000), endedAt: null, endReason: null,
      durationMin: 120, writeId: null, writeAccepted: false, dryRun: false, postedOpen: false, postedClosed: false, cell: null, safeToProbe: null,
      armingTicks: 0, writeAttempts: 3, cleanupState: "none", cleanupDetail: null, cleanupAttempts: 0,
    };
    const h = harness({ plan: downPlan, commanded: 124, seedRows: [seed], acceptedFor: { "identification#1": { id: 77, ts: new Date(T0.getTime() - 4 * 60_000), targetF: 124 } } });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "active", "promoted, not retried");
    assert.equal(h.rows[0].writeId, 77);
    assert.equal(h.rows[0].writeAccepted, true);
    assert.equal(h.rows[0].startedAt!.getTime(), T0.getTime() - 4 * 60_000, "startedAt = the audit row's time");
    assert.equal(h.writes.length, 0, "no second write");
    assert.equal(h.posts.length, 1, "posted open on promotion");
    h.advance(130);
    await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].cleanupState, "done");
  }
  // 5c. …and with no audit row but the device already commanding the probe target, the commanded target reconciles it.
  {
    const seed: IdentWindow = {
      id: 1, createdAt: new Date(T0.getTime() - 5 * 60_000), state: "pending_write", arm: "probe", direction: "down", zoneIds: ["z-lr"], bandLo: 30, bandHi: 45,
      magnitudeF: 6, baseF: 130, targetF: 124, capF: 135, drawProbability: 0.5, drawSeed: "0.2", startedAt: null, endedAt: null, endReason: null,
      durationMin: 120, writeId: null, writeAccepted: false, dryRun: false, postedOpen: false, postedClosed: false, cell: null, safeToProbe: null,
      armingTicks: 0, writeAttempts: 1, cleanupState: "none", cleanupDetail: null, cleanupAttempts: 0,
    };
    const h = harness({ plan: downPlan, commanded: 124, seedRows: [seed] });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    assert.equal(h.rows[0].writeAccepted, true);
    assert.equal(h.rows[0].writeId, null, "no audit row is ours — none is attached");
    assert.equal(h.writes.length, 0);
  }
  // 5e. An UNRELATED accepted identification write (another window's token, or a ±1 °F neighbour) does NOT
  //     reconcile this window (codex pass 3, high): it retries its own write instead.
  {
    const seed: IdentWindow = {
      id: 2, createdAt: new Date(T0.getTime() - 5 * 60_000), state: "pending_write", arm: "probe", direction: "down", zoneIds: ["z-lr"], bandLo: 30, bandHi: 45,
      magnitudeF: 6, baseF: 130, targetF: 124, capF: 135, drawProbability: 0.5, drawSeed: "0.2", startedAt: null, endedAt: null, endReason: null,
      durationMin: 120, writeId: null, writeAccepted: false, dryRun: false, postedOpen: false, postedClosed: false, cell: null, safeToProbe: null,
      armingTicks: 0, writeAttempts: 1, cleanupState: "none", cleanupDetail: null, cleanupAttempts: 0,
    };
    const h = harness({ plan: downPlan, commanded: 130, seedRows: [seed], acceptedFor: {
      "identification#1": { id: 50, ts: new Date(T0.getTime() - 3 * 60_000), targetF: 125 }, // another window's write, 1 °F off
    } });
    await h.driver.tick();
    assert.deepEqual(h.writes, [{ targetF: 124, source: "identification#2", capF: 135 }], "wrote its own probe");
    assert.equal(h.rows[0].writeId, 99);
  }
  {
    assert.equal(probeSource(7), "identification#7");
    assert.equal(cleanupSource(7, true), "identification-abort#7");
    assert.equal(cleanupSource(7, false), "identification-end#7");
  }
  // 5d. A pending_write row with NO accepted write and a base still commanded simply retries (the normal path).
  {
    const seed: IdentWindow = {
      id: 1, createdAt: new Date(T0.getTime() - 5 * 60_000), state: "pending_write", arm: "probe", direction: "down", zoneIds: ["z-lr"], bandLo: 30, bandHi: 45,
      magnitudeF: 6, baseF: 130, targetF: 124, capF: 135, drawProbability: 0.5, drawSeed: "0.2", startedAt: null, endedAt: null, endReason: null,
      durationMin: 120, writeId: null, writeAccepted: false, dryRun: false, postedOpen: false, postedClosed: false, cell: null, safeToProbe: null,
      armingTicks: 0, writeAttempts: 1, cleanupState: "none", cleanupDetail: null, cleanupAttempts: 0,
    };
    const h = harness({ plan: downPlan, commanded: 130, seedRows: [seed] });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    assert.deepEqual(h.writes, [{ targetF: 124, source: "identification#1", capF: 135 }]);
  }
  // 4d. Cleanup is a NO-OP when the device no longer commands the probe target (a legacy/backfilled row, or
  //     something else already moved the plant) — codex pass 4.
  {
    const legacy: IdentWindow = {
      id: 1, createdAt: new Date(T0.getTime() - 300 * 60_000), state: "ended", arm: "probe", direction: "up", zoneIds: ["z-lr"], bandLo: 30, bandHi: 45,
      magnitudeF: 8, baseF: 135, targetF: 143, capF: 145, drawProbability: 0.5, drawSeed: "0.2", startedAt: new Date(T0.getTime() - 200 * 60_000),
      endedAt: new Date(T0.getTime() - 80 * 60_000), endReason: "completed", durationMin: 120, writeId: 40, writeAccepted: true, dryRun: false,
      postedOpen: true, postedClosed: true, cell: null, safeToProbe: null, armingTicks: 0, writeAttempts: 1, cleanupState: "pending", cleanupDetail: null, cleanupAttempts: 0,
    };
    const h = harness({ plan: upPlan, commanded: 135, seedRows: [legacy], lastEnd: new Date(T0.getTime() - 80 * 60_000) });
    await h.driver.tick();
    assert.equal(h.rows[0].cleanupState, "done");
    assert.match(h.rows[0].cleanupDetail ?? "", /no longer at the probe target/);
    assert.equal(h.writes.length, 0, "nothing re-commanded");
    assert.equal(h.restores.length, 0);
  }
  // 4f. Cleanup reads the LIVE device, not the planner's last recorded config (codex pass 7): a human moved the
  //     curve between polls → the live curve is not the probe target → cleanup is done with no write.
  {
    let liveNow = 143; // starts at the probe target
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, liveCommanded: async () => liveNow });
    await h.driver.tick(); await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    liveNow = 150; // a human wrote a hotter curve during the window
    h.advance(121);
    await h.driver.tick();
    assert.equal(h.rows[0].cleanupState, "done");
    assert.match(h.rows[0].cleanupDetail ?? "", /no longer at the probe target \(commanded 150/);
    assert.equal(h.writes.length, 1, "the human's curve is left alone");
    assert.equal(h.restores.length, 0);
  }
  // 4e. Cleanup FAILS CLOSED when the device's commanded target cannot be read (codex pass 6): a non-urgent
  //     cleanup stays pending with no write and no restore; an urgent abort still restores (hotter is safe).
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, statusFailsAfterWrite: true });
    await h.driver.tick(); await h.driver.tick();          // arming → active (the probe write)
    assert.equal(h.rows[0].state, "active");
    h.advance(121);
    await h.driver.tick();                                  // completed → cleanup cannot confirm → pending
    assert.equal(h.rows[0].state, "ended");
    assert.equal(h.rows[0].cleanupState, "pending");
    assert.match(h.rows[0].cleanupDetail ?? "", /live device curve unreadable/);
    assert.equal(h.writes.length, 1, "no re-command without confirmation");
    assert.equal(h.restores.length, 0, "no blind restore for a non-urgent cleanup");
    for (let i = 0; i < 3; i++) await h.driver.tick();
    assert.equal(h.rows[0].cleanupState, "pending", "keeps retrying rather than guessing");
  }
  {
    const h = harness({ plan: downPlan, commanded: 130, zones: [{ id: "z-lr", roomF: 66, setpointF: 68 }], statusFailsAfterWrite: true });
    await h.driver.tick();                                  // pending_write → written → active
    assert.equal(h.rows[0].state, "active");
    h.advance(10);
    await h.driver.tick();                                  // room deficit → urgent abort with status unavailable
    assert.equal(h.rows[0].endReason, "aborted:room_deficit:z-lr");
    assert.deepEqual(h.restores, ["identification-abort#1"], "urgent: the as-found restore does not depend on the saved base");
    assert.equal(h.rows[0].cleanupState, "done");
    assert.equal(h.writes.length, 1);
  }
  // 4c. Cleanup classification (codex pass 2, high): a PERMANENT guard rejection (422 envelope) falls back to
  //     the as-found restore immediately instead of retrying the impossible command forever…
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, writeFails: [null, 422] });
    await h.driver.tick(); await h.driver.tick();
    h.advance(121);
    await h.driver.tick();
    assert.equal(h.rows[0].cleanupState, "done");
    assert.deepEqual(h.restores, ["identification-end#1"]);
    assert.match(h.rows[0].cleanupDetail ?? "", /as-found curve restored/);
  }
  // …transient failures (5xx) are retried, but after CLEANUP_TRANSIENT_MAX the restore is used anyway…
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, writeFails: [null, 503, 503, 503, 503, 503, 503] });
    await h.driver.tick(); await h.driver.tick();
    h.advance(121);
    await h.driver.tick();                       // attempt 1 → transient, pending
    assert.equal(h.rows[0].cleanupState, "pending");
    for (let i = 0; i < 4; i++) await h.driver.tick();   // attempts 2–5 → still pending
    assert.equal(h.rows[0].cleanupState, "pending");
    assert.equal(h.rows[0].cleanupAttempts, 5);
    await h.driver.tick();                       // attempt 6 → permanent by count → restore
    assert.equal(h.rows[0].cleanupState, "done");
    assert.deepEqual(h.restores, ["identification-end#1"]);
  }
  // …and while ANY live probe is still unreturned, no new window opens.
  {
    const h = harness({ plan: upPlan, commanded: 135, pumpsCoverF: 150, writeFails: [null, 503, 503], restoreFails: 3, lastEnd: null });
    await h.driver.tick(); await h.driver.tick();
    h.advance(121);
    await h.driver.tick();
    assert.equal(h.rows[0].cleanupState, "pending");
    h.advance(120); // well past MIN_GAP
    await h.driver.tick();
    assert.equal(h.rows.length, 1, "no second window while #1 is unreturned");
    assert.match(h.driver.status().lastResult ?? "", /not yet returned to base/);
  }

  // 6. A non-429 rejection (I4 envelope 422) ends the window immediately, no restore (nothing was written).
  {
    const h = harness({ plan: downPlan, commanded: 130, writeFails: [422] });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "ended");
    assert.match(h.rows[0].endReason ?? "", /^write_rejected:422/);
    assert.equal(h.restores.length, 0);
  }
  // 7. SHADOW mode: decides and draws, records dry_run, never writes, never posts, never leads Phase B.
  {
    const h = harness({ plan: upPlan, commanded: 135, mode: "shadow" });
    await h.driver.tick(); await h.driver.tick();
    assert.equal(h.rows[0].dryRun, true);
    assert.equal(h.rows[0].state, "active");
    assert.equal(h.writes.length, 0);
    assert.equal(h.posts.length, 0);
    assert.deepEqual(h.probeTargets.filter((t) => t != null), []);
  }
  // 8. OFF mode: an open window is ended (mode_off) and nothing new starts; idle ticks release hold + Phase B.
  {
    const h = harness({ plan: upPlan, commanded: 135, mode: "armed", rng: () => 0.9 });
    await h.driver.tick();
    assert.equal(h.rows[0].state, "active");
    h.driver.setMode("off");
    await h.driver.tick();
    assert.equal(h.rows[0].endReason, "mode_off");
    await h.driver.tick();
    assert.equal(h.holds.at(-1)!.until, null);
    assert.equal(h.probeTargets.at(-1), null);
    assert.equal(h.driver.status().lastResult, "off");
  }
  // 9. Gating: I1 violated / stale SLX / recent window → idle with a reason; a step inside the bounds too small → idle.
  {
    assert.match((await (async () => { const h = harness({ plan: upPlan, i1: true }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /I1 violated/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, slxAgeMs: 30 * 60_000 }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /no fresh SensorLinx/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, lastEnd: new Date(T0.getTime() - 10 * 60_000) }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /until the next window/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, commanded: 144 }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /would be < 3/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, outdoorF: 55 }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /no safe cell/);
    // codex: the base must be the SETTLED operative target
    assert.match((await (async () => { const h = harness({ plan: upPlan, commanded: 135, operative: 128, adoptionPending: true }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /not yet adopted/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, commanded: 135, operative: 128 }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /disagree/);
    assert.match((await (async () => { const h = harness({ plan: upPlan, commanded: 135, operative: null }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /no operative tank target/);
    // codex: ARMED identification requires the auto-pilot live
    assert.match((await (async () => { const h = harness({ plan: upPlan, autopilotDryRun: true }); await h.driver.tick(); return h.driver.status().lastResult!; })()), /auto-pilot is in shadow/);
    // …but SHADOW identification does not
    {
      const h = harness({ plan: upPlan, autopilotDryRun: true, mode: "shadow" });
      await h.driver.tick();
      assert.equal(h.rows.length, 1);
      assert.equal(h.rows[0].dryRun, true);
    }
    // the base is the OPERATIVE target (settled), so a 2 °F commanded/operative gap uses the operative
    {
      const h = harness({ plan: upPlan, commanded: 135, operative: 133, pumpsCoverF: 150 });
      await h.driver.tick();
      assert.equal(h.rows[0].baseF, 133);
      assert.equal(h.rows[0].targetF, 141);
    }
  }
  // 10. The plan is fetched with the actuator's bounds as query knobs.
  {
    const seen: string[] = [];
    const h = harness({ plan: upPlan });
    (h.driver as any).fetchImpl = async (url: any, init: any) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => upPlan } as any; };
    await h.driver.tick();
    assert.ok(seen[0].includes("abortLatencyMin=35") && seen[0].includes("dhwFloorF=120") && seen[0].includes("plantCapF=135") && seen[0].includes("identificationCapF=145"), seen[0]);
  }
  console.log("identify.test.ts: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

// #135: a planned pre-boost within the look-ahead is a plan conflict, exactly like a bank.
(() => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const plan = [{ ts: "2026-11-20T13:00:00Z", reason: "pre-boost to 126°F for 17:00 window (sag p75 6.2°F over 11 draws; warmest lead hour, 44°F)" }];
  assert.equal(planConflictAhead(plan, now, 3), true, "pre-boost reason conflicts");
  assert.equal(planConflictAhead([{ ts: "2026-11-20T13:00:00Z", reason: "DHW window floor", boost: true }], now, 3), true, "the boost flag conflicts");
  assert.equal(planConflictAhead([{ ts: "2026-11-20T13:00:00Z", reason: "DHW window floor" }], now, 3), false);
  console.log("identify.test.ts (#135 pre-boost conflict): all assertions passed");
})();
