/**
 * @purpose Cold-day rehearsal assertions: read what the real planner wrote to the LOCAL DB and what the fake
 * upstreams received, and check the scenario's `expect` block. Prints a ledger first (so a failure is
 * legible), then fails loudly. Localhost only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../../planner/src/store";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.error("refusing: LOCAL_DATABASE_URL must point at localhost"); process.exit(2); }
const OUT = process.env.REHEARSAL_OUT!;
const scenario = JSON.parse(fs.readFileSync(process.env.REHEARSAL_SCENARIO!, "utf8"));
const expect_ = scenario.expect ?? {};
const shapedLive = process.env.REHEARSAL_SHAPED_CURVE_MODE === "live";
const fake = JSON.parse(fs.readFileSync(path.join(OUT, "fake-state.json"), "utf8"));
const requests = fs.readFileSync(path.join(OUT, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// Wave 3: what the planner WOULD have paged (ntfy logs the title when no topic is configured) and what it logged.
const runLogs = fs.readdirSync(OUT).filter((f) => /^planner-run\d+\.log$/.test(f)).sort().map((f) => fs.readFileSync(path.join(OUT, f), "utf8"));
const plannerLogs = runLogs.join("\n");
const pagesIn = (log: string) => log.split("\n").filter((l) => l.includes("[ntfy] (no topic)")).map((l) => l.replace(/^.*\[ntfy\] \(no topic\) /, ""));
const pages = pagesIn(plannerLogs);
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } }).pool;
const fToC = (f: number) => (f - 32) * 5 / 9;
/** The ECO-0600's tank target for a PATCHed curve at `outdoorF` (dot/wwsd from the scenario device unless patched). */
function curveOutputF(patch: Record<string, any>, outdoorF: number): number | null {
  const dot = Number(patch.dot ?? scenario.device.dot), wwsd = Number(patch.wwsd ?? scenario.device.wwsd), dbt = Number(patch.dbt), mbt = Number(patch.mbt);
  if (![dot, wwsd, dbt, mbt].every(Number.isFinite)) return null;
  if (outdoorF <= dot) return dbt; if (outdoorF >= wwsd) return mbt;
  return mbt + ((wwsd - outdoorF) / (wwsd - dot)) * (dbt - mbt);
}

const failures: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) failures.push(msg); console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`); };

async function main() {
  const plans = (await pool.query(`SELECT id, computed_at, plan, meta FROM shadow_plans ORDER BY computed_at DESC LIMIT 1`)).rows;
  const autopilot = (await pool.query(`SELECT * FROM autopilot_log ORDER BY ctid`)).rows;
  const writes = (await pool.query(`SELECT * FROM hbx_writes ORDER BY ctid`)).rows;
  const phaseB = (await pool.query(`SELECT * FROM phase_b_log ORDER BY ctid`)).rows;
  const ident = (await pool.query(`SELECT * FROM identification_windows ORDER BY ctid`)).rows;
  const windowPosts = (await pool.query(`SELECT * FROM tempiq_window_posts ORDER BY ctid`)).rows;
  const configVersions = (await pool.query(`SELECT * FROM hbx_config_versions ORDER BY ctid`)).rows;
  const boostRows = (await pool.query(`SELECT * FROM hbx_boosts ORDER BY id`)).rows;
  const readings = (await pool.query(`SELECT count(*)::int AS n FROM slx_readings`)).rows[0].n;

  console.log(`\n── ledger (${scenario.name}) ──────────────────────────────`);
  console.log(`slx_readings ${readings} · shadow_plans ${plans.length ? 1 : 0} · autopilot_log ${autopilot.length} · hbx_writes ${writes.length} · phase_b_log ${phaseB.length} · identification_windows ${ident.length} · tempiq_window_posts ${windowPosts.length} · hbx_config_versions ${configVersions.length} · hbx_boosts ${boostRows.length}`);
  const now = Date.now();
  const plan: any[] = plans[0]?.plan ?? [];
  const current = plan.filter((b) => new Date(b.ts).getTime() <= now).at(-1) ?? null;
  const next3h = plan.filter((b) => { const t = new Date(b.ts).getTime(); return t > now - 3600_000 && t <= now + 3 * 3600_000; });
  console.log(`plan: ${plan.length} blocks; meta.forecast_source=${plans[0]?.meta?.forecast_source}; current block: ${current ? `${current.ts} target ${current.tank_target_f}°F hp1 ${current.hp1_setpoint_f} — ${current.reason}` : "NONE"}`);
  for (const b of plan.slice(0, 8)) console.log(`   ${b.ts.slice(11, 16)}Z out ${b.outdoor_f}°F → ${b.tank_target_f}°F  ${b.sani ? "[sani] " : ""}${b.bank ? "[bank] " : ""}${b.boost ? "[boost] " : ""}${b.reason}`);
  for (const r of autopilot) console.log(`autopilot: ${r.result} target ${r.target_f}°F dry_run=${r.dry_run} — ${r.reason}`);
  for (const w of writes) console.log(`hbx_write: ${w.source} ${w.action} ${JSON.stringify(w.requested)} → ${w.result} ${w.detail ?? ""}`.slice(0, 220));
  for (const p of phaseB) console.log(`phase_b: ${p.pump_id} ${p.mode} ${p.value_c}°C → ${p.result}`);
  for (const w of ident) console.log(`identification: ${JSON.stringify(w).slice(0, 320)}`);
  for (const b of boostRows) console.log(`hbx_boost: #${b.id} ${b.target_f}°F restore_at ${new Date(b.restore_at).toISOString()} restored=${b.restored}`);
  for (const p of windowPosts.slice(0, 5)) console.log(`window_post: ${JSON.stringify(p).slice(0, 200)}`);
  console.log(`fake: ${fake.patches.length} PATCH(es) ${JSON.stringify(fake.patches.map((p: any) => p.body))} · ${fake.commands.length} hub command(s) ${JSON.stringify(fake.commands.map((c: any) => [c.body.pump_id, c.body.value_c, c.body.lease_minutes]))} · ${fake.posts.length} TempIQ POST(s) ${JSON.stringify(fake.posts.map((p: any) => p.path))}`);
  console.log(`fake device now: target ${fake.device.temps.temp1.target}°F curve dot ${fake.device.dot} wwsd ${fake.device.wwsd} dbt ${fake.device.dbt} mbt ${fake.device.mbt}`);
  const unhandled = requests.filter((r) => r.unhandled);
  if (unhandled.length) console.log(`UNHANDLED upstream calls: ${JSON.stringify(unhandled.map((u) => `${u.method} ${u.path}`))}`);
  const failed = requests.filter((r) => r.failed);
  if (failed.length) console.log(`SIMULATED upstream failures: ${failed.length} (${JSON.stringify([...new Set(failed.map((u) => `${u.method} ${u.path}`))])})`);
  if (pages.length) console.log(`would-have-paged: ${JSON.stringify(pages)}`);

  console.log(`\n── checks ─────────────────────────────────────────────────`);
  if (expect_.planMissingOk === true) {
    // a cold-start outage of the forecast leaves NO plan — the point of the scenario is what the planner does then
    check(plan.length === 0 || plan.length === 24, `either no plan (outage) or a complete one (got ${plan.length})`);
  } else {
    check(plan.length === 24, `the hourly plan has 24 blocks (got ${plan.length})`);
    check(current != null, `a current block exists for the poll to act on`);
  }
  if (expect_.forecastSource) check(plans[0]?.meta?.forecast_source === expect_.forecastSource, `plan meta.forecast_source is ${expect_.forecastSource} (got ${plans[0]?.meta?.forecast_source})`);
  if (expect_.plannerLogged) for (const re of expect_.plannerLogged as string[]) check(new RegExp(re, "i").test(plannerLogs), `the planner logged /${re}/`);
  if (expect_.pagesContain) for (const re of expect_.pagesContain as string[]) check(pages.some((t) => new RegExp(re, "i").test(t)), `would have paged /${re}/ (pages: ${JSON.stringify(pages)})`);
  if (expect_.pagesNone === true) check(pages.length === 0, `no page raised (${JSON.stringify(pages)})`);
  if (expect_.phaseBAllFailed === true) check(phaseB.length > 0 && phaseB.every((p) => /^failed|skipped/i.test(String(p.result))), `every Phase B attempt failed or was skipped — the Pi is down (${JSON.stringify(phaseB.map((p) => p.result))})`);
  // #167: the failure SHAPE matters — a hub that is up but has no Pi answers 503 "no Pi connected", not a connection error
  if (expect_.phaseBResults) check(phaseB.length > 0 && phaseB.every((p) => new RegExp(expect_.phaseBResults, "i").test(String(p.result))), `every Phase B result matches /${expect_.phaseBResults}/ (${JSON.stringify(phaseB.map((p) => p.result))})`);
  if (expect_.hubCommandsRefused != null) { const refused = requests.filter((r) => r.refused && r.path === "/api/command").length; check(refused >= expect_.hubCommandsRefused, `the hub refused ≥ ${expect_.hubCommandsRefused} command(s) with "no Pi connected" (got ${refused})`); }
  if (expect_.hubCommands != null) check(fake.commands.length === expect_.hubCommands, `the hub received exactly ${expect_.hubCommands} command(s) (got ${fake.commands.length})`);
  if (expect_.autopilotResults) check(autopilot.length > 0 && autopilot.every((r) => new RegExp(expect_.autopilotResults, "i").test(String(r.result))), `every auto-pilot decision matches /${expect_.autopilotResults}/ (${JSON.stringify(autopilot.map((r) => r.result))})`);
  if (expect_.patchesMax != null) check(fake.patches.length <= expect_.patchesMax, `SensorLinx received ≤ ${expect_.patchesMax} PATCH (got ${fake.patches.length})`);
  if (expect_.minCurrentBlockTargetF != null) check(Number(current?.tank_target_f) >= expect_.minCurrentBlockTargetF, `current block target ${current?.tank_target_f}°F ≥ ${expect_.minCurrentBlockTargetF} (demand floor applied)`);
  if (expect_.maxCurrentBlockTargetF != null) check(Number(current?.tank_target_f) <= expect_.maxCurrentBlockTargetF, `current block target ${current?.tank_target_f}°F ≤ ${expect_.maxCurrentBlockTargetF} (no floor above the guard)`);
  if (expect_.currentBlockReason) check(new RegExp(expect_.currentBlockReason, "i").test(String(current?.reason ?? "")), `current block reason names the floor (${current?.reason})`);
  const applied = autopilot.filter((r) => /^(set|applied|written|wrote)/i.test(String(r.result)) && r.dry_run === false);
  const targetF = Number(current?.tank_target_f);
  if (expect_.autopilotApplied === true) {
    check(applied.length >= 1, `the auto-pilot APPLIED a target to the HBX (applied ${applied.length}; results ${JSON.stringify(autopilot.map((r) => r.result))})`);
    check(applied.some((r) => Number(r.target_f) === targetF), `the applied target IS the plan's current block (${targetF}°F; applied ${JSON.stringify(applied.map((r) => r.target_f))})`);
    const patchOut = fake.patches.map((p: any) => curveOutputF(p.body, scenario.outdoorF));
    check(patchOut.some((o) => o != null && Math.abs(o - targetF) <= 1), `a PATCHed curve outputs the plan target at ${scenario.outdoorF}°F (outputs ${JSON.stringify(patchOut.map((o) => o == null ? null : Math.round(o * 10) / 10))} vs ${targetF})`);
  }
  if (expect_.everydayCapF != null) check(targetF <= expect_.everydayCapF, `current block ${targetF}°F never exceeds the everyday I4 cap ${expect_.everydayCapF} even though the binding zone asks for more`);
  if (expect_.bindingRequirementF != null) check(new RegExp(`needs ${expect_.bindingRequirementF}°F`).test(String(current?.reason)), `the block reason carries the UNCLAMPED requirement (${expect_.bindingRequirementF}°F) so the clamp is legible: "${current?.reason}"`);
  if (expect_.patchesMin != null) check(fake.patches.length >= expect_.patchesMin, `SensorLinx received ≥ ${expect_.patchesMin} PATCH (got ${fake.patches.length})`);
  if (expect_.driverIdledUnsettledFirst) {
    // Sequence proof: after run 2 the auto-pilot has written the floor (a PATCH exists) but NO window was
    // drawn (the plant was not yet at the plan target); run 3 draws with the settled base.
    const identAfter2 = Number(fs.readFileSync(path.join(OUT, "ident-after-run2.txt"), "utf8").trim());
    const fake2 = JSON.parse(fs.readFileSync(path.join(OUT, "fake-state-after-run2.json"), "utf8"));
    check(identAfter2 === 0, `run 2: no identification window drawn while the plant (${scenario.tank.targetF}°F) was below the plan (${current?.tank_target_f}°F) — got ${identAfter2}`);
    check(fake2.patches.length >= 1, `run 2: the auto-pilot wrote the floor first (PATCHes after run 2: ${fake2.patches.length})`);
    if (ident.length) check(Math.abs(Number(ident[0].base_f) - Number(current?.tank_target_f)) < 3, `the window's base ${ident[0].base_f}°F is the plan target ${current?.tank_target_f}°F, not the stale device value`);
    check(ident.length >= identAfter2 + 1, `run 3 drew the window run 2 withheld (${identAfter2} → ${ident.length}) — no escape hatch`);
  }
  if (expect_.autopilotWrites === false) check(applied.length === 0 && fake.patches.length === 0, `no HBX write at all (applied ${applied.length}, PATCHes ${fake.patches.length})`);
  if (expect_.phaseBCommands != null) check(fake.commands.length >= expect_.phaseBCommands, `Phase B leased setpoints on ${fake.commands.length} pump(s) (≥ ${expect_.phaseBCommands})`);
  // Only the LATEST command per pump is judged against the plan: run 1 tracked the device target before a
  // plan existed (correct at the time); run 2 is the one that must sit above the plan's current block.
  const latestCmd = new Map<string, any>(); for (const c of fake.commands) latestCmd.set(String(c.body.pump_id), c);
  for (const c of fake.commands) check(c.body.lease_minutes === 90, `pump ${c.body.pump_id} write carries the 90-min lease (got ${c.body.lease_minutes})`);
  // What Phase B leads for the block in force: under SHAPED_CURVE live a non-excursion hour is commanded as the plan's
  // shaped curve, so the lead is that curve's OUTPUT at the live outdoor (#222), not the block's declared tank_target_f
  // (135 "winter guard" beside a 120/118 curve); an excursion or flat-target mode leads the declared target.
  const excursion = current && (current.sani === true || current.bank === true || current.boost === true || current.storm === true || /sanitize|storm|bank|boost|pre-?charge/i.test(String(current.reason ?? "")));
  const leadF = shapedLive && current?.shaped_curve && !excursion ? (curveOutputF(current.shaped_curve, scenario.outdoorF) ?? targetF) : targetF;
  for (const c of latestCmd.values()) {
    if (expect_.phaseBMinC != null) check(Number(c.body.value_c) >= expect_.phaseBMinC, `pump ${c.body.pump_id} latest setpoint ${c.body.value_c}°C ≥ ${expect_.phaseBMinC}°C (tank target + I1 margin)`);
    if (current) check(Number(c.body.value_c) >= Math.ceil(fToC(leadF + 5)), `pump ${c.body.pump_id} latest ${c.body.value_c}°C ≥ ceil(${leadF.toFixed(1)}°F + 5°F → ${Math.ceil(fToC(leadF + 5))}°C) (I1 against what the auto-pilot commands)`);
  }
  if (expect_.phaseBCommands != null) check(latestCmd.size >= expect_.phaseBCommands, `every configured pump got a leased setpoint (${latestCmd.size} distinct pumps)`);
  const soakSoon = next3h.some((b) => b.sani || /sanitize/i.test(b.reason));
  if (expect_.probeDrawn === true) { check(!soakSoon, `no soak inside the 3 h look-ahead (the scenario must exercise a draw, not hide behind one)`); check(ident.length >= 1, `identification drew a window (${ident.length})`); }
  if (expect_.probeDrawn === false) check(ident.length === 0, `no identification probe drawn (${ident.length})`);
  for (const p of fake.patches) { const f = Math.max(...["dbt", "mbt"].map((k) => Number(p.body[k] ?? 0))); if (f > 0) check(f <= (expect_.maxAnyWriteF ?? 145), `PATCH curve top ${f}°F ≤ ${expect_.maxAnyWriteF ?? 145} (identification ceiling)`); }
  if (expect_.maxEverydayWriteF != null) for (const w of writes.filter((w) => !/identif|probe/i.test(`${w.source} ${w.action} ${w.detail}`))) { const req = w.requested ?? {}; const f = Math.max(...Object.values(req).map((v: any) => Number(v) || 0)); if (f > 0) check(f <= expect_.maxEverydayWriteF, `everyday write ${w.action} ${f}°F ≤ ${expect_.maxEverydayWriteF} (I4 strictCap)`); }
  // a scenario may DECLARE the one rejection it exists to provoke (fail-closed paths are the point of the degraded set)
  const rejectionOk = expect_.writeRejectionsOk ? new RegExp(expect_.writeRejectionsOk, "i") : null;
  for (const w of writes) {
    if (rejectionOk && w.result === "rejected" && rejectionOk.test(String(w.detail ?? ""))) { check(true, `hbx_write ${w.action} rejected for the declared reason: ${w.detail}`); continue; }
    check(/^(accepted|ok|applied)/i.test(String(w.result)), `hbx_write ${w.action} result "${w.result}" is a success (anything else — rejected, mismatch, refused — fails)`);
  }
  if (expect_.maxWrites != null) check(writes.length <= expect_.maxWrites, `at most ${expect_.maxWrites} HBX write(s) (got ${writes.length})`);
  if (expect_.windowPosted) {
    const windowPostBodies = fake.posts.filter((p: any) => p.path === "/api/insights/experiment-windows").map((p: any) => JSON.stringify(p.body));
    check(windowPosts.length >= 1 && windowPostBodies.some((b) => b.includes("a2w-hbx-write-")), `the auto-pilot's write was posted as a quarantine window (ledger ${windowPosts.length}; posts ${windowPostBodies.length})`);
    // A hold arm is active (and posted) at the draw; a probe arm posts only once its write is accepted, so an
    // 'arming' / 'pending_write' window is legitimately unposted after the last poll. The draw is random.
    if (ident.length) {
      const w = ident[0];
      if (w.state === "active") check(windowPostBodies.some((b) => /identification/i.test(b)), `the ACTIVE identification window (${w.arm} ${w.direction}) was posted open (among ${windowPostBodies.length} posts)`);
      else check(["arming", "pending_write"].includes(String(w.state)), `an unposted window is still arming / pending its write (state ${w.state}, arm ${w.arm}) — not silently dropped`);
    }
  }
  if (expect_.boost) {
    // #232: the boost's timer ran out between polls 2 and 3 (inject-boost.ts). The expiry must restore the PLAN's
    // command for the block in force — the auto-pilot's own curve — through the guarded writer, within that one
    // poll, and never the July as-found curve; afterwards the auto-pilot has nothing to write and Phase B leads the
    // restored curve, not a 158 °F one.
    const b = expect_.boost;
    const fakeInject = JSON.parse(fs.readFileSync(path.join(OUT, "fake-state-after-inject.json"), "utf8"));
    check(boostRows.length === 1 && boostRows[0].restored === true, `the one boost row was marked restored by the expiry (${JSON.stringify(boostRows.map((r) => [r.target_f, r.restored]))})`);
    const boostWrite = writes.find((w) => w.source === "dashboard" && w.action === "set_target" && w.result === "accepted");
    check(boostWrite != null, `the boost itself went through the guarded writer (dashboard set_target accepted)`);
    const expiry = writes.filter((w) => w.source === "boost-expiry");
    check(expiry.length === 1 && expiry[0].result === "accepted", `exactly one boost-expiry write, accepted (${JSON.stringify(expiry.map((w) => [w.action, w.result, w.detail]))})`);
    check(/restored/.test(String(expiry[0]?.detail ?? "")), `the expiry write says what it restored: ${expiry[0]?.detail}`);
    check(fake.patches.length === fakeInject.patches.length + 1, `the restore was the ONLY device write after the boost (${fake.patches.length - fakeInject.patches.length} PATCHes over polls 3–4) — within one poll, no second write`);
    const last = fake.patches.at(-1)?.body ?? {};
    if (b.restoredToPlanCurve) {
      const sc = current?.shaped_curve ?? null;
      const same = sc && ["dot", "dbt", "mbt", "wwsd"].every((k) => Number(last[k]) === Number(sc[k]));
      check(!!same, `the last PATCH is the plan's shaped curve in force ${sc ? `${sc.dbt}@${sc.dot}→${sc.mbt}@${sc.wwsd}` : "(none)"} — got ${JSON.stringify(last)}`);
      check(expiry[0]?.action === "restore", `a curve-hour restore is audited as a restore (closes the boost's TempIQ window), got ${expiry[0]?.action}`);
    }
    const outs = fake.patches.map((p: any) => curveOutputF(p.body, scenario.outdoorF));
    check(outs.every((o) => o != null && o < b.noOutputAboveF), `no PATCH ever outputs ≥ ${b.noOutputAboveF}°F at ${scenario.outdoorF}°F — the as-found curve never came back (outputs ${JSON.stringify(outs.map((o) => o == null ? null : Math.round(o * 10) / 10))})`);
    const lastOut = outs.at(-1);
    check(lastOut != null && Math.abs(lastOut - leadF) <= 1, `the restored curve outputs the plan's command at ${scenario.outdoorF}°F (${lastOut == null ? "—" : lastOut.toFixed(1)} vs ${leadF.toFixed(1)})`);
    const expiryTs = expiry[0] ? new Date(expiry[0].ts).getTime() : 0;
    const after = autopilot.filter((r) => new Date(r.ts).getTime() > expiryTs);
    check(after.length >= 1 && after.every((r) => /^held/.test(String(r.result))), `after the expiry the auto-pilot only HELD (already commanded) — never rate-limited against its own plan (${JSON.stringify(after.map((r) => r.result))})`);
    if (b.phaseBMaxCAfterExpiry != null) for (const c of latestCmd.values()) check(Number(c.body.value_c) <= b.phaseBMaxCAfterExpiry, `pump ${c.body.pump_id} latest ${c.body.value_c}°C ≤ ${b.phaseBMaxCAfterExpiry}°C — Phase B leads the restored curve, not a 158°F one`);
    // Polls 3+ only: a scenario that starts with the as-found curve in force may legitimately page I1 on poll 1 (the
    // 159 °F as-found target against the pumps' starting setpoints) — that is the premise, not the boost's doing.
    const i1Pages = runLogs.slice(2).flatMap(pagesIn).filter((t) => /I1/i.test(t));
    check(i1Pages.length === 0, `no I1 page from the boost's expiry onwards — polls 3+ (${JSON.stringify(i1Pages)})`);
  }
  if (expect_.noUnhandledUpstreamCalls) check(unhandled.length === 0, `no unhandled upstream call (${unhandled.length})`);
  check(!requests.some((r) => /ntfy|resend/i.test(String(r.path))), `no alert egress attempted through the fake`);
  check(configVersions.length >= 1, `the planner recorded the device config (${configVersions.length} version(s))`);

  await store.close();
  console.log(`\n${failures.length === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED — ${failures.length} check(s)`}: ${scenario.name}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error("assert crashed:", e); process.exit(1); });
