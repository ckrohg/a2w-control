// @purpose Pure mapping from the /api/hub/command reply (HTTP status + hub JSON body) to the one
// line the Control page shows under a pump after a setpoint send. 504 means "no answer, outcome
// unknown": the hub's reason in body.detail is shown as given (never matched on wording, so a
// reworded reason still shows), except the plain "ack timeout" which gets the 10 s wording.
// Every message is a single plain line.

export type CommandBody = { ok?: boolean; setpoint_c?: number | null; detail?: unknown; error?: unknown };

const ACK_TIMEOUT_TEXT =
  "No answer from the pump within 10 s. The change may still have been applied; check the setpoint before sending again.";

/** A hub-supplied string folded onto one line; "" for anything missing or not a string. */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s*[\r\n]+\s*/g, " ").trim() : "";
}

const cToF = (c: number) => (c * 9) / 5 + 32;

export function commandMessage(status: number, body: CommandBody, targetF: number): string {
  const detail = oneLine(body.detail);
  const error = oneLine(body.error);
  if (status >= 200 && status < 300 && body.ok) {
    const c = body.setpoint_c;
    const f = typeof c === "number" && Number.isFinite(c) ? cToF(c) : null;
    return `Set to ${f == null ? targetF : Math.round(f)}°F ✓`;
  }
  if (status === 503) return "Pi offline — command not sent.";
  if (status === 504) {
    if (!detail || detail === "ack timeout") return ACK_TIMEOUT_TEXT;
    return `No answer: ${detail.replace(/\.+$/, "")}. Check the setpoint before sending again.`;
  }
  if (status === 502) return `Rejected: ${detail || error || "guardrail nack"}`;
  return detail || error || `Failed (${status}).`;
}
