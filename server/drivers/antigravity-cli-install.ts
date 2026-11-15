// Installing the native Antigravity CLI from Google's update channel beside the pinned runtime, and naming the one
// that is active.
//
// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/AntigravityInstallation.ts:53-60, 169-175,
//     275-309, 532-721, 861-920 (the size limits, the CLI's names, the install
//     record with no harness, the active-release pointer, the checksum-verified
//     download, the one-file archive rule, and publishing a release).
// Release withdrawal is left out, and the archive is read in process instead of by the system's tar.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { AntigravityCliReleaseAsset } from "./antigravity-cli-release.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

/** Whether the native CLI's channel is used at all. Off, installs and updates use the pinned runtime only, and a CLI
 * this app installed earlier is left where it is and not started. */
export const ANTIGRAVITY_NATIVE_CLI = true;

const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";
const ACTIVE_RELEASE = "active.json";
const RELEASE_ID = /^[a-f0-9]{64}$/u;
const DOWNLOAD_ORIGIN = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";

interface CliRecord {
  releaseId: string;
  version: string;
  executable: { name: string; bytes: number };
  harness: null;
}

export interface AntigravityCliInstallOptions {
  /** The folder that holds `versions/` and the active-release pointer for this platform. */
  root: string;
  fetchImpl?: typeof fetch;
  validate?: (runtime: AntigravityRuntime, expectedVersion: string) => Promise<void>;
  /** Wraps the final rename, which Windows refuses while a just-stopped runtime still holds its files. */
  retry?: <T>(step: () => Promise<T>) => Promise<T>;
  platform?: NodeJS.Platform;
}

/** Antigravity CLI 1.5.0+ serves ACP itself (`agy acp`), so it has no `localharness_external` sibling. A custom path
 * counts as that CLI only under the name `antigravity`: a saved `agy` path is the retired CLI's, which the pinned
 * runtime replaces without the program at that path ever being started. */
export function isAntigravityCliName(...candidates: readonly string[]): boolean {
  return candidates.some((candidate) => /^antigravity(?:\.exe)?$/iu.test(candidate.split(/[\\/]/u).at(-1) ?? ""));
}

const cliExecutableName = (platform: NodeJS.Platform) => platform === "win32" ? "agy.exe" : "antigravity";

async function readRecord<T>(path: string): Promise<T | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > RECORD_MAX_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** A CLI release this app finished installing under `root`, or null when its record or its executable is not whole. */
export async function installedAntigravityCli(root: string, releaseId: string, platform: NodeJS.Platform = process.platform): Promise<AntigravityRuntime | null> {
  if (!RELEASE_ID.test(releaseId)) return null;
  const directory = join(root, "versions", releaseId);
  const record = await readRecord<Partial<CliRecord>>(join(directory, RELEASE_RECORD));
  if (
    !record || record.releaseId !== releaseId || record.harness !== null
    || record.executable?.name !== cliExecutableName(platform)
    || !Number.isSafeInteger(record.executable.bytes) || record.executable.bytes <= 0
    || typeof record.version !== "string" || !record.version.trim()
  ) return null;
  const executablePath = join(directory, record.executable.name);
  try {
    const info = await lstat(executablePath);
    if (!info.isFile() || info.size !== record.executable.bytes) return null;
    if (platform !== "win32") await access(executablePath, constants.X_OK);
  } catch {
    return null;
  }
  return { executablePath, harnessPath: null, source: "managed", version: record.version };
}

/** The CLI release the active pointer names, when it is whole. */
export async function activeAntigravityCli(root: string, platform: NodeJS.Platform = process.platform): Promise<AntigravityRuntime | null> {
  const active = await readRecord<{ releaseId?: unknown }>(join(root, ACTIVE_RELEASE));
  return typeof active?.releaseId === "string" ? installedAntigravityCli(root, active.releaseId, platform) : null;
}

function activate(root: string, releaseId: string): void {
  writeFileAtomic(join(root, ACTIVE_RELEASE), `${JSON.stringify({ releaseId })}\n`, { mode: 0o600 });
}

async function download(asset: AntigravityCliReleaseAsset, archivePath: string, fetchImpl: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(asset.url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Google download failed (${response.status}).`);
    if (!(response.url || asset.url).startsWith(DOWNLOAD_ORIGIN)) throw new Error("The Antigravity download redirected away from Google's release folder.");
    const handle = await open(archivePath, "wx", 0o600);
    const hash = createHash("sha512");
    let downloaded = 0;
    try {
      for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(raw);
        downloaded += chunk.length;
        if (downloaded > MAX_DOWNLOAD_BYTES) throw new Error("The Antigravity download exceeded its allowed size.");
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error("The Antigravity download could not be written completely.");
          offset += bytesWritten;
        }
        hash.update(chunk);
      }
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== asset.sha512) throw new Error("The Antigravity download failed its size or checksum check. Nothing was installed.");
  } finally {
    clearTimeout(timeout);
  }
}

/** The archive must hold one regular file, the executable, and nothing else. */
async function extractOnlyExecutable(archivePath: string, directory: string, name: string): Promise<void> {
  const tar = await import("tar");
  const members: Array<{ path: string; type: string; size: number }> = [];
  await tar.t({ file: archivePath, strict: true, onReadEntry: (entry) => { members.push({ path: entry.path, type: entry.type, size: entry.size }); } });
  if (members.length !== 1 || members[0]!.path !== name || members[0]!.type !== "File") {
    throw new Error("The Antigravity archive must contain one regular executable.");
  }
  if (members[0]!.size <= 0 || members[0]!.size > MAX_EXECUTABLE_BYTES) throw new Error("The Antigravity executable exceeded its size limit.");
  await tar.x({
    file: archivePath, cwd: directory, strict: true, preservePaths: false, preserveOwner: false,
    filter: (path, entry) => path === name && "type" in entry && entry.type === "File",
  });
}

/** Download `asset`, check it against the channel's checksum, start it once to confirm what it is, publish it beside
 * the other releases and make it the active one. A release already installed is checked again and made active. */
export async function installAntigravityCli(asset: AntigravityCliReleaseAsset, options: AntigravityCliInstallOptions): Promise<AntigravityRuntime> {
  const platform = options.platform ?? process.platform;
  // Existing installation records use 64-character IDs, including native SHA-512 prefixes.
  const releaseId = asset.sha512.slice(0, 64);
  const versions = join(options.root, "versions");
  const destination = join(versions, releaseId);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const finish = async (): Promise<AntigravityRuntime> => {
    const installed = await installedAntigravityCli(options.root, releaseId, platform);
    if (!installed) throw new Error("The installed Antigravity runtime is incomplete.");
    if (installed.version !== asset.version) throw new Error("The existing managed release has the wrong version. Remove it before reinstalling.");
    return installed;
  };
  if (await stat(destination).then(() => true, () => false)) {
    const existing = await finish();
    await options.validate?.(existing, asset.version);
    activate(options.root, releaseId);
    return existing;
  }
  try {
    const disk = await statfs(versions, { bigint: true });
    const required = BigInt(MAX_DOWNLOAD_BYTES + MAX_EXECUTABLE_BYTES + FREE_SPACE_MARGIN);
    if (disk.bavail * disk.bsize < required) {
      throw new Error(`Antigravity needs at least ${Math.ceil(Number(required) / 1024 / 1024)} MiB of free space to install.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Antigravity needs")) throw error;
    // statfs is unavailable on a few filesystems.
  }
  const staging = await mkdtemp(join(versions, `.install-${randomUUID()}-`));
  try {
    const archivePath = join(staging, "download");
    const runtimeDirectory = join(staging, "runtime");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    await download(asset, archivePath, options.fetchImpl ?? fetch);
    const executablePath = join(runtimeDirectory, asset.executable.name);
    if (asset.format === "executable") await copyFile(archivePath, executablePath);
    else await extractOnlyExecutable(archivePath, runtimeDirectory, asset.executable.name);
    await rm(archivePath, { force: true });
    const info = await lstat(executablePath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_EXECUTABLE_BYTES) throw new Error("Could not extract the Antigravity executable.");
    if (platform !== "win32") await chmod(executablePath, 0o755);
    await options.validate?.({ executablePath, harnessPath: null, source: "managed", version: asset.version }, asset.version);
    const record: CliRecord = { releaseId, version: asset.version, executable: { name: asset.executable.name, bytes: info.size }, harness: null };
    await writeFile(join(runtimeDirectory, RELEASE_RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await (options.retry ?? ((step) => step()))(() => rename(runtimeDirectory, destination));
    } catch (error) {
      // Another installation may have published the same release first.
      if (!(await installedAntigravityCli(options.root, releaseId, platform))) throw error;
    }
    const installed = await finish();
    activate(options.root, releaseId);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch((error) => {
      console.warn(`antigravity: could not remove the install folder ${staging} (${error instanceof Error ? error.message : String(error)})`);
    });
  }
}
