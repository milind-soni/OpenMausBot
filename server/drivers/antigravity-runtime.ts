import { createHash, randomUUID } from "node:crypto";
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

import { DATA_DIR } from "../config.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { extractZipMember, readZipDirectory } from "../zip-archive.ts";
import { augmentedPath } from "../env-path.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";

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
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

async function externalRuntime(candidate: string, source: "override" | "path"): Promise<AntigravityRuntime | null> {
  const names = executableNames();
  const executablePath = resolve(candidate);
  const harnessPath = join(dirname(executablePath), names.harness);
  if (!(await executableFile(executablePath)) || !(await executableFile(harnessPath))) return null;
  return { executablePath, harnessPath, source, version: null };
}

/** Legacy `agy` commands (saved absolute paths, Windows shims) migrate without editing user config. */
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
