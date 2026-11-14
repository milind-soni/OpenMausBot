// No sudo, no shell, no terminal: the package name comes from the driver's own install descriptor, never a request, and
// npm runs with a fixed argument list as this process's user into an app-owned prefix.
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EngineInstall, StandaloneRelease } from "./contracts.ts";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "./config.ts";
import { npmEnginesPrefix } from "./engine-roots.ts";
import { registerStandaloneBinDirs, standaloneAssetFor, standaloneRunEnv } from "./engine-standalone.ts";
import { STANDALONE_RELEASES } from "./standalone-releases.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCache } from "./env-path.ts";
import { botBox } from "./bot-box/box.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";

const MAX_OUTPUT = 64 * 1024;
export const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 30_000;

export function enginesPrefix(baseDir = DATA_DIR): string {
  return npmEnginesPrefix(baseDir);
}

/** Where that prefix puts executables: `bin/` on POSIX, the prefix itself on Windows. */
export function enginesBinDir(baseDir = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? enginesPrefix(baseDir) : join(enginesPrefix(baseDir), "bin");
}

/** Where `npm install -g --prefix` puts packages: `lib/node_modules` on POSIX, `node_modules` on Windows. */
export function npmModulesIn(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
}

export function npmBinIn(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? prefix : join(prefix, "bin");
}

/** The version of `pkg` npm installed into the app's prefix, null when it has none there. */
export function npmCopyVersion(pkg: string, baseDir = DATA_DIR): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(npmModulesIn(enginesPrefix(baseDir)), ...pkg.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
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
  if (install?.npmPackage) return install.npmPackage;
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
  /** An exact version; npm's `latest` tag when omitted. */
  version?: string;
  cli?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  path?: string;
}

const running = new Map<string, Promise<void>>();

/** Install or update one npm engine. Concurrent clicks share one npm run. */
export function installNpmEngine(pkg: string, options: InstallOptions = {}): Promise<void> {
  return oneNpmRunPer(pkg, options.baseDir, () => installOnce(pkg, options));
}

/** Installs and updates of one package in one prefix never overlap: a second caller joins the run in flight. */
export function oneNpmRunPer(pkg: string, baseDir: string | undefined, start: () => Promise<void>): Promise<void> {
  const key = `${baseDir ?? DATA_DIR} ${pkg}`;
  const existing = running.get(key);
  if (existing) return existing;
  const run = start().finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

export function npmRunning(pkg: string, baseDir = DATA_DIR): boolean {
  return running.has(`${baseDir} ${pkg}`);
}

/** npm's own HOME, config files and cache in the data folder, which no boxed bot can write. */
export function npmServerHome(baseDir = DATA_DIR): { home: string; userconfig: string; globalconfig: string; cache: string } {
  const home = join(baseDir, "tools", "npm-home");
  return { home, userconfig: join(home, ".npmrc"), globalconfig: join(home, "npmrc-global"), cache: join(home, "cache") };
}

/** Security: while the bot box is on (`boxed`), a boxed bot can write the server's HOME, so npm, the install scripts it
 * runs and the CLI checked after it never read a config, a cache or anything else from there: `script-shell`, a
 * registry or a cached package a bot left would otherwise run, or be installed, outside the box. */
export function npmEnvironment(base: NodeJS.ProcessEnv = process.env, path: string = augmentedPath(), boxed = botBox.enabled(), baseDir = DATA_DIR): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: path,
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  // Workspace credentials (xai/box/voice keys) are not npm's to see.
  stripWorkspaceCredentialEnv(env as Record<string, string | undefined>);
  if (boxed) {
    const own = npmServerHome(baseDir);
    mkdirSync(own.cache, { recursive: true, mode: 0o700 });
    for (const name of Object.keys(env)) if (/^npm_config_(?:userconfig|globalconfig|cache|script_shell)$/i.test(name)) delete env[name];
    Object.assign(env, { HOME: own.home, npm_config_userconfig: own.userconfig, npm_config_globalconfig: own.globalconfig, npm_config_cache: own.cache });
  }
  return env;
}

/** npm 11 skips a dependency's install script unless the package is named here (Claude Code needs one), and Codex ships
 * its native binary as a platform optional dependency, which a user-level `omit=optional` must not drop. */
export function npmInstallArgs(prefix: string, pkg: string, version = "latest"): string[] {
  return ["install", "-g", "--prefix", prefix, "--loglevel=error", "--include=optional", `--allow-scripts=${pkg}`, `${pkg}@${version}`];
}

/** The version npm's `latest` tag names for `pkg` now. */
export async function npmLatestVersion(pkg: string, baseDir = DATA_DIR): Promise<string> {
  const prefix = enginesPrefix(baseDir);
  mkdirSync(prefix, { recursive: true });
  const result = await runNpm(["view", `${pkg}@latest`, "version", "--loglevel=error"], npmEnvironment(process.env, augmentedPath(), botBox.enabled(), baseDir), prefix, PROBE_TIMEOUT_MS * 2);
  const version = stripVTControlCharacters(result.output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (result.code !== 0 || !version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new Error(`npm could not look up the newest ${pkg}.${tail(result.output)}`);
  }
  return version;
}

async function installOnce(pkg: string, options: InstallOptions): Promise<void> {
  const prefix = enginesPrefix(options.baseDir);
  mkdirSync(prefix, { recursive: true });
  const env = npmEnvironment(options.env, options.path, botBox.enabled(), options.baseDir);
  const args = npmInstallArgs(prefix, pkg, options.version);
  const timeoutMs = options.timeoutMs ?? NPM_INSTALL_TIMEOUT_MS;
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

export function tail(output: string): string {
  const clean = stripVTControlCharacters(output).trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/).filter((line) => line.trim()).slice(-6);
  return `\n${lines.join("\n").slice(-600)}`;
}

export function runNpm(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
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
