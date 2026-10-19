/**
 * @purpose Guard for the scripts/*-local-check.ts harnesses (they DROP / TRUNCATE tables): the connection string must
 * resolve — the way node-postgres itself resolves it (pg-connection-string, query `host=` overrides included) — to a
 * loopback host or a local unix socket. A regex on the raw URL was fooled by `@localhost` in a path or query
 * (codex pass 7 on #193: `postgres://db.example/a2w?application_name=@localhost/check` is db.example).
 */
import { parse } from "pg-connection-string";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The effective host when it is local; otherwise throws with the reason. */
export function assertLocalDatabaseUrl(url: string): string {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("not a postgres:// URL");
  const cfg = parse(url);
  const host = cfg.host ?? "";
  if (!host) throw new Error("no host in the URL (PGHOST would decide) — name localhost explicitly");
  if (host.startsWith("/")) return host; // a unix socket directory is local by construction
  if (!LOOPBACK.has(host.toLowerCase())) throw new Error(`host is ${host}, not a loopback address`);
  return host;
}
