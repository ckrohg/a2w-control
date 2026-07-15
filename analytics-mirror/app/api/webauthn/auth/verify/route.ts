// @purpose WebAuthn sign-in — step 2: verify the assertion and, on success, mint the
// SAME view-session cookie the password login sets (a2w_view = VIEW_SESSION_SECRET, same
// options). PUBLIC — this is how an unauthed visitor trades a passkey for a session. Binds
// to the challenge cookie from step 1, looks the credential up by id, and advances the
// stored signature counter to help detect cloned authenticators.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { RP_ID, ORIGIN, getCredential, updateCounter } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sessionSecret = process.env.VIEW_SESSION_SECRET;
  if (!sessionSecret) {
    return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  }
  let body: { response?: any } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  const response = body.response;
  const expectedChallenge = cookies().get("webauthn_chal")?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ error: "no challenge" }, { status: 400 });
  }
  if (!response?.id) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const cred = await getCredential(response.id);
  if (!cred) return NextResponse.json({ error: "unknown credential" }, { status: 404 });

  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: {
        id: cred.id,
        publicKey: cred.publicKey,
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "verification failed" },
      { status: 401 },
    );
  }

  if (!v.verified) {
    return NextResponse.json({ error: "verification failed" }, { status: 401 });
  }
  await updateCounter(cred.id, v.authenticationInfo.newCounter);

  const res = NextResponse.json({ ok: true });
  // Identical to app/api/login/route.ts — a passkey earns the same session as the password.
  res.cookies.set("a2w_view", sessionSecret, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/",
    maxAge: 30 * 86400,
  });
  res.cookies.set("webauthn_chal", "", {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0,
  });
  return res;
}
