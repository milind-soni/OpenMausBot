import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

import { DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";

const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const STAGING_PREFIX = ".install-";

/** Windows refuses to rename or delete a file something still holds open,
 * with EPERM/EBUSY/EACCES rather than a clear "in use": the runtime the
 * validator just stopped (taskkill is asynchronous) or an antivirus scan of
 * a brand-new executable. Retry briefly; persistent refusals still fail. */
export function transientWindowsFileError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry a filesystem step on the transient Windows refusals above, with
 * growing delays (default: 8 tries, 0.25 s → 2 s, about 10 s in total).
 * Anything else, and the final failure, surface unchanged. */
export async function retryOnWindowsFileLock<T>(step: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 8;
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts || !transientWindowsFileError(error)) throw error;
      await sleep(Math.min(2_000, (options.delayMs ?? 250) * 2 ** (attempt - 1)));
    }
  }
}

const INSTALL_RECORD = ".install-complete.json";

export interface AntigravityRuntime {
  executablePath: string;
  harnessPath: string;
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
  asset?: AntigravityReleaseAsset | null;
  fetchImpl?: typeof fetch;
  validate?: (runtime: AntigravityRuntime, expectedVersion: string) => Promise<void>;
}

const installs = new Map<string, Promise<AntigravityRuntime>>();

function runtimeRoot(baseDir = DATA_DIR): string {
  return join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
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

async function externalRuntime(candidate: string, source: "override" | "path"): Promise<AntigravityRuntime | null> {
  const names = executableNames();
  const executablePath = resolve(candidate);
  const harnessPath = join(dirname(executablePath), names.harness);
  if (!(await executableFile(executablePath)) || !(await executableFile(harnessPath))) return null;
  return { executablePath, harnessPath, source, version: null };
}

/** Resolve an explicit official ACP binary, the pinned managed release, or an
 * official binary already on PATH. Legacy `agy` commands (including saved
 * absolute paths and Windows shims) migrate without editing user config. */
export async function resolveAntigravityRuntime(
  binaryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  baseDir = DATA_DIR,
): Promise<AntigravityRuntime> {
  const override = binaryPath?.trim();
  const legacyCli = override !== undefined && /(?:^|[\\/])agy(?:\.(?:cmd|bat|exe|ps1))?$/iu.test(override);
  if (override && override !== "agy") {
    for (const candidate of pathCandidates(override, env)) {
      const found = await externalRuntime(candidate, "override");
      if (found) return found;
    }
    // Older versions saved the detected agy path in engine settings. It is
    // not an official ACP override: installing the new runtime must not leave
    // discovery permanently stuck on that legacy command. A valid explicit
    // ACP executable still wins above, regardless of its filename.
    if (!legacyCli) {
      throw new AntigravitySetupError(
        "The custom Antigravity ACP executable or its localharness_external sibling is missing.",
      );
    }
  }

  const asset = resolveAntigravityReleaseAsset();
  if (asset) {
    const managed = await completedRelease(join(runtimeRoot(baseDir), "versions", asset.sha256), asset);
    if (managed) return managed;
  }
  const names = executableNames();
  for (const candidate of pathCandidates(names.executable, env)) {
    const found = await externalRuntime(candidate, "path");
    if (found) return found;
  }
  if (!asset) {
    throw new AntigravitySetupError(
      `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Set a custom executable path.`,
    );
  }
  throw new AntigravitySetupError(legacyCli
    ? "Antigravity now uses Google's official runtime. Choose Install official Antigravity, then Sign in with Google. Your previous agy login is not copied."
    : "Antigravity is not installed. Install the official Google runtime to continue.");
}

interface PinnedZipEntry {
  name: string;
  compression: 0 | 8;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 22 + 0xffff;

/** Read the ZIP directory without loading Google's 300 MiB archive (or its
 * 1.5 GiB expanded binary) into memory. The whole archive is SHA-pinned first;
 * this parser only accepts the exact two flat members named by the manifest. */
async function pinnedZipEntries(path: string): Promise<PinnedZipEntry[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const tailBytes = Math.min(info.size, MAX_EOCD_BYTES);
    const tail = Buffer.alloc(tailBytes);
    const tailOffset = info.size - tailBytes;
    if ((await handle.read(tail, 0, tailBytes, tailOffset)).bytesRead !== tailBytes) {
      throw new Error("The verified archive was truncated.");
    }
    let eocd = -1;
    for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
      if (
        tail.readUInt32LE(cursor) === EOCD_SIGNATURE
        && cursor + 22 + tail.readUInt16LE(cursor + 20) === tail.length
      ) {
        eocd = cursor;
        break;
      }
    }
    if (eocd < 0) throw new Error("The verified archive has no valid ZIP directory.");
    const disk = tail.readUInt16LE(eocd + 4);
    const directoryDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directoryBytes = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const eocdOffset = tailOffset + eocd;
    if (
      disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount || entryCount !== 2
      || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff
      || directoryOffset + directoryBytes > eocdOffset
    ) throw new Error("The verified archive uses an unsupported ZIP layout.");

    const directory = Buffer.alloc(directoryBytes);
    if ((await handle.read(directory, 0, directoryBytes, directoryOffset)).bytesRead !== directoryBytes) {
      throw new Error("The verified archive directory was truncated.");
    }
    const entries: PinnedZipEntry[] = [];
    let cursor = 0;
    while (cursor < directory.length) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error("The verified archive directory is invalid.");
      }
      const flags = directory.readUInt16LE(cursor + 8);
      const compression = directory.readUInt16LE(cursor + 10);
      const compressedBytes = directory.readUInt32LE(cursor + 20);
      const uncompressedBytes = directory.readUInt32LE(cursor + 24);
      const nameBytes = directory.readUInt16LE(cursor + 28);
      const extraBytes = directory.readUInt16LE(cursor + 30);
      const commentBytes = directory.readUInt16LE(cursor + 32);
      const startDisk = directory.readUInt16LE(cursor + 34);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
      if (
        next > directory.length || startDisk !== 0 || (flags & 1) !== 0
        || (compression !== 0 && compression !== 8)
        || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff
        || localHeaderOffset === 0xffffffff
      ) throw new Error("The verified archive contains an unsupported ZIP member.");
      entries.push({
        name: directory.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8"),
        compression,
        compressedBytes,
        uncompressedBytes,
        localHeaderOffset,
        externalAttributes,
      });
      cursor = next;
    }
    if (entries.length !== entryCount) throw new Error("The verified archive member count is invalid.");
    return entries;
  } finally {
    await handle.close();
  }
}

async function zipEntryDataOffset(path: string, entry: PinnedZipEntry): Promise<number> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(30);
    if ((await handle.read(header, 0, header.length, entry.localHeaderOffset)).bytesRead !== header.length) {
      throw new Error("A verified archive member header was truncated.");
    }
    const nameBytes = header.readUInt16LE(26);
    const extraBytes = header.readUInt16LE(28);
    if (
      header.readUInt32LE(0) !== LOCAL_SIGNATURE
      || header.readUInt16LE(8) !== entry.compression
      || (header.readUInt16LE(6) & 1) !== 0
    ) throw new Error("A verified archive member header is invalid.");
    const name = Buffer.alloc(nameBytes);
    if ((await handle.read(name, 0, nameBytes, entry.localHeaderOffset + 30)).bytesRead !== nameBytes) {
      throw new Error("A verified archive member name was truncated.");
    }
    if (name.toString("utf8") !== entry.name) throw new Error("A verified archive member name did not match its directory.");
    return entry.localHeaderOffset + 30 + nameBytes + extraBytes;
  } finally {
    await handle.close();
  }
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
  for (const entry of await pinnedZipEntries(archivePath)) {
    const expectedBytes = expected.get(entry.name);
    const unixType = (entry.externalAttributes >>> 16) & 0o170000;
    if (
      expectedBytes === undefined || seen.has(entry.name)
      || entry.name.includes("/") || entry.name.includes("\\")
      || (unixType !== 0 && unixType !== 0o100000)
      || entry.uncompressedBytes !== expectedBytes || entry.compressedBytes <= 0
    ) throw new Error("The archive contains an unexpected or unsafe file.");
    seen.add(entry.name);
    const dataOffset = await zipEntryDataOffset(archivePath, entry);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes <= expectedBytes ? null : new Error("An extracted file exceeded its pinned size."), chunk);
      },
    });
    const source = createReadStream(archivePath, {
      start: dataOffset,
      end: dataOffset + entry.compressedBytes - 1,
    });
    const destination = createWriteStream(join(outputDirectory, entry.name), { flags: "wx", mode: 0o700 });
    if (entry.compression === 8) await pipeline(source, createInflateRaw(), counter, destination);
    else await pipeline(source, counter, destination);
    if (bytes !== expectedBytes) throw new Error("An extracted file was truncated.");
  }
  if (seen.size !== 2) throw new Error("The archive is missing an expected file.");
}

async function installOnce(options: AntigravityInstallOptions): Promise<AntigravityRuntime> {
  const asset = options.asset === undefined ? resolveAntigravityReleaseAsset() : options.asset;
  if (!asset) throw new Error(`Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}.`);
  const root = runtimeRoot(options.baseDir);
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
    // statfs is unavailable on a few filesystems. The bounded download and
    // extraction checks still fail safely if the disk fills.
  }

  // Another app/server process may be installing into this versions folder.
  // The in-memory coalescing map cannot protect its staging directory.
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
    // Cleanup must never replace the real error with its own: a user who
    // saw "EPERM: unlink agy_acp_server.exe" was looking at this line, not
    // at why the install failed. Only clean up this attempt's directory;
    // if it stays locked, log and leave it without touching other attempts.
    try {
      await retryOnWindowsFileLock(() => rm(staging, { recursive: true, force: true }));
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`antigravity: could not remove the install folder ${staging} (${detail})${failed ? "" : "; the install itself succeeded"}`);
    }
  }
}

/** Coalesce concurrent clicks so only one large Google artifact is fetched. */
export function installAntigravityRuntime(options: AntigravityInstallOptions = {}): Promise<AntigravityRuntime> {
  const key = runtimeRoot(options.baseDir);
  const existing = installs.get(key);
  if (existing) return existing;
  const running = installOnce(options).finally(() => installs.delete(key));
  installs.set(key, running);
  return running;
}

export function antigravityManagedInstallAvailable(): boolean {
  return resolveAntigravityReleaseAsset() !== null;
}
