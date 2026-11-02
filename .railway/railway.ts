// @purpose Railway Infrastructure-as-Code for the a2w-hub project: the build, start, restart and
// watch-pattern settings of a2w-planner and a2w-hub. It replaced planner/railway.toml and
// hub/railway.toml, which Railway stops reading on 2026-12-01 (#164): the values were written
// into the live services with `railway config apply` on 2026-11-02 and the toml files were
// deleted after that. Deploys now read the service settings; this file is their declared source.
//
// HOW THIS DIFFERS FROM the old railway.toml -- read before editing:
// - Railway does NOT read this file during deploys. Nothing changes on a merge. It takes effect
//   only when someone runs `railway config apply`, which writes these values into the services'
//   own settings and REDEPLOYS BOTH SERVICES (observed 2026-11-02). Always run
//   `railway config plan` first and read the diff. Both act on the LINKED project, so run them
//   from a directory linked to a2w-hub, for example:
//   `cd planner && railway config plan --file ../.railway/railway.ts`.
// - It is ONE file for the WHOLE project, and an apply deletes anything it does not declare. A
//   file declaring only the planner planned "Delete service a2w-hub" and "Delete database
//   Postgres" (checked 2026-10-29). That is why there is no per-service planner/.railway/.
//   Postgres and its volume are declared below only so that they are kept. Do not edit them here.
// - `variables: { managed: false }` keeps the 46 service variables (tokens, keys, gates) out of
//   this file's ownership. Without it the plan refuses to run, because no variables are declared.
// - Evaluating this file needs the `railway` SDK, pinned in .railway/package.json. Run
//   `npm ci --prefix .railway` once before plan/apply. Railway's build never sees it: the services'
//   root directories are /planner and /hub.
// - scripts/drift-check.sh [11] asserts that this file declares these values, and (with a
//   logged-in railway CLI) that the newest built deployment of each service ran with them from
//   the service settings. Keep it green: an unapplied edit here is drift the services never see.
//
// Watch patterns. Without them every push to main redeploys both services, docs included, and
// each planner redeploy is a writer-lease handover on live heating. CI's paths-ignore does NOT
// apply to Railway; the patterns are the only thing that stops it.
// Both spellings are listed deliberately. The service root directories are /planner and /hub,
// and it is ambiguous whether Railway matches the patterns against the repo root or the root
// directory. Railway's docs say the repo root, which makes "planner/**" the live one, and deploy
// history agrees; the bare root-dir-relative spellings are a hedge against that being wrong. A
// pattern that is wrong under the live interpretation would SILENTLY STOP DEPLOYING real fixes,
// which is far worse than a harmless extra restart. Listing both makes the set correct either
// way: under repo-root matching "planner/**" fires and the bare paths never match (there is no
// root-level package.json); under root-dir matching the bare paths fire instead.
// Narrowing to the service directory is safe: planner/src and hub/src have ZERO parent-escaping
// imports and no file:/workspace: deps, so nothing outside planner/ (hub/) can change that
// service's build output.
import { defineRailway, github, postgres, project, service, volume } from "railway/iac";

// Both services build and run the same way. Only the root directory and watch patterns differ.
const nodeService = (name: string, rootDirectory: string, watchPatterns: string[]) =>
  service(name, {
    source: github("ckrohg/a2w-control", { branch: "main", checkSuites: false, rootDirectory }),
    build: {
      builder: "NIXPACKS",
      buildCommand: "npm install && npm run build",
      watchPatterns,
    },
    deploy: {
      startCommand: "npm start",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    replicas: { "us-west2": 1 },
  });

export default defineRailway(() => {
  // Keep each list on ONE line: scripts/drift-check.sh [11] reads them with grep.
  // "railway.toml" is inert now that the files are gone; it stays so the lists equal the live settings and no apply is needed.
  const a2wPlanner = nodeService("a2w-planner", "/planner",
    ["planner/**", "src/**", "package.json", "package-lock.json", "tsconfig.json", "railway.toml"]);
  const a2wHub = nodeService("a2w-hub", "/hub",
    ["hub/**", "src/**", "package.json", "package-lock.json", "tsconfig.json", "railway.toml"]);

  // Declared so an apply KEEPS them. As imported by `railway config migrate`; the plan shows no change to either.
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 50000,
  });

  return project("a2w-hub", {
    // The CLI engine (5.71) honours this and the plan reports "variables: unmanaged", but SDK 3.16.0's types
    // do not declare it. Remove the directive once tsc stops flagging the line.
    // @ts-expect-error -- see above
    variables: { managed: false },
    resources: [a2wPlanner, a2wHub, Postgres, postgresVolume],
  });
});
