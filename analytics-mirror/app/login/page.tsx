"use client";
import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    setBusy(false);
    if (res.ok) window.location.href = "/";
    else setErr((await res.json().catch(() => ({}))).error || "sign-in failed");
  }

  async function passkey() {
    setBusy(true);
    setErr("");
    try {
      const optRes = await fetch("/api/webauthn/auth/options", { method: "POST" });
      if (!optRes.ok) throw new Error("could not start passkey sign-in");
      const opts = await optRes.json();
      if (!opts.allowCredentials?.length) {
        throw new Error("No passkey registered on this account yet");
      }
      const response = await startAuthentication({ optionsJSON: opts });
      const verRes = await fetch("/api/webauthn/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const data = await verRes.json().catch(() => ({}));
      if (verRes.ok && data.ok) window.location.href = "/";
      else throw new Error(data.error || "passkey sign-in failed");
    } catch (e: any) {
      // NotAllowedError = user cancelled / no matching passkey on the device.
      const msg =
        e?.name === "NotAllowedError"
          ? "Passkey sign-in cancelled"
          : e?.message || "passkey sign-in failed";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>A2W Analytics</h1>
      <p className="dim" style={{ marginTop: 6 }}>Enter the dashboard password.</p>
      <form onSubmit={submit}>
        <input
          type="password" value={pw} autoFocus autoComplete="current-password"
          onChange={(e) => setPw(e.target.value)} placeholder="Password"
        />
        <div className="err">{err}</div>
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : "Sign in"}
        </button>
      </form>
      <button
        type="button" onClick={passkey} disabled={busy}
        style={{ width: "100%", marginTop: 10 }}
      >
        Sign in with a passkey
      </button>
    </div>
  );
}
