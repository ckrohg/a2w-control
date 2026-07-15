// @purpose WebAuthn registration — step 2: verify the attestation and persist the new
// credential. Gated (authed owner only). Binds to the challenge cookie set by step 1;
// requireUserVerification is false so a device without a biometric/PIN prompt can still
// enrol (the auth step likewise stays lenient). On success saves the credential's public
// key + counter + transports keyed by its base64url id.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isAuthed } from "@/lib/auth";
import { RP_ID, ORIGIN, saveCredential } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { response?: unknown; label?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  const expectedChallenge = cookies().get("webauthn_chal")?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ error: "no challenge" }, { status: 400 });
  }
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: body.response as any,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "verification failed" },
      { status: 400 },
    );
  }
  if (v.verified && v.registrationInfo) {
    const { credential } = v.registrationInfo;
    await saveCredential({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      label: body.label || "device",
    });
  }
  const res = NextResponse.json({ ok: v.verified });
  res.cookies.set("webauthn_chal", "", {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0,
  });
  return res;
}
