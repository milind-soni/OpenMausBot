// Finding the Antigravity runtime to start, and installing Google's releases of it.
//
// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/AntigravityInstallation.ts:57, 311-345, 922-966,
//     985-999 (a CLI needs no harness sibling, the hourly look at the channel,
//     and keeping an installed CLI that is newer than the channel's).
// Each account's CLI path chooses its runtime: `antigravity` the native CLI (what Switch to Google Antigravity CLI in
// Settings saves, one way), `agy_acp_server` the pinned runtime (kept for configurations that already name it). With neither, a computer that has the pinned runtime keeps it and a new install takes the CLI, with the
// pinned runtime as the fallback where the channel has no build or cannot be reached; OMB_ANTIGRAVITY_NATIVE_CLI=1 gives
// such an account the CLI even where the pinned runtime is installed. Nothing removes the pinned runtime. A saved `agy`
// path is never started.
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { execFile } from "node:child_process";

import { DATA_DIR, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, stripControlPlaneEnv } from "../config.ts";
import { liveCliCommands, outsideBoxOptions } from "../procs.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { extractZipMember, readZipDirectory } from "../zip-archive.ts";
import { augmentedPath } from "../env-path.ts";
import { writeFileAtomic } from "../atomic.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";
import { parseVersionTriple, versionAtLeast } from "./acp/version-probe.ts";
import {
  ANTIGRAVITY_CLI_FIRST,
  ANTIGRAVITY_NATIVE_CLI,
  activeAntigravityCli,
  antigravityNativeByDefault,
  installAntigravityCli,
  isAntigravityCliName,
  pruneAntigravityCliReleases,
} from "./antigravity-cli-install.ts";
import { antigravityCliTarget, latestAntigravityCliRelease, type AntigravityCliReleaseAsset } from "./antigravity-cli-release.ts";

const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const STAGING_PREFIX = ".install-";

/** Windows refuses to rename or delete a held file with EPERM/EBUSY/EACCES, not "in use" (a just-stopped runtime, an antivirus scan). */
export function transientWindowsFileError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Which errors are worth another try; Windows file locks by default. */
  retryable?: (error: unknown) => boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function retryOnWindowsFileLock<T>(step: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 8;
  const sleep = options.sleep ?? wait;
  const retryable = options.retryable ?? transientWindowsFileError;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await sleep(Math.min(2_000, (options.delayMs ?? 250) * 2 ** (attempt - 1)));
    }
  }
}

const INSTALL_RECORD = ".install-complete.json";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CLI_VERSION_PROBE_MS = 5_000;

export interface AntigravityRuntime {
  executablePath: string;
  /** Null for the native CLI, which embeds the harness and runs as `agy acp`. */
  harnessPath: string | null;
  source: "managed" | "override" | "path";
  version: string | null;
}

export class AntigravitySetupError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AntigravitySetupError";
  }
}

interface InstallRecord {
  sha256: string;
  version: string;
  executable: { name: string; bytes: number };
  harness: { name: string; bytes: number };
}

export interface AntigravityInstallOptions {
  baseDir?: string;
  /** Naming a pinned release installs exactly that one, with no look at the native CLI's channel. */
  asset?: AntigravityReleaseAsset | null;
  /** The engine's CLI path asks for the native CLI: install it or fail, with no pinned runtime in its place. */
  native?: boolean;
  /** Whether a configuration that names no CLI runs the native one; the platform's own rule when unset. */
  nativeByDefault?: boolean;
  /** The native CLI release to install, instead of asking Google's channel. */
  cliRelease?: AntigravityCliReleaseAsset | null;
  fetchImpl?: typeof fetch;
  validate?: (runtime: AntigravityRuntime, expectedVersion: string) => Promise<void>;
}

const installs = new Map<string, Promise<AntigravityRuntime>>();

function runtimeRoot(baseDir = DATA_DIR): string {
  return join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
}

function executableNames(platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

async function executableFile(path: string, bytes?: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || (bytes !== undefined && info.size !== bytes)) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function completedRelease(directory: string, asset: AntigravityReleaseAsset): Promise<AntigravityRuntime | null> {
  try {
    const record = JSON.parse(await readFile(join(directory, INSTALL_RECORD), "utf8")) as InstallRecord;
    if (
      record.sha256 !== asset.sha256 ||
      record.version !== asset.version ||
      record.executable.name !== asset.executable.name ||
      record.executable.bytes !== asset.executable.bytes ||
      record.harness.name !== asset.harness.name ||
      record.harness.bytes !== asset.harness.bytes
    ) return null;
    const executablePath = join(directory, asset.executable.name);
    const harnessPath = join(directory, asset.harness.name);
    if (!(await executableFile(executablePath, asset.executable.bytes))) return null;
    if (!(await executableFile(harnessPath, asset.harness.bytes))) return null;
    return { executablePath, harnessPath, source: "managed", version: asset.version };
  } catch {
    return null;
  }
}

function pathCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) return [resolve(binary)];
  const pathValue = process.platform === "win32"
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  return (pathValue ?? augmentedPath())
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .map((part) => resolve(part, binary));
}

const cliVersions = new Map<string, { stamp: string; version: string | null }>();

const CLI_NOT_INSTALLED = "The Google Antigravity CLI is not installed yet. Install it here.";

/** Security: a program a path names never gets the server's, the workspace's or a provider's credentials. */
function versionProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probe = { ...env };
  stripControlPlaneEnv(probe);
  const credentials = new Set([...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV].map((key) => key.toUpperCase()));
  for (const key of Object.keys(probe)) if (credentials.has(key.toUpperCase())) delete probe[key];
  return probe;
}

/** The version a custom `antigravity` executable reports, when it is 1.5.0 or newer: only those serve ACP themselves. */
async function nativeCliVersion(executablePath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const info = await stat(executablePath);
  const stamp = `${info.size}:${info.mtimeMs}`;
  const known = cliVersions.get(executablePath);
  if (known?.stamp === stamp) return known.version;
  // Security: the probe runs outside the bot box, so the program-trust rule decides whether it may run at all.
  const options = outsideBoxOptions(executablePath, { env: versionProbeEnv(env), timeout: CLI_VERSION_PROBE_MS, killSignal: "SIGKILL" as const, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" as const });
  const output = await new Promise<string>((done) => {
    execFile(executablePath, ["--version"], options, (error, stdout, stderr) => done(error ? "" : `${stdout}\n${stderr}`));
  });
  const triple = parseVersionTriple(output);
  const version = triple && versionAtLeast(triple, [1, 5, 0]) ? triple.join(".") : null;
  if (cliVersions.size >= 32) cliVersions.delete(cliVersions.keys().next().value!);
  cliVersions.set(executablePath, { stamp, version });
  return version;
}

async function externalRuntime(candidate: string, source: "override" | "path", env?: NodeJS.ProcessEnv): Promise<AntigravityRuntime | null> {
  const names = executableNames();
  const executablePath = resolve(candidate);
  if (!(await executableFile(executablePath))) return null;
  const harnessPath = join(dirname(executablePath), names.harness);
  if (await executableFile(harnessPath)) return { executablePath, harnessPath, source, version: null };
  if (!ANTIGRAVITY_NATIVE_CLI || env === undefined || !isAntigravityCliName(executablePath)) return null;
  const version = await nativeCliVersion(executablePath, env);
  return version === null ? null : { executablePath, harnessPath: null, source, version };
}

/** Whether the engine's CLI path asks for the native CLI this app installs: the bare name, as the CLI itself is named. */
export function isAntigravityNativeAlias(cli: string | undefined): boolean {
  const name = cli?.trim() ?? "";
  return ANTIGRAVITY_NATIVE_CLI && !/[\\/]/u.test(name) && isAntigravityCliName(name);
}

/** Whether the engine's CLI path asks for the pinned runtime this app installs and never the native CLI: the runtime's
 * name with no extension, which names no program on PATH. */
export function isAntigravityPinnedAlias(cli: string | undefined): boolean {
  return /^agy_acp_server$/iu.test(cli?.trim() ?? "");
}

const LEGACY_AGY = /(?:^|[\\/])agy(?:\.(?:cmd|bat|exe|ps1))?$/iu;

/** Whether an instance with this CLI path runs the native CLI, or would once installed, told from files alone: unlike
 * resolving it, this starts no program. */
export async function antigravityPathRunsNativeCli(cli: string | undefined, env: NodeJS.ProcessEnv, baseDir = DATA_DIR): Promise<boolean> {
  const override = cli?.trim();
  if (isAntigravityNativeAlias(override)) return true;
  if (isAntigravityPinnedAlias(override)) return false;
  if (override && override !== "agy" && !LEGACY_AGY.test(override)) {
    for (const candidate of pathCandidates(override, env)) {
      const executablePath = resolve(candidate);
      if (!(await executableFile(executablePath))) continue;
      return isAntigravityCliName(executablePath) && !(await executableFile(join(dirname(executablePath), executableNames().harness)));
    }
    return isAntigravityCliName(override);
  }
  const runtime = await resolveAntigravityRuntime(override, env, baseDir).catch(() => null);
  return runtime ? runtime.harnessPath === null : antigravityNativeByDefault();
}

/** Written when the native CLI is installed on a computer with no pinned runtime: this computer's accounts that name no
 * runtime run the CLI from then on, even after an account set to the Classic runtime installs that one beside it. A
 * computer that had the pinned runtime first never gets it, so its accounts keep the pinned runtime until each switches. */
const CLI_FIRST_MARKER = "cli-first.json";

async function cliCameFirst(root: string): Promise<boolean> {
  return access(join(root, CLI_FIRST_MARKER)).then(() => true, () => false);
}

/** Legacy `agy` commands (saved absolute paths, Windows shims) migrate without editing user config. */
export async function resolveAntigravityRuntime(
  binaryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  baseDir = DATA_DIR,
  options: { nativeByDefault?: boolean } = {},
): Promise<AntigravityRuntime> {
  const override = binaryPath?.trim();
  const pinnedOnly = isAntigravityPinnedAlias(override);
  const nativeDefault = !pinnedOnly && (options.nativeByDefault ?? antigravityNativeByDefault());
  const legacyCli = override !== undefined && LEGACY_AGY.test(override);
  const native = isAntigravityNativeAlias(override);
  if (override && override !== "agy" && !native && !pinnedOnly) {
    for (const candidate of pathCandidates(override, env)) {
      const found = await externalRuntime(candidate, "override", env);
      if (found) return found;
    }
    if (!legacyCli) {
      throw new AntigravitySetupError(
        `The custom Antigravity ACP executable or its localharness_external sibling is missing.${ANTIGRAVITY_NATIVE_CLI ? " The native CLI from 1.5.0 on, under its name antigravity, needs no sibling." : ""}`,
      );
    }
  }

  const installedCli = ANTIGRAVITY_NATIVE_CLI && (native || nativeDefault) ? await activeAntigravityCli(runtimeRoot(baseDir)) : null;
  if (native) {
    if (installedCli) return installedCli;
    throw new AntigravitySetupError(CLI_NOT_INSTALLED);
  }
  // OMB_ANTIGRAVITY_NATIVE_CLI=1: an account with no runtime of its own runs the CLI once it is installed here.
  if (installedCli && (ANTIGRAVITY_CLI_FIRST || await cliCameFirst(runtimeRoot(baseDir)))) return installedCli;
  // A computer that has the pinned runtime keeps running it for an account with no runtime of its own.
  const asset = resolveAntigravityReleaseAsset();
  if (asset) {
    const managed = await completedRelease(join(runtimeRoot(baseDir), "versions", asset.sha256), asset);
    if (managed) return managed;
  }
  if (installedCli) return installedCli;
  const names = executableNames();
  for (const candidate of pinnedOnly ? [] : pathCandidates(names.executable, env)) {
    const found = await externalRuntime(candidate, "path");
    if (found) return found;
  }
  if (!antigravityManagedInstallAvailable()) {
    throw new AntigravitySetupError(legacyCli
      ? `Antigravity no longer runs the agy command, and Google does not publish its official runtime for ${process.platform}-${process.arch}. Set the custom executable path to ${names.executable}, with ${names.harness} in the same folder.`
      : `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Set a custom executable path.`);
  }
  if (!asset && !nativeDefault) {
    throw new AntigravitySetupError(`Google does not publish the pinned Antigravity runtime for ${process.platform}-${process.arch}. Set the CLI path to antigravity to use Google's native CLI.`);
  }
  if (ANTIGRAVITY_NATIVE_CLI && nativeDefault) throw new AntigravitySetupError(CLI_NOT_INSTALLED);
  throw new AntigravitySetupError(legacyCli
    ? "Antigravity now uses Google's official runtime. Choose Install official Antigravity, then Sign in with Google. Your previous agy login is not copied."
    : "Antigravity is not installed. Install the official Google runtime to continue.");
}

async function extractPinnedArchive(
  archivePath: string,
  outputDirectory: string,
  asset: AntigravityReleaseAsset,
): Promise<void> {
  const expected = new Map([
    [asset.executable.name, asset.executable.bytes],
    [asset.harness.name, asset.harness.bytes],
  ]);
  const seen = new Set<string>();
  for (const entry of await readZipDirectory(archivePath, 2)) {
    const expectedBytes = expected.get(entry.name);
    const unixType = (entry.externalAttributes >>> 16) & 0o170000;
    if (
      expectedBytes === undefined || seen.has(entry.name)
      || entry.name.includes("/") || entry.name.includes("\\")
      || (unixType !== 0 && unixType !== 0o100000)
      || entry.uncompressedBytes !== expectedBytes || entry.compressedBytes <= 0
    ) throw new Error("The archive contains an unexpected or unsafe file.");
    seen.add(entry.name);
    await extractZipMember(archivePath, entry, join(outputDirectory, entry.name));
  }
  if (seen.size !== 2) throw new Error("The archive is missing an expected file.");
}

/** A computer the app already put a pinned runtime on keeps it: only a new install, one that already runs the native
 * CLI, a CLI path that asks for it, or OMB_ANTIGRAVITY_NATIVE_CLI=1 takes the CLI. Null when the pinned runtime is the
 * one to install: the CLI's own failure is thrown unless this is a new install the pinned runtime can stand in for. */
async function installNativeCli(options: AntigravityInstallOptions, root: string): Promise<AntigravityRuntime | null> {
  if (!ANTIGRAVITY_NATIVE_CLI || options.asset !== undefined) return null;
  if (!options.native && !(options.nativeByDefault ?? antigravityNativeByDefault())) return null;
  const pinned = resolveAntigravityReleaseAsset();
  const active = await activeAntigravityCli(root);
  if (!options.native && !ANTIGRAVITY_CLI_FIRST && !active && pinned
    && ((await completedRelease(join(root, "versions", pinned.sha256), pinned)) || (await antigravityOlderRuntime(options.baseDir, pinned)) !== null)) return null;
  try {
    const release = options.cliRelease !== undefined ? options.cliRelease : await latestAntigravityCliRelease({ fetchImpl: options.fetchImpl });
    if (!release) throw new Error("Could not find a native Antigravity CLI release. Check the network connection and try again.");
    if (active?.version && isNewer(active.version, release.version)) {
      await options.validate?.(active, active.version);
      return active;
    }
    const pinnedHere = pinned ? (await completedRelease(join(root, "versions", pinned.sha256), pinned)) !== null : false;
    const installed = await installAntigravityCli(release, { root, fetchImpl: options.fetchImpl, validate: options.validate, retry: retryOnWindowsFileLock });
    if (!active && !pinnedHere && !(await cliCameFirst(root))) writeFileAtomic(join(root, CLI_FIRST_MARKER), "{}\n", { mode: 0o600 });
    await pruneAntigravityCliReleases(root, runningFrom).catch(() => []);
    return installed;
  } catch (error) {
    if (options.native || !pinned || active) throw error;
    console.warn(`antigravity: the native CLI could not be installed (${error instanceof Error ? error.message : String(error)}); using the pinned runtime instead`);
    return null;
  }
}

function isNewer(version: string, than: string): boolean {
  const left = parseVersionTriple(version), right = parseVersionTriple(than);
  return left !== null && right !== null && versionAtLeast(left, right) && left.join(".") !== right.join(".");
}

async function installOnce(options: AntigravityInstallOptions): Promise<AntigravityRuntime> {
  const root = runtimeRoot(options.baseDir);
  const cli = await installNativeCli(options, root);
  if (cli) return cli;
  const asset = options.asset === undefined ? resolveAntigravityReleaseAsset() : options.asset;
  if (!asset) {
    throw new Error(`Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}.${ANTIGRAVITY_NATIVE_CLI && antigravityCliTarget(process.platform, process.arch) ? " Set the CLI path to antigravity to use Google's native CLI." : ""}`);
  }
  const versions = join(root, "versions");
  const destination = join(versions, asset.sha256);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const existing = await completedRelease(destination, asset);
  if (existing) {
    await options.validate?.(existing, asset.version);
    return existing;
  }

  try {
    const disk = await statfs(versions, { bigint: true });
    const required = BigInt(asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN);
    if (disk.bavail * disk.bsize < required) {
      throw new Error(`Antigravity needs at least ${Math.ceil(Number(required) / 1024 / 1024)} MiB of free space to install.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Antigravity needs")) throw error;
    // statfs is unavailable on a few filesystems.
  }

  // Another process may be installing into this versions folder; the in-memory map cannot protect its staging dir.
  const staging = await mkdtemp(join(versions, `${STAGING_PREFIX}${randomUUID()}-`));
  let failed = false;
  try {
    const archivePath = join(staging, "download.zip");
    const runtimeDirectory = join(staging, "runtime");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(asset.url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Google download failed (${response.status}).`);
      const finalUrl = new URL(response.url || asset.url);
      if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "dl.google.com") {
        throw new Error("The Antigravity download redirected outside dl.google.com.");
      }
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const length = response.headers.get("content-length");
      if ((!encoding || encoding === "identity") && length && Number(length) !== asset.archiveBytes) {
        throw new Error("The Antigravity download size did not match the pinned release.");
      }
      const handle = await open(archivePath, "wx", 0o600);
      const hash = createHash("sha256");
      let downloaded = 0;
      try {
        for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
          const chunk = Buffer.from(raw);
          if (downloaded + chunk.length > asset.archiveBytes) {
            throw new Error("The Antigravity download exceeded its pinned size.");
          }
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
            if (bytesWritten <= 0) throw new Error("The Antigravity download could not be written completely.");
            offset += bytesWritten;
          }
          hash.update(chunk);
          downloaded += chunk.length;
        }
      } finally {
        await handle.close();
      }
      if (downloaded !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
        throw new Error("The Antigravity download failed its SHA-256 or size check. Nothing was installed.");
      }
    } finally {
      clearTimeout(timeout);
    }
    await extractPinnedArchive(archivePath, runtimeDirectory, asset);
    if (process.platform !== "win32") {
      await chmod(join(runtimeDirectory, asset.executable.name), 0o755);
      await chmod(join(runtimeDirectory, asset.harness.name), 0o755);
    }
    const candidate: AntigravityRuntime = {
      executablePath: join(runtimeDirectory, asset.executable.name),
      harnessPath: join(runtimeDirectory, asset.harness.name),
      source: "managed",
      version: asset.version,
    };
    await options.validate?.(candidate, asset.version);
    const record: InstallRecord = {
      sha256: asset.sha256,
      version: asset.version,
      executable: asset.executable,
      harness: asset.harness,
    };
    await writeFile(join(runtimeDirectory, INSTALL_RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await retryOnWindowsFileLock(() => rename(runtimeDirectory, destination));
    } catch (error) {
      const winner = await completedRelease(destination, asset);
      if (!winner) throw error;
    }
    const installed = await completedRelease(destination, asset);
    if (!installed) throw new Error("The installed Antigravity runtime is incomplete.");
    return installed;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Cleanup must never replace the real error; only this attempt's directory is touched.
    try {
      await retryOnWindowsFileLock(() => rm(staging, { recursive: true, force: true }));
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`antigravity: could not remove the install folder ${staging} (${detail})${failed ? "" : "; the install itself succeeded"}`);
    }
  }
}

/** One install per channel at a time. The two that can download the CLI go one after the other, so the card's install
 * asked during the updater's (or the other way round) finds that release in place instead of downloading it again. */
export function installAntigravityRuntime(options: AntigravityInstallOptions = {}): Promise<AntigravityRuntime> {
  const channel = options.asset !== undefined ? "pinned" : options.native ? "native" : options.nativeByDefault === false ? "pinned-only" : "default";
  const root = `${runtimeRoot(options.baseDir)}\0`;
  const key = `${root}${channel}`;
  const existing = installs.get(key);
  if (existing) return existing;
  const takesCli = (name: string) => name === "native" || name === "default";
  const before = takesCli(channel)
    ? [...installs].filter(([other]) => other.startsWith(root) && takesCli(other.slice(root.length))).map(([, install]) => install.catch(() => {}))
    : [];
  const running = Promise.all(before).then(() => installOnce(options)).finally(() => installs.delete(key));
  installs.set(key, running);
  return running;
}

/** An install of any channel is running on this computer now. */
export function antigravityInstallRunning(baseDir?: string): boolean {
  const root = `${runtimeRoot(baseDir)}\0`;
  return [...installs.keys()].some((key) => key.startsWith(root));
}

/** No Antigravity runtime here at all: no CLI or pinned release this app installed (of any version), and no pinned
 * runtime on PATH. Starts no program. */
export async function antigravityNothingInstalled(baseDir = DATA_DIR, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const root = runtimeRoot(baseDir);
  if (await activeAntigravityCli(root)) return false;
  const pinned = resolveAntigravityReleaseAsset();
  if (pinned && (await completedRelease(join(root, "versions", pinned.sha256), pinned))) return false;
  if ((await antigravityOlderRuntime(baseDir, pinned)) !== null) return false;
  for (const candidate of pathCandidates(executableNames().executable, env)) {
    if (await externalRuntime(candidate, "path")) return false;
  }
  return true;
}

let channelAnswer: { at: number; version: string } | undefined;

/** The native CLI's version when an account here runs it and Google's channel has a newer one. An account runs it when
 * its CLI path asks for it, or when no pinned runtime is installed to go first. With OMB_ANTIGRAVITY_NATIVE_CLI=1 a
 * computer that runs the pinned runtime is also offered the move to the CLI, from the version it runs. The channel's
 * answer is kept for an hour, so an update found while the engine is busy is still there on the next look; a channel
 * that did not answer is asked again. */
export async function antigravityCliUpdate(options: {
  baseDir?: string; now?: number; latest?: () => Promise<AntigravityCliReleaseAsset | null>; asset?: AntigravityReleaseAsset | null;
  /** Every engine's configured CLI path. */
  configuredClis?: readonly string[];
  nativeByDefault?: boolean;
} = {}): Promise<string | null> {
  if (!ANTIGRAVITY_NATIVE_CLI) return null;
  const asked = (options.configuredClis ?? []).some(isAntigravityNativeAlias);
  if (!asked && !(options.nativeByDefault ?? antigravityNativeByDefault())) return null;
  const root = runtimeRoot(options.baseDir);
  const active = await activeAntigravityCli(root);
  const pinned = options.asset === undefined ? resolveAntigravityReleaseAsset() : options.asset;
  const pinnedHere = pinned ? (await completedRelease(join(root, "versions", pinned.sha256), pinned)) !== null : false;
  // The updater moves from the pinned runtime only with the switch on; otherwise an account switches itself in Settings.
  const from = active?.version
    ?? (ANTIGRAVITY_CLI_FIRST ? (pinnedHere ? pinned!.version : await antigravityOlderRuntime(options.baseDir, pinned)) : null);
  if (!from) return null;
  if (active && pinnedHere && !ANTIGRAVITY_CLI_FIRST && !asked && !(await cliCameFirst(root))) return null;
  const now = options.now ?? Date.now();
  if (channelAnswer === undefined || now - channelAnswer.at >= UPDATE_CHECK_INTERVAL_MS || now < channelAnswer.at) {
    const latest = await (options.latest ?? latestAntigravityCliRelease)();
    if (!latest) return null;
    channelAnswer = { at: now, version: latest.version };
  }
  if (!active) return from;
  return active.version && isNewer(channelAnswer.version, active.version) ? active.version : null;
}

/** Whether a process this server started runs a program from `directory`. */
function runningFrom(directory: string): boolean {
  const root = resolve(directory);
  for (const line of liveCliCommands()) {
    if (line.some((part) => typeof part === "string" && resolve(part).startsWith(root))) return true;
  }
  return false;
}

/** The newest runtime the app installed here, when it is not the pinned one; null when the pinned one is installed or none is. */
export async function antigravityOlderRuntime(baseDir = DATA_DIR, asset = resolveAntigravityReleaseAsset()): Promise<string | null> {
  if (!asset) return null;
  const versions = join(runtimeRoot(baseDir), "versions");
  if (await completedRelease(join(versions, asset.sha256), asset)) return null;
  const found: string[] = [];
  for (const name of await readdir(versions).catch(() => [] as string[])) {
    try {
      const record = JSON.parse(await readFile(join(versions, name, INSTALL_RECORD), "utf8")) as Partial<InstallRecord>;
      if (record.sha256 === name && typeof record.version === "string") found.push(record.version);
    } catch {}
  }
  return found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
}

export function antigravityManagedInstallAvailable(): boolean {
  return resolveAntigravityReleaseAsset() !== null || (ANTIGRAVITY_NATIVE_CLI && antigravityCliTarget(process.platform, process.arch) !== null);
}
