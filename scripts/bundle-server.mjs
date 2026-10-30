// Bundles each harness-server entry point into a self-contained ESM file: the
// packaged app ships no node_modules. Entry points keep their exact relative
// paths under dist-server, where the server locates each proxy by path.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// yaml's Node export is CommonJS with dynamic requires that cannot run once
// inlined into ESM; its browser export is the same parser without them.
const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

// ws is CommonJS and requires Node's own modules, which an ESM bundle reaches
// only through a require of its own (esbuild otherwise throws "Dynamic require
// of "events" is not supported" when it loads).
const NODE_REQUIRE = {
  js: 'import { createRequire as __ombCreateRequire } from "node:module";\nconst require = __ombCreateRequire(import.meta.url);',
};

// Every file run as its own process.
const ENTRY_POINTS = [
  "index.ts",
  "message-search.worker.ts",
  // the `openmausbot` command
  "openmausbot.ts",
  "pair-cli.ts",
  "workspace-backup.worker.ts",
  // the OMB Cloud Pro home image's entry point
  "cloud-home-start.ts",
  // the container image's entry point
  "server-launcher.ts",
  // Imported directly by the packaged smoke probes. An explicit root sibling,
  // because tsc may emit its own copy under dist-server/server/.
  "proxy-paths.ts",
  "local-computer.ts",
  "local-computer-proxy.ts",
  // the hook helper Claude Code runs at PostToolUse/PreCompact/SessionStart/Stop
  "hooks/omb-hook.ts",
  "container-mcp.ts",
  "vps-container-mcp.ts",
  "permission-proxy.ts",
  "connector-proxy.ts",
  "mcp-gate.ts",
  "mcp-remote-proxy.ts",
  "harness-mcp-proxy.ts",
  "drivers/agents-proxy.ts",
  "drivers/dweb-proxy.ts",
  "drivers/phone-proxy.ts",
  // the bot box (server/bot-box): the in-box bridge, the probe the self-check runs inside a box, and the check by hand
  "bot-box/box-bridge.ts",
  "bot-box/box-probe.ts",
  "bot-box/box-check.ts",
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
  banner: NODE_REQUIRE,
});

// External MCP clients launch this as an independent stdio process, so release
// users need no repository, TypeScript, pnpm or node_modules.
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

// `openmausbot serve --tunnel` spawns the connector guardian as its own
// process, so it must exist as a file beside the server.
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

// Runs itself when executed directly, so it must never be inlined into another
// entry.
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

// The enterprise layer (enterprise/LICENSE; delete the folder for pure OSS).
// Shipped bundled to dist-server/enterprise/server/index.js, where the server
// finds it; its own license travels with it.
if (existsSync(join(root, "enterprise", "server", "index.ts"))) {
  await build({
    entryPoints: [join(root, "enterprise", "server", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(root, "dist-server", "enterprise", "server", "index.js"),
    allowOverwrite: true,
    logLevel: "info",
  });
  copyFileSync(join(root, "enterprise", "LICENSE"), join(root, "dist-server", "enterprise", "LICENSE"));
}

// The packaged desktop forks this bootstrap to turn on Node's compile cache.
// Copied, not bundled: esbuild would inline index.js into it.
copyFileSync(join(root, "scripts", "desktop-server-entry.mjs"), join(root, "dist-server", "desktop-entry.mjs"));

// The model catalog snapshot (server/model-catalog/catalog.ts) is read from
// disk, not inlined: 1.5 MB of JSON has no place in index.js. The bundle looks
// for it under model-catalog/ beside itself. Its MIT notice is inside the file.
const catalogSnapshot = join(root, "dist-server", "model-catalog", "models-dev.snapshot.json");
mkdirSync(dirname(catalogSnapshot), { recursive: true });
copyFileSync(join(server, "model-catalog", "models-dev.snapshot.json"), catalogSnapshot);

// Pi loads this through its own jiti and supplies TypeBox. Inline our local
// policy module so the extension also works without the source checkout;
// keep the Pi-owned dependency external and retain the .ts loading contract.
const piMcpExtSrc = join(server, "drivers", "pi-mcp-extension.ts");
const piMcpExtDest = join(root, "dist-server", "drivers", "pi-mcp-extension.ts");
mkdirSync(dirname(piMcpExtDest), { recursive: true });
await build({ entryPoints: [piMcpExtSrc], outfile: piMcpExtDest, bundle: true,
  platform: "node", target: "node24", format: "esm", external: ["typebox"], });

// Desktop resources live outside app.asar, so its package.json cannot mark
// these .js bundles as ESM. Do not inherit a user's CommonJS package scope.
// The version rides along: an image ships dist-server without the root
// package.json, and the server reports this one (server/environment.ts).
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(root, "dist-server", "package.json"), `${JSON.stringify({ type: "module", version })}\n`);
