// Where the enterprise licence comes from: `<data>/license.key`, OMB_LICENSE_KEY, and `<data>/license.last-good` (the
// last licence this server accepted, so a restart with a broken or missing file keeps a licence still in its paid period).
// A pasted licence and one the MausBot connector refreshes land in license.key and take effect without a restart: on a
// server install the file is checked once a minute (size, change time, inode; never its folder, where the databases
// write constantly) and read every hour. Reading never throws or hangs; which licence wins is decided in enterprise.ts.
import { constants } from "node:fs";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";
import { installKind } from "./update-check.ts";

export const LICENSE_FILE = "license.key";
export const LAST_GOOD_FILE = "license.last-good";
export const LICENSE_REREAD_MS = 60 * 60_000;
/** How often the file's size, change time and inode are compared: one stat a minute. */
export const LICENSE_CHECK_MS = 60_000;
/** Never two reads closer than this, however often the file changes. */
export const LICENSE_MIN_GAP_MS = 30_000;
/** A licence is well under 1 KB; anything bigger than this is not one, and is not read past it. */
export const MAX_LICENSE_BYTES = 64 * 1024;

/** Where licence files are used. `none`: a desktop, a Cloud home or a hosted workspace, which read OMB_LICENSE_KEY alone,
 * as before licence files existed. `server`: the Docker image or the rootless Podman service, as the installer sets a
 * server up (installKind, the same marker the Update server button goes by): the minute check runs even before any
 * licence exists, because a bought server's first licence arrives through the connector after it is installed. `files`:
 * any other server (a checkout, npm): the files are read, and the minute check runs only when there was a licence at
 * start. */
export type LicensePlace = "none" | "files" | "server";
export function licensePlace(input: {
  desktopManaged: boolean;
  cloudHome: boolean;
  hostedWorkspace: boolean;
  serverRoot?: string;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): LicensePlace {
  if (input.desktopManaged || input.cloudHome || input.hostedWorkspace) return "none";
  const kind = installKind({ desktopManaged: false, managed: false, serverRoot: input.serverRoot ?? SERVER_ROOT, exists: input.exists, env: input.env });
  return kind === "docker" || kind === "podman" || kind === "podman-service" ? "server" : "files";
}

/** `last-good`: the copy this server keeps of the last licence it accepted. */
export type LicenseSource = "file" | "env" | "last-good";
export type LicenseFileRead =
  | { state: "absent" }
  | { state: "present"; key: string }
  | { state: "unreadable"; error: string };

export function licenseFilePath(dataDir: string, name: string = LICENSE_FILE): string {
  return join(dataDir, name);
}

// No following a link (a link could point anywhere) and no waiting on a pipe: a FIFO opens at once, is seen not to be a
// file, and is never read. Neither flag exists on Windows, where neither case blocks either.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Opens the file once and reads at most MAX_LICENSE_BYTES + 1 bytes from that handle, so a file swapped for a huge
 * one between checks is never read whole. An empty file counts as none. */
export async function readLicenseFile(dataDir: string, name: string = LICENSE_FILE): Promise<LicenseFileRead> {
  const path = licenseFilePath(dataDir, name);
  let handle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    if (code === "ELOOP") return { state: "unreadable", error: `${path} is a link; put the licence itself there` };
    if (code === "EISDIR") return { state: "unreadable", error: `${path} is not a file` };
    return { state: "unreadable", error: `${path} could not be read (${code ?? (error instanceof Error ? error.message : String(error))})` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: "unreadable", error: `${path} is not a file` };
    if (info.size > MAX_LICENSE_BYTES) return { state: "unreadable", error: `${path} is too large to be a licence` };
    const buffer = Buffer.alloc(MAX_LICENSE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LICENSE_BYTES) return { state: "unreadable", error: `${path} is too large to be a licence` };
    const key = buffer.subarray(0, bytesRead).toString("utf8").trim();
    return key ? { state: "present", key } : { state: "absent" };
  } catch (error) {
    return { state: "unreadable", error: `${path} could not be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Keeps the licence just accepted, replaced in one step (a temporary file, then a rename), readable by this user only. */
export async function writeLastGood(dataDir: string, key: string): Promise<void> {
  const path = licenseFilePath(dataDir, LAST_GOOD_FILE);
  const kept = await readLicenseFile(dataDir, LAST_GOOD_FILE);
  if (kept.state === "present" && kept.key === key) return;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${key}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Size, change time and inode of license.key, or "absent": what the minute check compares. */
export async function licenseFileStamp(dataDir: string): Promise<string> {
  try {
    const info = await stat(licenseFilePath(dataDir));
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  } catch {
    return "absent";
  }
}

export interface LicenseRefreshOptions {
  dataDir: string;
  refresh(): Promise<unknown>;
  log?(line: string): void;
  intervalMs?: number;
  checkMs?: number;
  minGapMs?: number;
  now?(): number;
  /** What the minute check compares; licenseFileStamp by default. */
  stamp?(): Promise<string>;
}

/** Reads hourly, and after the minute check sees license.key change, never twice within LICENSE_MIN_GAP_MS. Started
 * only on a server install that has or had a licence (server/index.ts); its timers never keep the process alive. */
export function startLicenseRefresh(options: LicenseRefreshOptions): { stop(): void } {
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;
  const minGap = options.minGapMs ?? LICENSE_MIN_GAP_MS;
  let lastRun = Number.NEGATIVE_INFINITY;
  let deferred: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    const wait = lastRun + minGap - now();
    if (wait > 0) {
      if (!deferred) {
        deferred = setTimeout(() => { deferred = null; run(); }, wait);
        deferred.unref?.();
      }
      return;
    }
    lastRun = now();
    void options.refresh().catch((error: unknown) => log(`licence re-read failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  let stamp: string | null = null;
  let checking = false;
  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const next = await (options.stamp ? options.stamp() : licenseFileStamp(options.dataDir));
      if (stamp !== null && next !== stamp) run();
      stamp = next;
    } finally {
      checking = false;
    }
  };
  void check();
  const hourly = setInterval(run, options.intervalMs ?? LICENSE_REREAD_MS);
  hourly.unref?.();
  const minute = setInterval(() => { void check(); }, options.checkMs ?? LICENSE_CHECK_MS);
  minute.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(hourly);
      clearInterval(minute);
      if (deferred) clearTimeout(deferred);
    },
  };
}
