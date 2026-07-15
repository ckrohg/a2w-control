// @purpose WebAuthn (device passkey) config + DB helpers for the single-user dashboard.
// One owner, no usernames — just a set of registered credentials. Public keys are stored
// base64url-encoded in Postgres (webauthn_credentials); decoded back to Uint8Array for the
// SimpleWebAuthn v13 verify calls. RP_ID/ORIGIN are env-driven so the same code runs on
// the Vercel prod host and any preview/custom domain.
import { sql } from "@vercel/postgres";
import type { AuthenticatorTransportFuture, Uint8Array_ } from "@simplewebauthn/server";

export const RP_ID = process.env.WEBAUTHN_RP_ID ?? "a2w-analytics-mirror.vercel.app";
export const RP_NAME = "A2W Control";
export const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? `https://${RP_ID}`;

// v13 wants userID as a Uint8Array. One fixed owner — the identity is the dashboard itself.
export const OWNER_ID = new TextEncoder().encode("a2w-owner");

// Idempotent create — cheap to call before a read/insert.
export async function ensureCredTable() {
  await sql`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
}

export type StoredCredential = {
  id: string;
  // Uint8Array_ = ReturnType<Uint8Array['slice']> — the concrete Uint8Array<ArrayBuffer>
  // brand SimpleWebAuthn v13 uses; keeps this flowing cleanly into verify* without a cast.
  publicKey: Uint8Array_;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  label?: string;
  created_at: Date;
};

type CredRow = {
  id: string;
  public_key: string;
  counter: string | number;
  transports: string | null;
  label: string | null;
  created_at: Date;
};

function rowToCredential(row: CredRow): StoredCredential {
  return {
    id: row.id,
    // .slice() yields a fresh Uint8Array backed by a plain ArrayBuffer (not the pooled
    // Buffer's ArrayBufferLike) — the concrete type SimpleWebAuthn v13 expects.
    publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")).slice(),
    counter: Number(row.counter),
    transports: row.transports
      ? (row.transports.split(",") as AuthenticatorTransportFuture[])
      : undefined,
    label: row.label ?? undefined,
    created_at: row.created_at,
  };
}

export async function listCredentials(): Promise<StoredCredential[]> {
  const { rows } = await sql<CredRow>`
    SELECT id, public_key, counter, transports, label, created_at
    FROM webauthn_credentials ORDER BY created_at ASC`;
  return rows.map(rowToCredential);
}

export async function getCredential(id: string): Promise<StoredCredential | null> {
  const { rows } = await sql<CredRow>`
    SELECT id, public_key, counter, transports, label, created_at
    FROM webauthn_credentials WHERE id = ${id} LIMIT 1`;
  return rows.length ? rowToCredential(rows[0]) : null;
}

export async function saveCredential(cred: {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  label?: string;
}) {
  const publicKeyB64 = Buffer.from(cred.publicKey).toString("base64url");
  const transports = cred.transports?.length ? cred.transports.join(",") : null;
  await sql`
    INSERT INTO webauthn_credentials (id, public_key, counter, transports, label)
    VALUES (${cred.id}, ${publicKeyB64}, ${cred.counter}, ${transports}, ${cred.label ?? null})
    ON CONFLICT (id) DO UPDATE SET
      public_key = EXCLUDED.public_key,
      counter = EXCLUDED.counter,
      transports = EXCLUDED.transports,
      label = EXCLUDED.label`;
}

export async function updateCounter(id: string, counter: number) {
  await sql`UPDATE webauthn_credentials SET counter = ${counter} WHERE id = ${id}`;
}
