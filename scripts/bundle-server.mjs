// Bundle each harness-server entry point into a self-contained ESM file.
//
// Why this exists: the packaged app ships ZERO node_modules (see the files:
// exclusion in electron-builder.yml), so anything the server imports by bare
// specifier has to be inlined — `tsc` only transpiles, it leaves
// `import { z } from "zod"` verbatim and the packaged server dies at startup
// with ERR_MODULE_NOT_FOUND. That shipped once, in 0.1.24.
//
// Bundling every entry point rather than only index.ts is deliberate: the
// proxies are spawned as their own processes and today import nothing from
// node_modules, but nothing stops the next one from doing so, and the failure
// is invisible until a packaged build is actually launched.
//
// Entry points must keep their exact relative paths under dist-server — the
// server locates each proxy by path (server/index.ts:108,
// container-computer.ts:773, drivers/acp/core.ts:43), preferring the .ts in
// dev and falling back to the sibling .js in the packaged tree. outbase keeps
// drivers/ nested; import.meta.url still resolves to the same location, so
// that lookup is unaffected.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
let sourceSha = "unknown";
try {
  sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Source identity remains explicit when the build is made from an archive.
}

// Every file run as its own process. Keep in sync with the spawn sites above.
const ENTRY_POINTS = [
  "index.ts",
  // The packaged smoke probe imports this manifest directly. Importing the
  // shared avatar contract widens TypeScript's inferred emit root to the repo,
  // so tsc may place its copy under dist-server/server/. Bundle an explicit
  // root sibling to keep the packaged runtime contract stable. The Linux
  // package smoke probe also imports local-computer.js directly.
  "proxy-paths.ts",
  "local-computer.ts",
  "computer-proxy.ts",
  "container-mcp.ts",
  "vps-container-mcp.ts",
  "permission-proxy.ts",
  "connector-proxy.ts",
  "capability-proxy.ts",
  "credential-redacting-proxy.ts",
  "claude-api-key-helper.ts",
  "drivers/agents-proxy.ts",
  "drivers/dweb-proxy.ts",
  "drivers/phone-proxy.ts",
];

await build({
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outbase: server,
  outdir: join(root, "dist-server"),
  // Written after tsc, replacing its output for these entry points.
  allowOverwrite: true,
  define: { __OMB_SOURCE_SHA__: JSON.stringify(sourceSha) },
  logLevel: "info",
});

// The OpenTelemetry/Sentry dependency graph contains dynamic CommonJS
// requires. Keeping this one process as CJS avoids an ESM bundle that builds
// successfully and then fails immediately on `require("util")` at runtime.
await build({
  entryPoints: [join(server, "telemetry-sink.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(root, "dist-server", "telemetry-sink.cjs"),
  define: { __OMB_SOURCE_SHA__: JSON.stringify(sourceSha) },
  logLevel: "info",
});
await rm(join(root, "dist-server", "telemetry-sink.js"), { force: true });

// Windows cannot apply ELECTRON_RUN_AS_NODE to the packaged Helper with
// /usr/bin/env. The fixed launcher carries only bounded non-secret metadata;
// CredVault still injects provider values directly into its child environment.
await copyFile(
  join(server, "telemetry-node-launcher.cmd"),
  join(root, "dist-server", "telemetry-node-launcher.cmd"),
);
await copyFile(
  join(server, "credential-redacting-node-launcher.cmd"),
  join(root, "dist-server", "credential-redacting-node-launcher.cmd"),
);
