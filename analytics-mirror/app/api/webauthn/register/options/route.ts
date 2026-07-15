// @purpose WebAuthn registration — step 1: mint creation options. Gated (must already
// hold the password session): only an authed owner can enrol a new device passkey. Stores
// the challenge in a short-lived httpOnly cookie so the verify step can bind to it, and
// excludes already-registered credentials so the same authenticator can't double-enrol.
import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { isAuthed } from "@/lib/auth";
import { RP_ID, RP_NAME, OWNER_ID, ensureCredTable, listCredentials } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureCredTable();
  const creds = await listCredentials();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "owner",
    userID: OWNER_ID,
    attestationType: "none",
    excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const res = NextResponse.json(options);
  res.cookies.set("webauthn_chal", options.challenge, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 300,
  });
  return res;
}
