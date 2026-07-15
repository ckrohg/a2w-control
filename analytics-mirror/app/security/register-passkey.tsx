// @purpose Client half of /security — enrol THIS device as a passkey. The page is already
// gated by middleware (authed owner), so the register/options + register/verify endpoints
// accept the call. Flow: fetch creation options → navigator.credentials.create via
// startRegistration → POST the attestation back with a device label → reload to show the
// new entry in the server-rendered list.
"use client";
import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";

export function RegisterPasskey() {
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setStatus("");
    try {
      const optRes = await fetch("/api/webauthn/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("could not start registration");
      const opts = await optRes.json();
      const response = await startRegistration({ optionsJSON: opts });
      const verRes = await fetch("/api/webauthn/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, label: label.trim() }),
      });
      const data = await verRes.json().catch(() => ({}));
      if (verRes.ok && data.ok) {
        setStatus("Registered — reloading…");
        location.reload();
      } else {
        throw new Error(data.error || "registration failed");
      }
    } catch (e: any) {
      const msg =
        e?.name === "NotAllowedError"
          ? "Registration cancelled"
          : e?.name === "InvalidStateError"
            ? "This device already has a passkey registered"
            : e?.message || "registration failed";
      setStatus(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="login" style={{ margin: 0, maxWidth: "none" }}>
        <input
          type="text" value={label} disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Device name (e.g. iPhone, MacBook)"
        />
      </div>
      <button type="button" onClick={register} disabled={busy} style={{ marginTop: 10 }}>
        {busy ? "…" : "Register this device"}
      </button>
      {status && <p className="meta" style={{ marginTop: 10 }}>{status}</p>}
    </div>
  );
}
