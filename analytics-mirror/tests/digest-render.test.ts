// @purpose Assertions for the weekly digest's pure rendering (lib/digest-render.ts): the delta chip, the headline's
// priority order, the fault list (escaping, active-but-not-this-week) and the subject line.
// Run with: npx tsx tests/digest-render.test.ts
import assert from "node:assert/strict";
import { delta, headline, faultLines, subjectLine, day, fmt, INK2, GOOD, BAD, type FaultRow } from "../lib/digest-render";

// ---- fmt -------------------------------------------------------------------------------
assert.equal(fmt(null), "—");
assert.equal(fmt(Number.NaN), "—");
assert.equal(fmt(3.14159, 2), "3.14");

// ---- delta -----------------------------------------------------------------------------
assert.equal(delta(100.4, 100, "up"), `<span style="color:${INK2}">· flat vs last wk</span>`, "0.4% is flat");
assert.equal(delta(99.6, 100, "down"), `<span style="color:${INK2}">· flat vs last wk</span>`, "−0.4% is flat");
assert.match(delta(110, 100, "up"), new RegExp(`^<span style="color:${GOOD}">▲ 10%</span>`), "up is a win when goodWhen=up");
assert.match(delta(110, 100, "down"), new RegExp(`^<span style="color:${BAD}">▲ 10%</span>`), "up is a loss when goodWhen=down");
assert.match(delta(90, 100, "down"), new RegExp(`^<span style="color:${GOOD}">▼ 10%</span>`), "down is a win when goodWhen=down");
assert.match(delta(90, 100, "up"), new RegExp(`^<span style="color:${BAD}">▼ 10%</span>`), "down is a loss when goodWhen=up");
assert.ok(delta(110, 100, "up").endsWith(`<span style="color:${INK2}"> vs last wk</span>`));
assert.equal(delta(5, null, "up"), "", "no previous week");
assert.equal(delta(5, undefined, "up"), "", "no previous week");
assert.equal(delta(5, 0, "up"), "", "zero previous — a percentage would be meaningless");
assert.equal(delta(null, 5, "up"), "", "no current value");

// ---- headline: priority order ------------------------------------------------------------
const base = { activeFaults: 0, pegShare: 0, lastZone: null, backupH: 0, backupKwh: 0, curSaved: 12.5, prevSaved: null };
const everything = { activeFaults: 2, pegShare: 0.5, lastZone: "Kitchen", backupH: 3, backupKwh: 49.5, curSaved: 12.5, prevSaved: 10 };
assert.equal(headline(everything), "⚠ 2 faults currently active — see below.", "active faults outrank everything");
assert.equal(headline({ ...everything, activeFaults: 1 }), "⚠ 1 fault currently active — see below.");
assert.equal(headline({ ...everything, activeFaults: 0 }),
  "The demand floor sat at the 135°F cap 50% of the week (binding zone: Kitchen) — the sizing question (#89) is live.",
  "pegged floor is next");
assert.equal(headline({ ...everything, activeFaults: 0, pegShare: 0.25, lastZone: null }),
  "The demand floor sat at the 135°F cap 25% of the week — the sizing question (#89) is live.", "25% is the threshold");
assert.match(headline({ ...everything, activeFaults: 0, pegShare: 0.3, lastZone: "<b>Den & Hall</b>" }),
  /\(binding zone: &lt;b&gt;Den &amp; Hall&lt;\/b&gt;\)/, "binding zone is escaped");
assert.equal(headline({ ...everything, activeFaults: 0, pegShare: 0.24 }),
  "The backup element ran 3.0 h this week (~50 kWh at COP 1) — worth a look.", "backup > 1 h is next");
assert.equal(headline({ ...everything, activeFaults: 0, pegShare: 0.24, backupH: 1 }),
  "Saved $12.50 — up 25% on last week. No active faults.", "exactly 1 h of backup is not a headline; week-over-week is next");
assert.equal(headline({ ...base, curSaved: 8, prevSaved: 10 }),
  "Saved $8.00 — down 20% on last week (weather-dependent). No active faults.");
assert.equal(headline({ ...base, prevSaved: 0.5 }), "A quiet week: $12.50 saved, no active faults.", "a tiny previous week is not compared");
assert.equal(headline(base), "A quiet week: $12.50 saved, no active faults.", "quiet is last");

// ---- fault lines -------------------------------------------------------------------------
const t = 1_792_000_000;
const fault = (o: Partial<FaultRow>): FaultRow =>
  ({ pump_id: "hp1", code: "E21", severity: "critical", message: "Water flow fault", n: 1, last_ts: t, ...o });

// A fixture with no special characters renders exactly as the route's pre-extraction template did.
{
  const lines = faultLines(
    [fault({ n: 3 }), fault({ pump_id: "hp2", code: "R02", severity: "warning", message: null })],
    [fault({ last_ts: t + 60 })],
  );
  assert.deepEqual(lines, [
    `<li style="margin:4px 0"><b>HP1 E21</b>
      (critical): Water flow fault (×3 this week), last ${day(t)} — <b style="color:${BAD}">still active</b></li>`,
    `<li style="margin:4px 0"><b>HP2 R02</b>
      (warning): , last ${day(t)} — cleared</li>`,
  ]);
}

// DB strings are escaped — message, code, pump id and severity alike.
{
  const [line] = faultLines([fault({ message: `<script>alert("x")</script> & more`, code: "E<1>", pump_id: "hp&1", severity: "crit'cal" })], []);
  assert.ok(line.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more"), line);
  assert.ok(!line.includes("<script>"), "no raw script tag");
  assert.ok(line.includes("<b>HP&amp;1 E&lt;1&gt;</b>"), "pump id upper-cased before escaping, code escaped");
  assert.ok(line.includes("(crit&#39;cal)"), "severity escaped");
  assert.ok(line.includes(" — cleared"));
}

// An active fault that did not fire this week (it went on earlier and never cleared) is still listed.
{
  const lines = faultLines([fault({})], [fault({ pump_id: "hp2", code: "E03", message: "Low pressure <5 psi", last_ts: t - 30 * 86400 })]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `<li style="margin:4px 0"><b>HP2 E03</b>
        (critical): Low pressure &lt;5 psi — <b style="color:${BAD}">still active</b> since ${day(t - 30 * 86400)}</li>`);
  assert.ok(lines[0].endsWith(" — cleared</li>"), "this week's hp1 E21 is not active");
}
assert.deepEqual(faultLines([], []), []);

// ---- subject -----------------------------------------------------------------------------
assert.equal(subjectLine({ curSaved: 12.5, prevSaved: 10, cop: 3.456, kwh: 120.4, activeFaults: 0 }),
  "A2W weekly: $12.50 saved (▲25%) · COP 3.46 · 120 kWh");
assert.equal(subjectLine({ curSaved: 8, prevSaved: 10, cop: 3, kwh: 99.6, activeFaults: 1 }),
  "A2W weekly: $8.00 saved (▼20%) · COP 3.00 · 100 kWh · 1 active fault");
assert.equal(subjectLine({ curSaved: 8, prevSaved: undefined, cop: null, kwh: 0, activeFaults: 2 }),
  "A2W weekly: $8.00 saved · COP — · 0 kWh · 2 active faults", "no previous week → no percentage");
assert.equal(subjectLine({ curSaved: 8, prevSaved: 0.4, cop: 3, kwh: 1, activeFaults: 0 }),
  "A2W weekly: $8.00 saved · COP 3.00 · 1 kWh", "tiny previous week → no percentage");

console.log("digest-render: all assertions passed");
