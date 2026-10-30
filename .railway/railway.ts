// @purpose Railway Infrastructure-as-Code for the a2w-hub project: the build, start, restart and
// watch-pattern settings of a2w-planner and a2w-hub, replacing planner/railway.toml and
// hub/railway.toml before Railway stops reading those on 2026-12-01 (#164).
//
// HOW THIS DIFFERS FROM railway.toml -- read before editing:
// - Railway does NOT read this file during deploys. Nothing changes on a merge. It takes effect
//   only when someone runs `railway config apply`, which writes these values into the services'
//   own settings. Always run `railway config plan` first and read the diff. Both act on the LINKED
//   project, so run them from a directory linked to a2w-hub, for example:
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
// - While a railway.toml still exists, it overrides these values at deploy time. Keep the two
//   identical until the toml files are deleted. scripts/drift-check.sh [11] asserts this.
//
// Watch patterns. Without them every push to main redeploys both services, docs included, and
// each planner redeploy is a writer-lease handover on live heating. Both spellings are kept
// deliberately (the reasoning is in the toml comments). Railway's docs say patterns are matched
// from the repo root, which makes "planner/**" the live one, and deploy history agrees. The bare
// root-dir-relative spellings are a hedge against that being wrong: an extra restart is
// harmless, a missed deploy of a real fix is not. "railway.toml" stays until the toml files are
// deleted, so this list is the same as theirs.
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
