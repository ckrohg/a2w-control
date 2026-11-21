// @purpose WebAuthn sign-in — step 2: verify the assertion and, on success, mint the
// SAME view-session cookie the password login sets (a2w_view = VIEW_SESSION_SECRET, same
// options). PUBLIC — this is how an unauthed visitor trades a passkey for a session. Binds
// to the challenge cookie from step 1, looks the credential up by id, and advances the
// stored signature counter to help detect cloned authenticators. A malformed or oversized
// body is a 400/413 (lib/login-input.ts) and a library throw is a generic 401, never a 500.
// Every exit after the challenge is read clears it, so a failed attempt can't replay it.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { RP_ID, ORIGIN, getCredential, updateCounter } from "@/lib/webauthn";
import { readPasskeyResponse } from "@/lib/login-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same options as the challenge cookie set in ../options, with maxAge 0 to delete it.
function done(res: NextResponse): NextResponse {
  res.cookies.set("webauthn_chal", "", {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0,
  });
  return res;
}

export async function POST(req: Request) {
  const sessionSecret = process.env.VIEW_SESSION_SECRET;
  if (!sessionSecret) {
    return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  }
  const expectedChallenge = cookies().get("webauthn_chal")?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ error: "no challenge" }, { status: 400 });
  }
  const body = await readPasskeyResponse(req);
  if (!body.ok) {
    return done(NextResponse.json({ error: body.error }, { status: body.status }));
  }
  const response = body.response;
  const cred = await getCredential(response.id);
  if (!cred) return done(NextResponse.json({ error: "unknown credential" }, { status: 404 }));

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
  } catch {
    // The library's messages quote the challenge, origin and other request values — never
    // send them back. A stale challenge (the assertion was signed over an older one) lands here;
    // an expired cookie (maxAge 300) is simply absent and got the "no challenge" 400 above.
    return done(NextResponse.json({ error: "verification failed" }, { status: 401 }));
  }

  if (!v.verified) {
    return done(NextResponse.json({ error: "verification failed" }, { status: 401 }));
  }
  await updateCounter(cred.id, v.authenticationInfo.newCounter);

  const res = NextResponse.json({ ok: true });
  // Identical to app/api/login/route.ts — a passkey earns the same session as the password.
  res.cookies.set("a2w_view", sessionSecret, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/",
    maxAge: 30 * 86400,
  });
  return done(res);
}
