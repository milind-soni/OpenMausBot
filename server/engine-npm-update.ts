// Updating an npm engine in the app's prefix without ever leaving it half-installed. npm installs the new version into a
// staging prefix beside the real one; its command must start there and name the version; then the package folder takes
// the old one's place by rename (same filesystem) and its commands are moved next to it. npm writes those commands with
// paths relative to the prefix (POSIX links into ../lib/node_modules, Windows shims through %~dp0), so they work from
// either prefix. The old folder waits aside until the moved copy has started again, and comes back on any failure.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { DATA_DIR } from "./config.ts";
import {
  enginesPrefix, npmBinIn, npmEnvironment, npmInstallArgs, npmModulesIn, NPM_INSTALL_TIMEOUT_MS, oneNpmRunPer, PROBE_TIMEOUT_MS, runNpm, tail,
} from "./engine-install.ts";
import { replaceFile } from "./engine-standalone.ts";
import { resetPathCache } from "./env-path.ts";
import { execCli } from "./procs.ts";

const STAGING_PREFIX = ".npm-staging-";
const ASIDE_PREFIX = ".npm-aside-";
const ASIDE_RECORD = "aside.json";
const ASIDE_PACKAGE = "package";

export interface StagedNpmUpdate {
  pkg: string;
  version: string;
  baseDir?: string;
  /** The command to check; the package's first command when it is not one of them. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Runs on the staged command once it has started, just before anything is replaced: a reason stops the update. */
  beforeSwitch?: (command: string) => Promise<string | null>;
  /** Tests only: the platform whose file locks apply, and the rename that meets them. */
  host?: { platform: NodeJS.Platform; rename: typeof rename };
}

/** The update was stopped before the switch because something still holds the engine; the old copy is untouched. */
export class EngineInUse extends Error {}

function toolsDir(baseDir: string): string {
  return dirname(enginesPrefix(baseDir));
}

function packageDir(prefix: string, pkg: string): string {
  return join(npmModulesIn(prefix), ...pkg.split("/"));
}

/** The commands a package declares, as npm names them. */
export function npmCommandNames(dir: string, pkg: string): string[] {
  try {
    const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { bin?: unknown };
    if (typeof bin === "string") return [basename(pkg)];
    return bin && typeof bin === "object" ? Object.keys(bin).filter((name) => /^[\w.-]+$/u.test(name)) : [];
  } catch {
    return [];
  }
}

/** What npm puts in its bin folder for one command: a link on POSIX, three shims on Windows. */
function commandEntries(name: string): string[] {
  return process.platform === "win32" ? [name, `${name}.cmd`, `${name}.ps1`] : [name];
}

function commandPath(prefix: string, name: string): string {
  return join(npmBinIn(prefix), process.platform === "win32" ? `${name}.cmd` : name);
}

/** Null when `<command> --version` exits cleanly and names `version`; otherwise what went wrong. */
export function versionFailure(command: string, version: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolveProbe) => {
    execCli(command, ["--version"], { env, timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const lines = stripVTControlCharacters(`${stdout}\n${stderr ?? ""}`).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      if (error) return resolveProbe((lines.find((line) => /^\w*Error: /u.test(line)) ?? lines[0] ?? error.message).slice(0, 400));
      if (!lines.some((line) => line.includes(version))) return resolveProbe(`it reported version ${(lines[0] ?? "nothing").slice(0, 80)}, not ${version}`);
      resolveProbe(null);
    });
  });
}

type SavedEntry = { path: string; link: string } | { path: string; data: Buffer } | { path: string; absent: true };

async function saveEntry(path: string): Promise<SavedEntry> {
  const info = await lstat(path).catch(() => null);
  if (!info) return { path, absent: true };
  return info.isSymbolicLink() ? { path, link: await readlink(path) } : { path, data: await readFile(path) };
}

async function restoreEntry(entry: SavedEntry): Promise<void> {
  await rm(entry.path, { force: true });
  if ("link" in entry) await symlink(entry.link, entry.path);
  else if ("data" in entry) await writeFile(entry.path, entry.data, { mode: 0o755 });
}

function lockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Moves the staged package and its commands into the live prefix, keeping the old ones aside until the moved command
 * starts; on Windows a folder holding a running program cannot be renamed, which stops the switch before it begins. */
async function switchIn(staging: string, pkg: string, version: string, command: string, env: NodeJS.ProcessEnv, baseDir: string, fs: { platform: NodeJS.Platform; rename: typeof rename }): Promise<void> {
  const prefix = enginesPrefix(baseDir);
  const live = packageDir(prefix, pkg);
  const aside = join(toolsDir(baseDir), `${ASIDE_PREFIX}${randomUUID()}`);
  const kept = join(aside, ASIDE_PACKAGE);
  await mkdir(dirname(live), { recursive: true });
  await mkdir(aside, { mode: 0o700 });
  await writeFile(join(aside, ASIDE_RECORD), `${JSON.stringify({ pkg })}\n`);
  const hadLive = existsSync(live);
  if (hadLive) {
    try {
      await fs.rename(live, kept);
    } catch (error) {
      await rm(aside, { recursive: true, force: true }).catch(() => {});
      if (fs.platform === "win32" && lockedError(error)) throw new EngineInUse(`${pkg} is still running`);
      throw error;
    }
  }
  const putBack = async () => {
    await rm(live, { recursive: true, force: true });
    if (hadLive) await fs.rename(kept, live);
  };
  try {
    await fs.rename(packageDir(staging, pkg), live);
  } catch (error) {
    if (!hadLive || await fs.rename(kept, live).then(() => true, () => false)) await rm(aside, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const saved: SavedEntry[] = [];
  try {
    await mkdir(npmBinIn(prefix), { recursive: true });
    for (const name of npmCommandNames(live, pkg)) {
      for (const entry of commandEntries(name)) {
        const from = join(npmBinIn(staging), entry);
        if (!(await lstat(from).catch(() => null))) continue;
        const to = join(npmBinIn(prefix), entry);
        saved.push(await saveEntry(to));
        await replaceFile(from, to);
      }
    }
    const failure = await versionFailure(commandPath(prefix, command), version, env);
    if (failure) throw new Error(`${pkg} ${version} did not start once in place: ${failure}`);
  } catch (error) {
    for (const entry of saved.reverse()) await restoreEntry(entry).catch(() => {});
    // Should putting it back fail, the old copy stays aside for the next sweep to restore.
    if (await putBack().then(() => true, () => false)) await rm(aside, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // A file Windows still holds goes at the next sweep.
  await rm(aside, { recursive: true, force: true }).catch(() => {});
}

/** Installs `pkg@version` beside the live copy, checks it, then switches. Any failure leaves the live copy as it was. */
export function updateNpmEngineStaged(options: StagedNpmUpdate): Promise<void> {
  const baseDir = options.baseDir ?? DATA_DIR;
  return oneNpmRunPer(options.pkg, baseDir, () => stagedOnce(options, baseDir));
}

async function stagedOnce(options: StagedNpmUpdate, baseDir: string): Promise<void> {
  const { pkg, version } = options;
  const env = npmEnvironment(options.env, undefined, undefined, baseDir);
  const staging = join(toolsDir(baseDir), `${STAGING_PREFIX}${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const result = await runNpm(npmInstallArgs(staging, pkg, version), env, staging, options.timeoutMs ?? NPM_INSTALL_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`npm could not install ${pkg} ${version}.${tail(result.output)}`);
    const names = npmCommandNames(packageDir(staging, pkg), pkg);
    const command = options.cli && names.includes(options.cli) ? options.cli : names[0];
    if (!command) throw new Error(`${pkg} ${version} has no command to run.`);
    const failure = await versionFailure(commandPath(staging, command), version, env)
      ?? await options.beforeSwitch?.(commandPath(staging, command)) ?? null;
    if (failure) throw new Error(`${pkg} ${version} does not start: ${failure}`);
    await switchIn(staging, pkg, version, command, env, baseDir, options.host ?? { platform: process.platform, rename });
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
}

/** Removes an npm copy the app no longer uses: its commands that lead into it, then its folder. */
export async function removeNpmCopy(pkg: string, baseDir = DATA_DIR): Promise<void> {
  const prefix = enginesPrefix(baseDir);
  const live = packageDir(prefix, pkg);
  if (!existsSync(live)) return;
  const names = npmCommandNames(live, pkg);
  const aside = join(toolsDir(baseDir), `${ASIDE_PREFIX}${randomUUID()}`);
  await mkdir(aside, { mode: 0o700 });
  try {
    await rename(live, join(aside, ASIDE_PACKAGE));
  } catch (error) {
    await rm(aside, { recursive: true, force: true }).catch(() => {});
    if (process.platform === "win32" && lockedError(error)) throw new EngineInUse(`${pkg} is still running`);
    throw error;
  }
  const separator = process.platform === "win32" ? "\\" : "/";
  const marker = ["node_modules", ...pkg.split("/"), ""].join(separator);
  for (const name of names) {
    for (const entry of commandEntries(name)) {
      const path = join(npmBinIn(prefix), entry);
      const saved = await saveEntry(path).catch(() => null);
      const target = saved && "link" in saved ? saved.link : saved && "data" in saved ? saved.data.toString("utf8") : "";
      if (target.includes(marker)) await unlink(path).catch(() => {});
    }
  }
  resetPathCache();
  await rm(aside, { recursive: true, force: true }).catch(() => {});
}

/** An interrupted switch leaves the old folder aside with nothing in its place: it goes back. Staging folders and
 * anything else aside are removed. */
export async function sweepNpmLeftovers(baseDir = DATA_DIR): Promise<void> {
  const tools = toolsDir(baseDir);
  let names: string[];
  try {
    names = readdirSync(tools);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(tools, name);
    if (name.startsWith(ASIDE_PREFIX)) {
      try {
        const { pkg } = JSON.parse(readFileSync(join(path, ASIDE_RECORD), "utf8")) as { pkg?: unknown };
        const live = typeof pkg === "string" ? packageDir(enginesPrefix(baseDir), pkg) : null;
        if (live && !existsSync(live) && existsSync(join(path, ASIDE_PACKAGE))) {
          await mkdir(dirname(live), { recursive: true });
          await rename(join(path, ASIDE_PACKAGE), live);
        }
      } catch {}
    } else if (!name.startsWith(STAGING_PREFIX)) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
