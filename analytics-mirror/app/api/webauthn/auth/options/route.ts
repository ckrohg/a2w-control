// @purpose WebAuthn sign-in — step 1: mint authentication options. PUBLIC (an unauthed
// visitor at /login must be able to start a passkey sign-in). Lists the registered
// credentials as allowCredentials and stashes the challenge in a short-lived httpOnly
// cookie for the verify step. If nothing is registered yet, returns options with an empty
// allowCredentials — the browser will then have no passkey to offer.
import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID, ensureCredTable, listCredentials } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await ensureCredTable();
  const creds = await listCredentials();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: "preferred",
  });
  const res = NextResponse.json(options);
  res.cookies.set("webauthn_chal", options.challenge, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 300,
  });
  return res;
}
