/**
 * @purpose Assertions for local-db.ts: the local-check harnesses refuse every non-loopback database, including URLs that
 * smuggle "@localhost" into a path or query (codex pass 7 on #193). Run with: npx tsx planner/src/local-db.test.ts
 */
import assert from "node:assert/strict";
import { assertLocalDatabaseUrl } from "./local-db";

for (const ok of ["postgres://localhost:5432/a2w_local", "postgres://u@localhost/x", "postgresql://127.0.0.1:5432/x", "postgres://[::1]:5432/x", "postgres:///x?host=/tmp"]) {
  assert.ok(assertLocalDatabaseUrl(ok), ok);
}
for (const bad of [
  "postgres://db.example/a2w?application_name=@localhost/check",
  "postgres://localhost:5432/x?host=db.example",
  "postgres://db.example/@localhost/",
  "postgres://localhost.evil.com/x",
  "postgres://user:pw@prod.railway.internal:5432/railway",
  "postgres:///x",
  "mysql://localhost/x",
  "",
]) assert.throws(() => assertLocalDatabaseUrl(bad), undefined, `refused: ${bad}`);
console.log("local-db.test.ts: all assertions passed");
