// Stage betterwright (and the MCP SDK it serves with) beside the packaged
// app. The packaged app ships zero node_modules, so the browser integration
// resolves the CLI from Resources/betterwright instead; a plain `npm
// install --prefix` produces the complete dependency closure that a copy of
// the pnpm symlink forest would not.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = manifest.dependencies?.betterwright;
const sdkVersion = manifest.dependencies?.["@modelcontextprotocol/sdk"];
if (!version || !sdkVersion) throw new Error("betterwright and @modelcontextprotocol/sdk must be dependencies in package.json");

const finalDir = join(root, "dist-native", "betterwright");
rmSync(finalDir, { recursive: true, force: true });
mkdirSync(finalDir, { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(
  npm,
  ["install", "--prefix", finalDir, "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", `betterwright@${version}`, `@modelcontextprotocol/sdk@${sdkVersion}`],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (install.status !== 0) throw new Error(`npm install of betterwright@${version} failed`);

const cli = join(finalDir, "node_modules", "betterwright", "dist", "bin", "betterwright.js");
if (!existsSync(cli)) throw new Error(`staged betterwright has no CLI at ${cli}`);
const check = spawnSync(process.execPath, [cli, "mcp", "--check"], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
if (check.status !== 0) throw new Error("staged betterwright failed mcp --check");
console.log(`betterwright ${version} staged at ${finalDir}`);
