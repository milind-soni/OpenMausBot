// An AI's own standalone build, installed without Node.js or npm. The release is pinned in code (URLs, archive and
// program SHA-256, size, hosts, macOS signer), downloaded over HTTPS from those hosts only, and checked before anything
// is unpacked. The new build must start before it replaces anything, the old folder is moved aside rather than deleted
// until the new one is in place, and a reused or boot-time copy is hashed again before it runs.
//
// tools/standalone/<engine>/
//   <version>/      what the archive held, plus its install record
//   bin/<program>   the only thing on PATH: a hard link to (or copy of) the current version's program
//   current.json    which version bin/ holds
// bin/ goes on PATH after the person's own PATH and the vendors' default folders, so their own copy always wins.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, createReadStream, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync,
} from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readdir, rename, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as tar from "tar";

import { writeFileAtomic } from "./atomic.ts";
import { cliProbeEnvironment } from "./cli-probe.ts";
import { DATA_DIR, stripControlPlaneEnv } from "./config.ts";
import { standaloneEnginesRoot } from "./engine-roots.ts";
import type { StandaloneAsset, StandaloneRelease } from "./contracts.ts";
import { findCliCandidates, registerFallbackPathDir, resetPathCache } from "./env-path.ts";
import { extractZip, safeArchivePath } from "./zip-archive.ts";

export const STANDALONE_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const STALL_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_ZIP_MEMBERS = 10_000;
const RECORD = ".standalone-install.json";
const CURRENT = "current.json";
const BIN = "bin";
const DOWNLOAD_PREFIX = ".download-";
const STAGING_PREFIX = ".staging-";
const OLD_PREFIX = ".old-";
const NEW_PREFIX = ".new-";
const POINTER_TEMP = /^current\.json\..+\.tmp$/u;

const ENGINE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// No slash, and it cannot be "." or "..": the first character is a letter or digit.
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

/** A version gets its own folder, so it can never be one of the names the engine folder already uses. */
function usableVersionName(name: string): boolean {
  return VERSION_NAME.test(name) && name !== BIN && name !== CURRENT;
}
const SHA256 = /^[0-9a-f]{64}$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/u;

export interface StandaloneInstalled {
  version: string;
  /** The stable bin/ entry, which is what runs. */
  executablePath: string;
  binDir: string;
}

/** Runs /usr/bin/codesign with these arguments; `code` is its exit status, null when it could not run. */
export type CodesignRunner = (args: string[]) => Promise<{ code: number | null; output: string }>;

export interface StandaloneInstallOptions {
  baseDir?: string;
  /** Tests only: the build to pick, which also decides whether the macOS signature check runs. */
  platformKey?: string;
  fetchImpl?: typeof fetch;
  codesign?: CodesignRunner;
  timeoutMs?: number;
  /** How long the download may go without a single byte. */
  stallMs?: number;
}

interface InstallRecord {
  engine: string;
  version: string;
  sha256: string;
  executable: string;
  executableSha256: string;
  installedAt: number;
}

interface CurrentPointer {
  version: string;
  executable: string;
  sha256: string;
  executableSha256: string;
}

class StandaloneInstallError extends Error {}

let muslHost: boolean | undefined;

/** Node's own report names the glibc it runs on; a Linux without one is musl (Alpine and friends). */
function linuxWithoutGlibc(): boolean {
  if (process.platform !== "linux") return false;
  if (muslHost === undefined) {
    try {
      const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
      muslHost = !header?.glibcVersionRuntime;
    } catch {
      muslHost = false;
    }
  }
  return muslHost;
}

export function standalonePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = linuxWithoutGlibc(),
): string {
  return `${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`;
}

/** Only the build made for exactly this platform: a glibc build does not start on musl, nor the reverse. */
export function standaloneAssetFor(release: StandaloneRelease | undefined, key: string = standalonePlatformKey()): StandaloneAsset | null {
  const assets = release?.assets as Record<string, StandaloneAsset | undefined> | undefined;
  return assets && Object.hasOwn(assets, key) ? assets[key] ?? null : null;
}

export function standaloneRoot(baseDir = DATA_DIR): string {
  return standaloneEnginesRoot(baseDir);
}

export function standaloneEngineDir(engine: string, baseDir = DATA_DIR): string {
  return join(standaloneRoot(baseDir), engine);
}

// Versions made current while this server runs may have live processes; only a later server prunes them.
const activeVersions = new Set<string>();
const running = new Map<string, Promise<StandaloneInstalled>>();

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** The same folder however it is spelled: /var and /private/var on macOS, a data folder reached through a link. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function executableIn(versionDir: string, executable: string): string {
  return join(versionDir, ...executable.split("/"));
}

function programName(executable: string): string {
  return executable.split("/").at(-1)!;
}

function realFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function realDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** JSON from a plain file, never through a link. */
function readJsonFile(path: string): unknown {
  if (!realFile(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readRecord(versionDir: string): InstallRecord | null {
  const record = readJsonFile(join(versionDir, RECORD)) as Partial<InstallRecord> | null;
  if (
    !record || typeof record.engine !== "string" || typeof record.version !== "string" || !usableVersionName(record.version)
    || typeof record.sha256 !== "string" || typeof record.executable !== "string" || !safeArchivePath(record.executable)
    || typeof record.executableSha256 !== "string" || !SHA256.test(record.executableSha256)
  ) return null;
  return record as InstallRecord;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function hashFileSync(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Removes one leftover without ever following a link: a link or file is unlinked, only a real folder is emptied. */
function removeLeftover(path: string): void {
  if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

/** An interrupted swap left the old folder aside with nothing in its place: it goes back. Anything else is removed. Only
 * for an engine folder that is a real folder; bin/ is swept only when it is one too, and only of plain files and links. */
function sweepLeftovers(engineDir: string): void {
  let names: string[];
  try {
    names = readdirSync(engineDir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(engineDir, name);
    try {
      if (name.startsWith(OLD_PREFIX)) {
        const version = realDirectory(path) ? readRecord(path)?.version : undefined;
        if (version && !existsSync(join(engineDir, version))) {
          renameSync(path, join(engineDir, version));
          continue;
        }
      } else if (!name.startsWith(DOWNLOAD_PREFIX) && !name.startsWith(STAGING_PREFIX) && !POINTER_TEMP.test(name)) {
        continue;
      }
      removeLeftover(path);
    } catch {
      // A file something still holds open (Windows) goes at a later sweep.
    }
  }
  const bin = join(engineDir, BIN);
  if (!realDirectory(bin)) return;
  for (const entry of readdirSync(bin, { withFileTypes: true })) {
    if ((entry.name.startsWith(NEW_PREFIX) || entry.name.startsWith(OLD_PREFIX)) && (entry.isFile() || entry.isSymbolicLink())) {
      try {
        unlinkSync(join(bin, entry.name));
      } catch {}
    }
  }
}

/** The current version when its record, pointer and bin/ program agree with the code: the program the pin names, hashing
 * to the pinned value, or for an earlier version to one the code lists. The data folder never vouches for itself. */
function verifiedCurrent(engineDir: string, release: StandaloneRelease): StandaloneInstalled | null {
  const key = standalonePlatformKey();
  const asset = standaloneAssetFor(release, key);
  if (!asset) return null;
  const pointer = readJsonFile(join(engineDir, CURRENT)) as Partial<CurrentPointer> | null;
  if (!pointer || typeof pointer.version !== "string" || !usableVersionName(pointer.version)) return null;
  const record = readRecord(join(engineDir, pointer.version));
  if (
    !record || record.engine !== release.engine || record.version !== pointer.version || record.sha256 !== pointer.sha256
    || record.executable !== asset.executable || pointer.executable !== asset.executable
    || record.executableSha256 !== pointer.executableSha256
  ) return null;
  const earlier = (release.previousPrograms as Record<string, readonly string[] | undefined> | undefined)?.[key] ?? [];
  const expected = pointer.version === release.version ? asset.executableSha256 : earlier.includes(record.executableSha256) ? record.executableSha256 : null;
  if (!expected || record.executableSha256 !== expected) return null;
  const binDir = join(engineDir, BIN);
  const name = programName(asset.executable);
  if (!realDirectory(binDir)) return null;
  // Nothing but the program goes on PATH; a rename Windows could not finish (.old-) is never a command anyone types.
  if (readdirSync(binDir).some((entry) => entry !== name && !entry.startsWith(OLD_PREFIX))) return null;
  const executablePath = join(binDir, name);
  if (!realFile(executablePath)) return null;
  try {
    if (hashFileSync(executablePath) !== expected) return null;
  } catch {
    return null;
  }
  return { version: pointer.version, executablePath, binDir };
}

/** At boot: the bin/ folder of each engine this app pins, once its program is checked, goes on PATH after everything else. */
export function registerStandaloneBinDirs(baseDir = DATA_DIR, releases: readonly StandaloneRelease[] = []): void {
  // Never through a link: a linked folder could lead to the person's own files.
  if (!realDirectory(standaloneRoot(baseDir))) return;
  for (const release of releases) {
    if (!ENGINE_NAME.test(release.engine)) continue;
    const engineDir = standaloneEngineDir(release.engine, baseDir);
    if (!realDirectory(engineDir)) continue;
    // At boot: a folder that can't be read leaves this copy off PATH, never stops the server.
    try {
      sweepLeftovers(engineDir);
      const current = verifiedCurrent(engineDir, release);
      if (!current) continue;
      activeVersions.add(join(engineDir, current.version));
      registerFallbackPathDir(current.binDir);
    } catch (error) {
      warn(release, error);
    }
  }
}

function resolvesInside(folder: string, cli: string, path?: string): boolean {
  const resolved = findCliCandidates(cli, path)[0];
  return resolved !== undefined && inside(realOrResolved(folder), realOrResolved(resolved));
}

/** Whether `cli`, looked up on `path` (the app's PATH unless given), runs a copy the app installed. */
export function isAppStandaloneCopy(cli: string, baseDir = DATA_DIR, path?: string): boolean {
  return resolvesInside(standaloneRoot(baseDir), cli, path);
}

/** The release's run settings when `cli` resolves to the app's own copy; a copy the person installed gets none. */
export function standaloneRunEnv(release: StandaloneRelease | undefined, cli: string, baseDir = DATA_DIR, path?: string): Record<string, string> {
  if (!release?.runEnv) return {};
  return resolvesInside(standaloneEngineDir(release.engine, baseDir), cli, path) ? { ...release.runEnv } : {};
}

function checkRelease(release: StandaloneRelease, asset: StandaloneAsset): void {
  if (
    !ENGINE_NAME.test(release.engine) || !usableVersionName(release.version) || !SHA256.test(asset.sha256)
    || typeof asset.executableSha256 !== "string" || !SHA256.test(asset.executableSha256)
    || !safeArchivePath(asset.executable) || !Number.isSafeInteger(asset.approxBytes) || asset.approxBytes <= 0
    || (release.macTeamId !== undefined && !TEAM_ID.test(release.macTeamId))
  ) throw new StandaloneInstallError(`${release.name}'s install details are invalid. Nothing was downloaded.`);
}

function trustedUrl(url: URL, hosts: readonly string[]): boolean {
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && hosts.includes(url.hostname);
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) throw new Error("The download could not be written to disk.");
    offset += bytesWritten;
  }
}

function warn(release: StandaloneRelease, detail: unknown): void {
  console.warn(`standalone ${release.engine}: ${detail instanceof Error ? detail.message : String(detail)}`);
}

function httpRefusal(name: string, status: number): StandaloneInstallError {
  if (status === 404 || status === 410) return new StandaloneInstallError(`This version of ${name} is no longer available to download. Update OpenMausBot, then try again.`);
  if (status === 403 || status === 429) return new StandaloneInstallError(`The download site is limiting downloads right now. Try again in a few minutes.`);
  if (status >= 500) return new StandaloneInstallError(`${name}'s download site isn't answering right now. Try again later.`);
  return new StandaloneInstallError(`${name} couldn't be downloaded. Check the internet connection and try again.`);
}

/** Streams the asset to `destination` while hashing it; every hop must be HTTPS to a release host. */
async function download(release: StandaloneRelease, asset: StandaloneAsset, destination: string, options: StandaloneInstallOptions): Promise<void> {
  const name = release.name;
  const cap = asset.approxBytes * 2;
  const tooLarge = () => new StandaloneInstallError(`The ${name} download was larger than expected, so it was stopped. Nothing was installed.`);
  const controller = new AbortController();
  let timedOut = false;
  let stalled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? STANDALONE_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let stallTimer: NodeJS.Timeout | undefined;
  const progressed = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, options.stallMs ?? STALL_TIMEOUT_MS);
    stallTimer.unref?.();
  };
  try {
    let url = new URL(asset.url);
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      if (!trustedUrl(url, release.hosts)) {
        throw new StandaloneInstallError(`The ${name} download did not come from its official site, so it was stopped. Nothing was installed.`);
      }
      progressed();
      response = await (options.fetchImpl ?? fetch)(url.href, { redirect: "manual", signal: controller.signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) {
        throw new StandaloneInstallError(`The ${name} download kept redirecting, so it was stopped. Nothing was installed.`);
      }
      url = new URL(location, url);
    }
    if (!response.ok || !response.body) {
      warn(release, `download answered HTTP ${response.status} from ${url.hostname}`);
      await response.body?.cancel().catch(() => {});
      throw httpRefusal(name, response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > cap) throw tooLarge();
    const hash = createHash("sha256");
    const handle = await open(destination, "wx", 0o600);
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        progressed();
        received += chunk.byteLength;
        if (received > cap) throw tooLarge();
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== asset.sha256) {
      throw new StandaloneInstallError(`The ${name} download failed its safety check, so nothing was installed. Try again later.`);
    }
  } catch (error) {
    if (error instanceof StandaloneInstallError) throw error;
    if (timedOut) throw new StandaloneInstallError(`The ${name} download took too long and was stopped. Check the internet connection and try again.`);
    if (stalled) throw new StandaloneInstallError(`The ${name} download stopped partway. Check the internet connection and try again.`);
    // A file-system error (no space, a locked folder) is the caller's to describe; anything else is the network.
    if (typeof (error as NodeJS.ErrnoException).code === "string") throw error;
    warn(release, error instanceof Error && error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error);
    throw new StandaloneInstallError(`${name} couldn't be downloaded. Check the internet connection and try again.`);
  } finally {
    clearTimeout(timer);
    clearTimeout(stallTimer);
    controller.abort();
  }
}

/** Plain files and folders only, each inside the staging folder; `./` prefixes are allowed. */
async function extractTarGz(archivePath: string, staging: string): Promise<boolean> {
  let unsafe = false;
  await tar.x({
    file: archivePath,
    cwd: staging,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    umask: 0o022,
    filter: (path, entry) => {
      const type = "type" in entry ? entry.type : undefined;
      const name = path.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
      if (name === "" && type === "Directory") return false;
      if ((type !== "File" && type !== "Directory") || !safeArchivePath(name)) {
        unsafe = true;
        return false;
      }
      return true;
    },
  });
  return !unsafe;
}

/** Folders 0755, files 0755 when the archive marked them executable and 0644 otherwise: no setuid, nothing writable by others. */
async function normaliseModes(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o755);
      await normaliseModes(path);
    } else if (entry.isFile()) {
      await chmod(path, ((await stat(path)).mode & 0o111) !== 0 ? 0o755 : 0o644);
    } else {
      throw new StandaloneInstallError("The archive contains an unexpected or unsafe file. Nothing was installed.");
    }
  }
}

async function unpack(release: StandaloneRelease, archivePath: string, staging: string, asset: StandaloneAsset): Promise<void> {
  const unsafe = new StandaloneInstallError(`The ${release.name} download holds an unexpected or unsafe file, so nothing was installed.`);
  try {
    if (asset.archive === "zip") await extractZip(archivePath, staging, { maxEntries: MAX_ZIP_MEMBERS });
    else if (asset.archive === "tar.gz") {
      if (!(await extractTarGz(archivePath, staging))) throw unsafe;
    } else {
      const target = executableIn(staging, asset.executable);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(archivePath, target);
    }
  } catch (error) {
    if (error instanceof StandaloneInstallError || typeof (error as NodeJS.ErrnoException).code === "string") throw error;
    warn(release, error);
    throw unsafe;
  }
  if (process.platform !== "win32") await normaliseModes(staging);
}

const runCodesign: CodesignRunner = (args) => new Promise((resolveRun) => {
  execFile("/usr/bin/codesign", args, { timeout: 120_000, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
    resolveRun({ code, output: `${stdout}${stderr}` });
  });
});

/** A valid signature from a Developer ID Application certificate Apple issued to the pinned team. */
async function macSignerOk(executable: string, release: StandaloneRelease, codesign: CodesignRunner): Promise<boolean> {
  const requirement = [
    "=anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${release.macTeamId}"`,
  ].join(" and ");
  return (await codesign(["--verify", "--strict", "-R", requirement, executable])).code === 0;
}

const signedHere = (key: string, release: StandaloneRelease) => key.startsWith("darwin-") && release.macTeamId !== undefined;

/** Null when `<executable> --version` exits cleanly and names the pinned version; otherwise what went wrong. Run with the
 * environment bots' engines get, minus every key: no provider, workspace or control-plane credential. */
function probeVersion(executable: string, release: StandaloneRelease): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...cliProbeEnvironment(), ...release.runEnv };
  stripControlPlaneEnv(env as Record<string, string | undefined>);
  return new Promise((resolveProbe) => {
    execFile(executable, ["--version"], { env, timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const lines = (text: string) => stripVTControlCharacters(text).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      if (error) {
        const { code, killed } = error as { code?: unknown; killed?: boolean };
        const said = lines(stderr)[0]
          ?? (killed ? "it did not answer in time" : typeof code === "number" ? `it stopped with exit code ${code}` : lines(stdout)[0] ?? "it could not be run");
        return resolveProbe(said.slice(0, 400));
      }
      if (!stdout.includes(release.version)) return resolveProbe(`it reported version ${(lines(stdout)[0] ?? "nothing").slice(0, 80)}, not ${release.version}`);
      resolveProbe(null);
    });
  });
}

/** This version's installed program, when its bytes are the pinned ones (and, on macOS, still signed by its maker). */
async function verifiedVersion(
  versionDir: string,
  release: StandaloneRelease,
  asset: StandaloneAsset,
  key: string,
  codesign: CodesignRunner,
): Promise<{ executable: string; sha256: string } | null> {
  const record = readRecord(versionDir);
  if (!record || record.engine !== release.engine || record.version !== release.version || record.sha256 !== asset.sha256 || record.executable !== asset.executable) return null;
  const expected = asset.executableSha256;
  if (record.executableSha256 !== expected) return null;
  const executable = executableIn(versionDir, asset.executable);
  if (!(await lstat(executable).catch(() => null))?.isFile()) return null;
  if ((await hashFile(executable)) !== expected) return null;
  if (signedHere(key, release) && !(await macSignerOk(executable, release, codesign))) return null;
  return { executable, sha256: expected };
}

async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}

function lockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Moves `from` onto `to`. Windows will not replace a program that is running but lets it be renamed, so it steps aside. */
async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !lockedError(error)) throw error;
  }
  const aside = join(dirname(to), `${OLD_PREFIX}${randomUUID()}${extname(to)}`);
  await rename(to, aside);
  try {
    await rename(from, to);
  } catch (error) {
    await rename(aside, to).catch(() => {});
    throw error;
  }
  await rm(aside, { force: true }).catch(() => {});
}

/** A folder of the app's own: created when missing, refused when it is a link or anything but a real folder, since
 * removing things inside a link would remove the person's own files. */
async function realFolder(path: string, release: StandaloneRelease): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { mode: 0o700 });
    return;
  }
  if (!info.isDirectory()) {
    throw new StandaloneInstallError(`OpenMausBot's folder for ${release.name} is not a plain folder (${path}), so nothing was changed. Move it away, then try again.`);
  }
}

/** bin/ holds the program and nothing else the app did not put there; a folder in it is never the app's to remove. */
async function checkBinFolder(binDir: string, release: StandaloneRelease): Promise<void> {
  if (!(await lstat(binDir).catch(() => null))) return;
  await realFolder(binDir, release);
  const folder = (await readdir(binDir, { withFileTypes: true })).find((entry) => entry.isDirectory());
  if (folder) {
    throw new StandaloneInstallError(`OpenMausBot's folder for ${release.name} holds something it did not put there (${join(binDir, folder.name)}), so nothing was changed. Move it away, then try again.`);
  }
}

/** Puts this version's program in bin/, points current.json at it and bin/ on PATH. */
async function activate(engineDir: string, release: StandaloneRelease, asset: StandaloneAsset, programSha256: string): Promise<StandaloneInstalled> {
  const versionDir = join(engineDir, release.version);
  const binDir = join(engineDir, BIN);
  await checkBinFolder(binDir, release);
  await realFolder(binDir, release);
  const name = programName(asset.executable);
  const source = executableIn(versionDir, asset.executable);
  const target = join(binDir, name);
  const fresh = join(binDir, `${NEW_PREFIX}${randomUUID()}${extname(name)}`);
  try {
    try {
      await link(source, fresh);
    } catch {
      // A file system without hard links gets a copy.
      await copyFile(source, fresh);
      if (process.platform !== "win32") await chmod(fresh, 0o755);
    }
    await replaceFile(fresh, target);
  } finally {
    // Renaming one hard link onto another of the same file leaves both names in place.
    await rm(fresh, { force: true }).catch(() => {});
  }
  // Only the program goes on PATH: any other file or link here, planted or left over, is unlinked (never followed, never
  // emptied). A program Windows still holds open under an .old- name stays for a later sweep.
  for (const entry of await readdir(binDir, { withFileTypes: true })) {
    if (entry.name !== name && (entry.isFile() || entry.isSymbolicLink())) await unlink(join(binDir, entry.name)).catch(() => {});
  }
  const pointer: CurrentPointer = { version: release.version, executable: asset.executable, sha256: asset.sha256, executableSha256: programSha256 };
  writeFileAtomic(join(engineDir, CURRENT), `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
  activeVersions.add(versionDir);
  registerFallbackPathDir(binDir);
  resetPathCache();
  return { version: release.version, executablePath: target, binDir };
}

/** Keeps the current version and the newest other; anything older goes unless this server made it current. Only a real
 * folder whose own install record names this engine and its version counts: anything else is left alone. */
async function prune(engineDir: string, currentDir: string, engine: string): Promise<void> {
  const versions: Array<{ dir: string; installedAt: number }> = [];
  for (const entry of await readdir(engineDir, { withFileTypes: true })) {
    const dir = join(engineDir, entry.name);
    if (!entry.isDirectory() || !usableVersionName(entry.name) || dir === currentDir) continue;
    const record = readRecord(dir);
    if (!record || record.engine !== engine || record.version !== entry.name) continue;
    versions.push({ dir, installedAt: typeof record.installedAt === "number" ? record.installedAt : 0 });
  }
  versions.sort((a, b) => b.installedAt - a.installedAt);
  for (const old of versions.slice(1)) {
    if (activeVersions.has(old.dir)) continue;
    // A file something still holds open (Windows) stays until a later install.
    await rm(old.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Everything that is not already a plain sentence becomes one; the detail goes to the server log. Windows refuses to
 * move or delete a file a running program holds with EBUSY, or EPERM from rename, unlink or rmdir; EACCES and any other
 * EPERM mean the folder's permissions. */
export function plainInstallError(release: StandaloneRelease, asset: StandaloneAsset, error: unknown): Error {
  if (error instanceof StandaloneInstallError) return error;
  warn(release, error);
  const { code, syscall } = error as NodeJS.ErrnoException;
  if (code === "ENOSPC") {
    const megabytes = Math.ceil((asset.approxBytes * 4) / 1024 / 1024);
    return new StandaloneInstallError(`There is not enough free disk space to install ${release.name}. Free up about ${megabytes} MB, then try again.`);
  }
  if (code === "EBUSY" || code === "ENOTEMPTY" || (code === "EPERM" && (syscall === "rename" || syscall === "unlink" || syscall === "rmdir"))) {
    return new StandaloneInstallError(`${release.name} is open in another window. Close it, then try again.`);
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new StandaloneInstallError(`OpenMausBot can't write to its folder for ${release.name}. Check the folder's permissions, then try again.`);
  }
  return new StandaloneInstallError(`${release.name} couldn't be installed. Try again.`);
}

async function installOnce(release: StandaloneRelease, options: StandaloneInstallOptions): Promise<StandaloneInstalled> {
  const key = options.platformKey ?? standalonePlatformKey();
  const asset = standaloneAssetFor(release, key);
  if (!asset) throw new StandaloneInstallError(`${release.name} has no download for this computer.`);
  checkRelease(release, asset);
  const codesign = options.codesign ?? runCodesign;
  const engineDir = standaloneEngineDir(release.engine, options.baseDir);
  const versionDir = join(engineDir, release.version);
  const tag = randomUUID();
  const archivePath = join(engineDir, `${DOWNLOAD_PREFIX}${tag}.part`);
  const staging = join(engineDir, `${STAGING_PREFIX}${tag}`);
  try {
    // Never through a link: the standalone folder, this engine's folder and its bin/ are real folders or nothing changes.
    const root = standaloneRoot(options.baseDir);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await realFolder(root, release);
    await realFolder(engineDir, release);
    await checkBinFolder(join(engineDir, BIN), release);
    // Installs of one engine never overlap in this process, and the data folder lease keeps other servers out.
    sweepLeftovers(engineDir);

    const existing = await verifiedVersion(versionDir, release, asset, key, codesign);
    if (existing) {
      // The bytes are the pinned ones, so downloading them again would not help: say so and change nothing.
      const failure = await probeVersion(existing.executable, release);
      if (failure !== null) {
        throw new StandaloneInstallError(`${release.name} is installed, but it doesn't start on this computer (${failure}). Nothing was changed.`);
      }
      const installed = await activate(engineDir, release, asset, existing.sha256);
      await prune(engineDir, versionDir, release.engine).catch(() => {});
      return installed;
    }

    await download(release, asset, archivePath, options);
    await mkdir(staging, { mode: 0o700 });
    await unpack(release, archivePath, staging, asset);
    const stagedProgram = executableIn(staging, asset.executable);
    if (!(await lstat(stagedProgram).catch(() => null))?.isFile()) {
      throw new StandaloneInstallError(`The ${release.name} download did not contain the program it should, so nothing was installed.`);
    }
    if (process.platform !== "win32") await chmod(stagedProgram, 0o755);
    const programSha256 = await hashFile(stagedProgram);
    if (programSha256 !== asset.executableSha256) {
      throw new StandaloneInstallError(`The ${release.name} download failed its safety check, so nothing was installed. Try again later.`);
    }
    if (signedHere(key, release) && !(await macSignerOk(stagedProgram, release, codesign))) {
      throw new StandaloneInstallError(`The downloaded ${release.name} is not signed by its maker, so nothing was installed.`);
    }
    const failure = await probeVersion(stagedProgram, release);
    if (failure !== null) {
      throw new StandaloneInstallError(`${release.name} was downloaded, but it doesn't start on this computer (${failure}). Nothing was installed.`);
    }
    const record: InstallRecord = {
      engine: release.engine, version: release.version, sha256: asset.sha256, executable: asset.executable, executableSha256: programSha256, installedAt: Date.now(),
    };
    await writeFile(join(staging, RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });

    // Proven, so it takes the version's folder. Whatever held it (a changed or partial copy) steps aside, and comes
    // back if anything below fails.
    const aside = existsSync(versionDir) ? join(engineDir, `${OLD_PREFIX}${tag}`) : null;
    if (aside) await rename(versionDir, aside);
    try {
      await rename(staging, versionDir);
    } catch (error) {
      if (aside) await rename(aside, versionDir).catch(() => {});
      throw error;
    }
    let installed: StandaloneInstalled;
    try {
      installed = await activate(engineDir, release, asset, programSha256);
    } catch (error) {
      if (aside) {
        await removeDir(versionDir).catch(() => {});
        await rename(aside, versionDir).catch(() => {});
      }
      throw error;
    }
    if (aside) await removeDir(aside).catch(() => {});
    await prune(engineDir, versionDir, release.engine).catch(() => {});
    return installed;
  } catch (error) {
    throw plainInstallError(release, asset, error);
  } finally {
    // Cleanup must never replace the real error.
    await rm(archivePath, { force: true }).catch(() => {});
    await removeDir(staging).catch(() => {});
  }
}

/** Install or reuse the pinned build for this computer. Installs of one engine that overlap share a single run. */
export function installStandaloneEngine(release: StandaloneRelease, options: StandaloneInstallOptions = {}): Promise<StandaloneInstalled> {
  const key = standaloneEngineDir(release.engine, options.baseDir);
  const existing = running.get(key);
  if (existing) return existing;
  const run = installOnce(release, options).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

export function resetStandaloneStateForTests(): void {
  activeVersions.clear();
  muslHost = undefined;
}
