// @purpose node:assert suite that calls app/api/login's POST handler directly with constructed
// Requests: every malformed or oversized body is a 400/413 with a fixed message (never a 500,
// never the input echoed) and sets no cookie; a wrong password is still the 401 it always was;
// the right password still gets { ok: true } and the same a2w_view cookie (value, 30-day
// Max-Age, HttpOnly, Secure, SameSite=Strict, Path=/). The passkey verify route needs Next's
// request context for cookies(), so its body handling is covered in tests/login-input.test.ts.
// Run: npx tsx tests/login-route.test.ts
import assert from "node:assert/strict";
import { POST } from "../app/api/login/route";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const PW = "correct horse battery";
const SECRET = "test-view-session-secret-0123456789";
process.env.VIEW_PASSWORD = PW;
process.env.VIEW_SESSION_SECRET = SECRET;

const MARK = "ECHO_CANARY_7f3a";
const call = (body: BodyInit | null) =>
  POST(new Request("https://mirror.test/api/login", {
    method: "POST", body, headers: { "Content-Type": "application/json" },
  }));

async function main() {
  await t("right password → 200 { ok: true } and the unchanged a2w_view cookie", async () => {
    const res = await call(JSON.stringify({ password: PW }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const c = res.headers.get("set-cookie") ?? "";
    assert.match(c, new RegExp(`^a2w_view=${SECRET};`));
    assert.match(c, /Max-Age=2592000/);
    assert.match(c, /HttpOnly/i);
    assert.match(c, /Secure/i);
    assert.match(c, /SameSite=strict/i);
    assert.match(c, /Path=\//);
  });

  await t("wrong password (string, any length) → 401 incorrect password, no cookie", async () => {
    for (const p of ["nope", PW + "x", PW.slice(0, -1), "x".repeat(1024)]) {
      const res = await call(JSON.stringify({ password: p }));
      assert.equal(res.status, 401, p.slice(0, 20));
      assert.deepEqual(await res.json(), { error: "incorrect password" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });

  await t("malformed bodies → 400 bad request, no cookie, no echo", async () => {
    for (const body of [
      null, "", MARK, `{"password":"${MARK}"`, "null", "123", `"${MARK}"`, "[]",
      "{}", JSON.stringify({ password: 123 }), JSON.stringify({ password: { MARK } }),
      JSON.stringify({ password: [MARK] }), JSON.stringify({ password: null }), JSON.stringify({ password: "" }),
      JSON.stringify({ password: MARK + "x".repeat(1024) }),
    ]) {
      const res = await call(body);
      const text = await res.text();
      assert.equal(res.status, 400, String(body).slice(0, 40));
      assert.deepEqual(JSON.parse(text), { error: "bad request" });
      assert.ok(!text.includes(MARK));
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });

  await t("oversized body → 413 request too large, no cookie", async () => {
    const res = await call(JSON.stringify({ password: "x".repeat(32 * 1024) }));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request too large" });
    assert.equal(res.headers.get("set-cookie"), null);
  });

  await t("auth not configured → still the 500 it always was", async () => {
    delete process.env.VIEW_PASSWORD;
    const res = await call(JSON.stringify({ password: PW }));
    assert.equal(res.status, 500);
    process.env.VIEW_PASSWORD = PW;
  });

  console.log(`login-route: ${n} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
