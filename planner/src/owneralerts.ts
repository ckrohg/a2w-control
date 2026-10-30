/**
 * @purpose Two Phase B failsafe conditions the owner hears about by email, in their words (owner decision 2026-10-29;
 * page tier, so the 6bb push goes too). The owner's reply to "no lease armed" was "I have no idea what that means", so
 * nothing here says lease, Phase B or writer:
 *
 *   "Heat-pump safety net is off"           a pump's 90-min revert countdown has not been armed for > 30 min although
 *                                           A2W's setpoints were accepted (FINDING-1's failsafe is off)
 *   "A2W can't control the heat pumps"      Phase B writes failed 7 cycles in a row (~35 min since the last one landed)
 *
 * The PLANNER sends both, the Pi neither: the Pi sees "no countdown" whenever nobody is setting the pumps (dry-run, a
 * planner that is down, the pump already back at its baseline), so it cannot tell a missing failsafe from an idle one.
 * Only the planner knows it asked for a countdown. One sender, no duplicates.
 *
 * Both are SustainedEpisodes: they open only after the condition has held (so the one "no countdown" read after a Pi
 * restart, or a write that fails once, never reaches the owner) and close only after the all-clear has held for 30
 * min, so a flapping condition stays one episode instead of an email pair every cycle.
 */
import { C, esc, factsTable, footer, paragraphs, shell } from "./alertemail";
import type { HubPump } from "./hub";

/** The Pi's guardrails.baseline_setpoint_c (CLAUDE.md, FINDING-1): what the countdown reverts a pump to. */
export const BASELINE_C = 52;
/** The safety net counts as off once a pump has shown no countdown for longer than this. */
export const SAFETY_NET_OFF_MS = 30 * 60_000;
/** Consecutive failed Phase B cycles before the owner hears: the 7th failure is ~35 min after the last write landed. */
export const CONTROL_FAILING_STREAK = 7;
/** An all-clear is sent only after the condition has been clear this long without a break. */
export const ALL_CLEAR_MS = 30 * 60_000;

export const SAFETY_NET_KEY = "safety-net-off";
export const CONTROL_KEY = "control-failing";

/**
 * One owner-facing condition. step() is called once per Phase B cycle with what that cycle saw:
 *   "bad"     the condition holds (the caller has already applied its own "for how long" rule)
 *   "good"    it is clear
 *   "unknown" nothing was observed (dry-run, writes skipped, hub unreadable): nothing changes, except that it breaks a
 *             run of "good", because an all-clear must be continuous
 * Returns "open" or "close" on the cycle the owner should hear it, else null.
 */
export class SustainedEpisode {
  open = false;
  private goodSince: number | null = null;
  constructor(private readonly clearAfterMs: number = ALL_CLEAR_MS) {}

  step(seen: "bad" | "good" | "unknown", nowMs: number): "open" | "close" | null {
    if (seen === "bad") {
      this.goodSince = null;
      if (this.open) return null;
      this.open = true;
      return "open";
    }
    if (seen === "unknown") { this.goodSince = null; return null; }
    this.goodSince ??= nowMs;
    if (this.open && nowMs - this.goodSince >= this.clearAfterMs) {
      this.open = false;
      this.goodSince = null;
      return "close";
    }
    return null;
  }
}

/** What the owner's email needs: the heading, the plain text (push + text email), and the HTML. */
export interface OwnerMessage {
  title: string;
  body: string;
  action?: string;
  facts: [string, string][];
  html: string;
}

const fmtF = (v: number | null | undefined) => (v == null ? "unknown" : `${Math.round(v)} °F`);

function pumpLabel(p: HubPump): string { return p.name || p.id; }

/** A pump's state in plain words. */
export function pumpWords(p: HubPump | undefined): string {
  if (!p) return "no report";
  if (p.deliberate_stop) return "switched off by hand";
  if (!p.online || p.state === "offline") return "not answering";
  const fault = (p.active_faults ?? 0) > 0 ? ", showing a fault" : "";
  if (p.state === "heating") return `heating${fault}`;
  if (p.state === "idle") return `on, resting${fault}`;
  return `on${fault}`;
}

/** "Is anything cold right now?" — one sentence from the tank and the pumps. */
export function coldNow(tankF: number | null, floorF: number, pumps: HubPump[] | null): string {
  const ps = pumps ?? [];
  const down = ps.filter((p) => !p.online || p.state === "offline" || (p.active_faults ?? 0) > 0);
  const pumpsLine = !pumps
    ? "A2W couldn't read the heat pumps' state just now."
    : down.length === 0
      ? ps.length > 1 ? "Both heat pumps are running normally." : "The heat pump is running normally."
      : `${down.map(pumpLabel).join(" and ")} ${down.length > 1 ? "are" : "is"} ${down.length > 1 ? "not answering or showing a fault" : pumpWords(down[0])}.`;
  if (tankF == null) return `A2W couldn't read the tank temperature just now. ${pumpsLine}`;
  return tankF >= floorF
    ? `Nothing is cold right now: the tank is ${fmtF(tankF)} (hot water needs about ${fmtF(floorF)}). ${pumpsLine}`
    : `The tank is ${fmtF(tankF)}, below the ${fmtF(floorF)} hot water needs. ${pumpsLine}`;
}

function houseFacts(tankF: number | null, pumps: HubPump[] | null, ids: string[]): [string, string][] {
  const facts: [string, string][] = [["Tank", fmtF(tankF)]];
  for (const id of ids) {
    const p = pumps?.find((x) => x.id === id);
    facts.push([p ? pumpLabel(p) : id, pumpWords(p)]);
  }
  return facts;
}

const whichPumps = (names: string[], all: number) =>
  names.length >= all && all > 1 ? "both heat pumps" : names.join(" and ");

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} minutes`;

/** The standard A2W email layout (alertemail.ts), with the owner's text at reading size under the headline instead
 *  of as small grey details. Only page-tier opens and their all-clears use it. */
export function ownerHtml(m: { title: string; lead: string; action?: string; facts: [string, string][]; resolved: boolean; at?: Date }): string {
  const b = m.resolved ? { label: "✅ RESOLVED · no action needed", ...C.resolved } : { label: "🚨 URGENT · act now", ...C.page };
  const action = m.action
    ? `<div style="border-left:4px solid ${C.page.bg};background:${C.tile};padding:10px 12px;margin:0 0 16px;border-radius:0 6px 6px 0">` +
      `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:${C.ink2};margin-bottom:3px">WHAT TO DO</div>` +
      `<div style="font-size:16px;line-height:1.4">${esc(m.action)}</div></div>`
    : "";
  return shell(
    `<div style="display:inline-block;background:${b.bg};color:${b.fg};font-size:12px;font-weight:700;letter-spacing:.04em;padding:5px 9px;border-radius:4px;margin:4px 0 10px">${esc(b.label)}</div>` +
    `<h1 style="font-size:21px;line-height:1.25;margin:0 0 14px;font-weight:700">${esc(m.title)}</h1>` +
    paragraphs(m.lead, `font-size:16px;line-height:1.45;color:${C.ink}`) +
    action + factsTable(m.facts) +
    footer("A2W planner", m.at ?? new Date(), m.resolved
      ? "This closes an alert you were sent earlier."
      : "You got this because a safety feature that protects the house's heat is not working."));
}

function message(title: string, lead: string, action: string | undefined, facts: [string, string][], resolved: boolean): OwnerMessage {
  const body = [lead, action ? `What to do: ${action}` : ""].filter(Boolean).join("\n\n");
  return { title, body, action, facts, html: ownerHtml({ title, lead, action, facts, resolved }) };
}

const SAFETY_NET_MEANS =
  `A2W normally sets a 90-minute countdown each time it sets the heat pumps; if A2W stopped working, the Pi would put ` +
  `the pumps back to a safe warm ${BASELINE_C} °C on its own. That countdown isn't running, so that automatic recovery is off.`;

export function safetyNetOffMessage(a: {
  offPumps: { name: string; forMs: number }[]; allPumps: string[]; pumps: HubPump[] | null; tankF: number | null; floorF: number;
}): OwnerMessage {
  const longest = Math.max(...a.offPumps.map((p) => p.forMs));
  const lead = [
    `${SAFETY_NET_MEANS} It has been off for ${minutes(longest)} on ${whichPumps(a.offPumps.map((p) => p.name), a.allPumps.length)}.`,
    coldNow(a.tankF, a.floorF, a.pumps),
    `A2W is still setting the heat pumps, so the house keeps heating as usual. Only the automatic recovery is missing: ` +
      `if A2W also stopped before this is fixed, the pumps would stay at their last setting instead of going back to ${BASELINE_C} °C.`,
  ].join("\n\n");
  return message("Heat-pump safety net is off", lead,
    "Nothing to do at the house. Ask Claude to find out why the Pi isn't running the countdown. You'll get a \"back on\" email when it is fixed.",
    [["Off for", minutes(longest)], ...houseFacts(a.tankF, a.pumps, a.allPumps)], false);
}

export function safetyNetBackMessage(a: { pumps: HubPump[] | null; tankF: number | null; allPumps: string[] }): OwnerMessage {
  const lead =
    `The 90-minute countdown is running again on ${a.allPumps.length > 1 ? "both heat pumps" : "the heat pump"} and has ` +
    `stayed on for 30 minutes. If A2W stopped working, the Pi would again put the pumps back to a safe warm ${BASELINE_C} °C on its own. Nothing to do.`;
  return message("Safety net is back on", lead, undefined, houseFacts(a.tankF, a.pumps, a.allPumps), true);
}

export function controlFailingMessage(a: {
  failing: string[]; allPumps: string[]; sinceMs: number; safetyNet: "on" | "off" | "unknown";
  pumps: HubPump[] | null; tankF: number | null; floorF: number;
}): OwnerMessage {
  const names = a.failing.map((id) => a.pumps?.find((p) => p.id === id)?.name || id);
  const recovery = a.safetyNet === "off"
    ? `The safety net is off too, so the pumps will stay at their last setting until this is fixed.`
    : `Within 90 minutes of A2W's last successful setting, the Pi puts the pumps back to a safe warm ${BASELINE_C} °C on ` +
      `its own, so the house keeps heating, just less efficiently.`;
  const lead = [
    `A2W tries to set the heat pumps every 5 minutes. For about ${minutes(a.sinceMs)} none of its settings have reached ` +
      `${whichPumps(names, a.allPumps.length)}. ${recovery}`,
    coldNow(a.tankF, a.floorF, a.pumps),
  ].join("\n\n");
  return message("A2W can't control the heat pumps", lead,
    "Nothing to do at the house unless it gets cold. Ask Claude to check the Pi and its connection (the usual cause is the Pi " +
      "being offline). You'll get an email when A2W is back in control.",
    [["Not reaching", whichPumps(names, a.allPumps.length)], ["For", minutes(a.sinceMs)], ...houseFacts(a.tankF, a.pumps, a.allPumps)], false);
}

export function controlBackMessage(a: { pumps: HubPump[] | null; tankF: number | null; allPumps: string[] }): OwnerMessage {
  const lead = `A2W's settings have been reaching ${a.allPumps.length > 1 ? "both heat pumps" : "the heat pump"} again for 30 minutes. Nothing to do.`;
  return message("A2W is controlling the heat pumps again", lead, undefined, houseFacts(a.tankF, a.pumps, a.allPumps), true);
}
