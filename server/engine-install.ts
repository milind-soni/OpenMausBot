// No sudo, no shell, no terminal: the package name comes from the driver's own install descriptor, never a request, and
// npm runs with a fixed argument list as this process's user into an app-owned prefix.
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EngineInstall, StandaloneRelease } from "./contracts.ts";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "./config.ts";
import { npmEnginesPrefix } from "./engine-roots.ts";
import { registerStandaloneBinDirs, standaloneAssetFor, standaloneRunEnv } from "./engine-standalone.ts";
import { STANDALONE_RELEASES } from "./standalone-releases.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCache } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 30_000;

export function enginesPrefix(baseDir = DATA_DIR): string {
  return npmEnginesPrefix(baseDir);
}

/** Where that prefix puts executables: `bin/` on POSIX, the prefix itself on Windows. */
export function enginesBinDir(baseDir = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? enginesPrefix(baseDir) : join(enginesPrefix(baseDir), "bin");
}

/** Called once at boot: engines npm installed here win over any other copy on PATH. A standalone build the app installed
 * goes last instead, so a copy the person installs themselves takes over. */
export function registerEnginesBinDir(baseDir = DATA_DIR, releases: readonly StandaloneRelease[] = STANDALONE_RELEASES): void {
  registerPathDir(enginesBinDir(baseDir));
  registerStandaloneBinDirs(baseDir, releases);
}

/** For an engine the app can install as its own build: the copy npm put in the app's folder (before that build existed)
 * ranks last, behind the person's PATH and the app's own build. */
export function standaloneEnginePath(path: string, baseDir = DATA_DIR): string {
  const npm = enginesBinDir(baseDir);
  const parts = path.split(delimiter);
  return parts.includes(npm) ? [...parts.filter((part) => part !== npm), npm].join(delimiter) : path;
}

/** The PATH such an engine's CLI is looked up on when it is spawned. Windows picks a spawn's program from the app's PATH
 * whatever the child's PATH says, so there it stays the app's. */
export function standaloneLookupPath(baseDir = DATA_DIR, path: string = augmentedPath()): string {
  return process.platform === "win32" ? path : standaloneEnginePath(path, baseDir);
}

/** A spawn environment for an engine with a standalone release: the npm folder last on its PATH, and the release's run
 * settings when its CLI is the app's own copy. */
export function applyStandaloneSpawnEnv(release: StandaloneRelease, env: Record<string, string | undefined>, cli: string, baseDir = DATA_DIR): void {
  const path = env.PATH ?? augmentedPath();
  env.PATH = standaloneEnginePath(path, baseDir);
  Object.assign(env, standaloneRunEnv(release, cli, baseDir, standaloneLookupPath(baseDir, path)));
}

export function npmPackageOf(install: EngineInstall | undefined): string | null {
  const line = install?.command?.linux ?? install?.command?.darwin ?? install?.command?.win32;
  const match = line ? /^npm install -g ((?:@[\w.-]+\/)?[\w.-]+)$/.exec(line.trim()) : null;
  return match ? match[1]! : null;
}

export function npmAvailable(): boolean {
  return findCliCandidates("npm").length > 0;
}

export type ServerInstall = NonNullable<EngineInstall["server"]>;

/** The vendor's own build when it has one for this platform (no Node.js needed), otherwise npm when npm is here. With a
 * standalone build, `package` says npm is here too, so the client can still offer the npm command for a terminal. */
export function serverInstallFor(install: EngineInstall | undefined, npmPresent: boolean = npmAvailable()): ServerInstall | null {
  if (!install || install.managed) return null;
  const asset = standaloneAssetFor(install.standalone);
  const pkg = npmPresent ? npmPackageOf(install) : null;
  if (install.standalone && asset) {
    return { standalone: { version: install.standalone.version, downloadBytes: asset.approxBytes }, ...(pkg ? { package: pkg } : {}) };
  }
  return pkg ? { package: pkg } : null;
}

interface InstallOptions {
  baseDir?: string;
  cli?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  path?: string;
}

const running = new Map<string, Promise<void>>();

/** Install or update one npm engine. Concurrent clicks share one npm run. */
export function installNpmEngine(pkg: string, options: InstallOptions = {}): Promise<void> {
  const key = `${options.baseDir ?? DATA_DIR} ${pkg}`;
  const existing = running.get(key);
  if (existing) return existing;
  const run = installOnce(pkg, options).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function installOnce(pkg: string, options: InstallOptions): Promise<void> {
  const prefix = enginesPrefix(options.baseDir);
  mkdirSync(prefix, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    PATH: options.path ?? augmentedPath(),
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  // Workspace credentials (xai/box/voice keys) are not npm's to see.
  stripWorkspaceCredentialEnv(env as Record<string, string | undefined>);
  // npm 11 skips a dependency's install script unless the package is named here (Claude Code needs one), and Codex ships
  // its native binary as a platform optional dependency, which a user-level `omit=optional` must not drop.
  const args = ["install", "-g", "--prefix", prefix, "--loglevel=error", "--include=optional", `--allow-scripts=${pkg}`, `${pkg}@latest`];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await runInstall(pkg, args, env, prefix, timeoutMs);
  const binDir = enginesBinDir(options.baseDir);
  registerPathDir(binDir);
  resetPathCache();
  if (!options.cli) return;
  const installed = findCliCandidates(options.cli).find((path) => path.startsWith(binDir));
  if (!installed) {
    throw new Error(`${pkg} installed, but it did not provide a \`${options.cli}\` command. Check the package name in this engine's install descriptor.`);
  }
  // npm exits 0 even after dropping an optional dependency it failed to download, so prove the CLI starts; a second run fetches it.
  let failure = await probeCli(installed, env);
  if (failure === null) return;
  await runInstall(pkg, args, env, prefix, timeoutMs);
  failure = await probeCli(installed, env);
  if (failure === null) return;
  throw new Error(`npm installed ${pkg}, but \`${options.cli}\` does not start: ${failure}\nnpm can leave out a platform package when its download fails, even after a retry. Check this server's network connection, then install again from Settings.`);
}

async function runInstall(pkg: string, args: string[], env: NodeJS.ProcessEnv, prefix: string, timeoutMs: number): Promise<void> {
  const result = await runNpm(args, env, prefix, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`npm could not install ${pkg} on this server.${tail(result.output)}`);
  }
}

/** A throwing Node launcher prints its source line first, so its `Error:` line is the one worth showing. */
function probeCli(cli: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolveProbe) => {
    execCli(cli, ["--version"], { env: { ...env, PATH: augmentedPath() }, timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (!error) return resolveProbe(null);
      const lines = stripVTControlCharacters(`${stderr ?? ""}\n${stdout}`).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const said = lines.find((line) => /^\w*Error: /.test(line)) ?? lines[0] ?? error.message;
      resolveProbe(said.slice(0, 400));
    });
  });
}

function tail(output: string): string {
  const clean = stripVTControlCharacters(output).trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/).filter((line) => line.trim()).slice(-6);
  return `\n${lines.join("\n").slice(-600)}`;
}

function runNpm(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli("npm", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectRun(new Error("npm could not start on this server. Install Node.js with npm for the user running OpenMausBot, then try again."));
      return;
    }
    child.stdin.end();
    let output = "";
    const receive = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killCliTree(child).then((stopped) => {
        rejectRun(new Error(stopped
          ? "The install took too long and was stopped. Check the server's network connection and try again."
          : "The install took too long, but npm could not be confirmed stopped. Ask the server administrator to stop the install process before trying again."));
      });
    }, timeoutMs);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (timedOut) return;
      clearTimeout(timer);
      rejectRun(new Error(error.code === "ENOENT"
        ? "npm is not installed on this server. Install Node.js with npm for the user running OpenMausBot, then try again."
        : "npm could not start on this server. Check that Node.js is installed for the user running OpenMausBot."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolveRun({ code, output });
    });
  });
}
