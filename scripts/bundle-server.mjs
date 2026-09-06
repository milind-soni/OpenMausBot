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
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// yaml's Node export is CommonJS and contains dynamic requires that cannot run
// after it is inlined into our ESM-only packaged server. Its browser export is
// the same pure-JS parser without those Node shims, so resolve only this package
// to that entry while leaving every other dependency on the Node condition.
const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

// Every file run as its own process. Keep in sync with the spawn sites above.
const ENTRY_POINTS = [
  "index.ts",
  // the `openmausbot` command (serve/pair/sessions/status) for the npm
  // package, the container image and checkouts; pair-cli.ts stays as an alias
  "openmausbot.ts",
  "pair-cli.ts",
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
  logLevel: "info",
  plugins: [yamlEsmPlugin],
});

// External MCP clients launch this as an independent stdio process. Keep its
// source under scripts for a pleasant checkout command (`pnpm mcp`), but ship
// the bundled output beside the packaged harness so release users do not need
// the repository, TypeScript, pnpm, or node_modules.
await build({
  entryPoints: [join(root, "scripts", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "mcp-server.js"),
  allowOverwrite: true,
  logLevel: "info",
});

// `openmausbot serve --tunnel` (server/tunnel.ts) spawns the connector guardian
// as its own process, so it has to exist as a file beside the server, not only
// as code inlined into the bundle that imports its neighbours. Bundled under
// its own name: the same code the desktop app runs from
// electron/managed-companion-guardian-main.mjs, so a fix lands in both.
await build({
  entryPoints: [join(root, "electron", "managed-companion-guardian-main.mjs")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "tunnel-guardian.js"),
  allowOverwrite: true,
  logLevel: "info",
});

// `serve --tunnel` downloads cloudflared on first use by running the same
// pinned-digest script the release build uses, as its own process (it runs
// itself when executed directly, so it must never be inlined into another
// entry).
await build({
  entryPoints: [join(root, "scripts", "prepare-cloudflared.mjs")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "prepare-cloudflared.js"),
  allowOverwrite: true,
  logLevel: "info",
});

// pi-mcp-extension.ts is NOT an OpenMausBot entry point: it is loaded by the
// external `pi` process (pi's own jiti), which resolves its
// @earendil-works/pi-coding-agent and typebox imports from pi's install. Ship
// it verbatim as .ts so the packaged app has it too — never bundle it, or
// esbuild would inline pi's packages and the extension would stop loading.
const piMcpExtSrc = join(server, "drivers", "pi-mcp-extension.ts");
const piMcpExtDest = join(root, "dist-server", "drivers", "pi-mcp-extension.ts");
mkdirSync(dirname(piMcpExtDest), { recursive: true });
copyFileSync(piMcpExtSrc, piMcpExtDest);
