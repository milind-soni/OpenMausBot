// Opt-in NETWORK smoke: official Node + Codex downloads in a disposable
// directory. No provider login, messages, live server, or global npm writes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { ensureManagedNode } from "../server/node-runtime.ts";

if (!process.argv.includes("--download")) throw new Error("Pass --download to verify real Node/Codex downloads in a disposable directory.");
const scratch = await mkdtemp(join(tmpdir(), "omb-clean-engine-"));
const base = join(scratch, "data");
const emptyPath = join(scratch, "empty-path");
await mkdir(emptyPath);
process.env.OMB_DATA_DIR = base;
try {
  const { installNpmEngine, enginesBinDir, registerEnginesBinDir } = await import("../server/engine-install.ts");
  const { resetPathCacheForTests, augmentedPath } = await import("../server/env-path.ts");
  const env: NodeJS.ProcessEnv = {
    PATH: emptyPath,
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: join(scratch, "appdata"),
    LOCALAPPDATA: join(scratch, "localappdata"),
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    TEMP: scratch,
    TMP: scratch,
    npm_config_cache: join(scratch, "cache"),
  };
  console.log("Installing Codex with an empty prerequisite PATH in", scratch);
  await installNpmEngine("@openai/codex", { baseDir: base, cli: "codex", path: emptyPath, env });
  const runtime = await ensureManagedNode(base);
  // Simulate process PATH registration at startup, not the install's cache.
  resetPathCacheForTests();
  registerEnginesBinDir(base);
  assert(augmentedPath().split(delimiter).includes(runtime.bin));
  // A second install exercises reuse, especially Windows npm.cmd avoidance.
  await installNpmEngine("@openai/codex", { baseDir: base, cli: "codex", path: emptyPath, env });
  const cli = join(enginesBinDir(base), process.platform === "win32" ? "node_modules/@openai/codex/bin/codex.js" : "../lib/node_modules/@openai/codex/bin/codex.js");
  const { stdout } = await promisify(execFile)(runtime.node, [cli, "--version"], {
    env: { ...env, PATH: [enginesBinDir(base), runtime.bin, emptyPath].join(delimiter) }, timeout: 30_000, windowsHide: true,
  });
  assert.match(stdout, /codex-cli \d/);
  console.log("PASS private prerequisite bootstrap, Codex install and update, startup PATH registration, CLI execution:", stdout.trim());
} finally {
  await rm(scratch, { recursive: true, force: true });
  console.log("Removed disposable installation:", scratch);
}
