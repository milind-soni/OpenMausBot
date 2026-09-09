// Install an engine's command-line app from Settings, on the machine that
// runs this server, as this process's own user, into a directory the app
// owns. No sudo, no shell, no terminal: the package name comes from the
// driver's own install descriptor and never from a request, npm runs with
// a fixed argument list, and the binary is found on the engines' PATH
// afterwards because that directory is registered ahead of everything else.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EngineInstall } from "./contracts.ts";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCache } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** npm's global prefix for engines the app installs itself. */
export function enginesPrefix(baseDir = DATA_DIR): string {
  return join(baseDir, "tools", "npm");
}

/** Where that prefix puts executables: `bin/` on POSIX, the prefix itself on Windows. */
export function enginesBinDir(baseDir = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? enginesPrefix(baseDir) : join(enginesPrefix(baseDir), "bin");
}

/** Called once at boot: engines installed here win over any other copy on PATH. */
export function registerEnginesBinDir(baseDir = DATA_DIR): void {
  registerPathDir(enginesBinDir(baseDir));
}

/** The npm package a driver's own install one-liner names, when it is one. */
export function npmPackageOf(install: EngineInstall | undefined): string | null {
  const line = install?.command?.linux ?? install?.command?.darwin ?? install?.command?.win32;
  const match = line ? /^npm install -g ((?:@[\w.-]+\/)?[\w.-]+)$/.exec(line.trim()) : null;
  return match ? match[1]! : null;
}

export function npmAvailable(): boolean {
  return findCliCandidates("npm").length > 0;
}

/** What Settings may install for this engine on this machine, or null. A
 * managed engine keeps its own verified download; anything else needs a
 * plain npm package and npm on PATH. */
export function serverInstallFor(install: EngineInstall | undefined, npmPresent: boolean = npmAvailable()): { package: string } | null {
  if (!install || install.managed) return null;
  const pkg = npmPackageOf(install);
  return pkg && npmPresent ? { package: pkg } : null;
}

interface InstallOptions {
  baseDir?: string;
  /** The executable the package must provide; checked after installing. */
  cli?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** PATH for finding npm; the engines' augmented PATH by default. */
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
  // npm 11 skips a dependency's install script unless the package is named
  // here; the engines that need one (Claude Code) are exactly these.
  const args = ["install", "-g", "--prefix", prefix, "--loglevel=error", `--allow-scripts=${pkg}`, `${pkg}@latest`];
  const result = await runNpm(args, env, prefix, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(`npm could not install ${pkg} on this server.${tail(result.output)}`);
  }
  // Whatever the boot registration did, the directory we just filled must
  // be on the engines' PATH from here on.
  registerPathDir(enginesBinDir(options.baseDir));
  resetPathCache();
  if (options.cli) {
    const binDir = enginesBinDir(options.baseDir);
    if (!findCliCandidates(options.cli).some((path) => path.startsWith(binDir))) {
      throw new Error(`${pkg} installed, but it did not provide a \`${options.cli}\` command. Check the package name in this engine's install descriptor.`);
    }
  }
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
      void killCliTree(child);
    }, timeoutMs);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      rejectRun(new Error(error.code === "ENOENT"
        ? "npm is not installed on this server. Install Node.js with npm for the user running OpenMausBot, then try again."
        : "npm could not start on this server. Check that Node.js is installed for the user running OpenMausBot."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectRun(new Error("The install took too long and was stopped. Check the server's network connection and try again."));
        return;
      }
      resolveRun({ code, output });
    });
  });
}

/** True once something has been installed here, for status pages. */
export function enginesInstalled(baseDir = DATA_DIR): boolean {
  return existsSync(enginesBinDir(baseDir));
}
