// @purpose Security page — manage device passkeys for the dashboard. Reached only when
// authed (middleware gate), so it's safe to list registered credentials server-side. Shows
// each passkey's label + when it was added, plus a client control to enrol the current
// device. Passkeys are an addition to, not a replacement for, the shared password — the
// password remains the fallback sign-in.
import { fmtDateTime } from "@/lib/tz";
import { ensureCredTable, listCredentials } from "@/lib/webauthn";
import { RegisterPasskey } from "./register-passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function Security() {
  await ensureCredTable();
  const creds = await listCredentials();

  return (
    <main>
      <header>
        <h1>Security</h1>
        <p className="dim">
          Sign in with Face ID / Touch ID instead of the password. The password stays as a
          fallback — passkeys only add a faster way in on trusted devices.
        </p>
      </header>

      <div className="cards" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Registered passkeys</h2>
          {creds.length === 0 ? (
            <p className="meta">No passkeys yet. Register this device below.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {creds.map((c) => (
                <li
                  key={c.id}
                  style={{
                    display: "flex", justifyContent: "space-between", gap: 12,
                    padding: "8px 0", borderBottom: "1px solid var(--line)",
                  }}
                >
                  <span>{c.label || "device"}</span>
                  <span className="meta" style={{ marginTop: 0 }}>
                    added {fmtDateTime(c.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Add a passkey</h2>
          <p className="meta" style={{ marginBottom: 10 }}>
            Register the device you&apos;re on now. You&apos;ll be prompted for Face ID,
            Touch ID, or a security key.
          </p>
          <RegisterPasskey />
        </div>
      </div>
    </main>
  );
}
