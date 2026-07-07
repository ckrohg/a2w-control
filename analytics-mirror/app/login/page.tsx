"use client";
import { useState } from "react";

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
    </div>
  );
}
