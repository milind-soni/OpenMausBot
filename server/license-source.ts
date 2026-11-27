// Where the enterprise licence comes from: `<data>/license.key` first, then OMB_LICENSE_KEY. A pasted licence and one
// the MausBot connector refreshes land in the same file, so both take effect without a restart: the file is read again
// every hour, and on a Linux server also when it changes. Reading it never throws; what a bad licence means for the one
// in force is decided in enterprise.ts.
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const LICENSE_FILE = "license.key";
export const LICENSE_REREAD_MS = 60 * 60_000;
/** A licence is well under 1 KB; anything this big is not one, and is not read. */
const MAX_LICENSE_BYTES = 64 * 1024;
/** Writers replace the file in a few steps (write, rename); one read after they settle. */
const SETTLE_MS = 1_000;

export type LicenseSource = "file" | "env";
export interface LicenseCandidate { key: string; source: LicenseSource }
export type LicenseFileRead =
  | { state: "absent" }
  | { state: "present"; key: string }
  | { state: "unreadable"; error: string };

export function licenseFilePath(dataDir: string): string {
  return join(dataDir, LICENSE_FILE);
}

/** An empty file counts as no file: clearing it is how a person takes the licence out. */
export async function readLicenseFile(dataDir: string): Promise<LicenseFileRead> {
  const path = licenseFilePath(dataDir);
  try {
    const info = await stat(path);
    if (!info.isFile()) return { state: "unreadable", error: `${path} is not a file` };
    if (info.size > MAX_LICENSE_BYTES) return { state: "unreadable", error: `${path} is too large to be a licence` };
    const key = (await readFile(path, "utf8")).trim();
    return key ? { state: "present", key } : { state: "absent" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return { state: "unreadable", error: `${path} could not be read (${code ?? (error instanceof Error ? error.message : String(error))})` };
  }
}

export interface LicenseRefreshOptions {
  dataDir: string;
  refresh(): Promise<unknown>;
  log?(line: string): void;
  intervalMs?: number;
  /** The file watch runs on Linux only (the servers this is for): elsewhere the hourly read is enough, and a watch on
   * the data folder would hold it open on Windows. */
  platform?: NodeJS.Platform;
  watch?: (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
}

/** Re-reads hourly, and soon after `license.key` changes. Timers and the watch never keep the process alive. */
export function startLicenseRefresh(options: LicenseRefreshOptions): { stop(): void } {
  const log = options.log ?? ((line: string) => console.warn(line));
  let settle: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    void options.refresh().catch((error: unknown) => log(`licence re-read failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  const interval = setInterval(run, options.intervalMs ?? LICENSE_REREAD_MS);
  interval.unref?.();
  let watcher: FSWatcher | null = null;
  if ((options.platform ?? process.platform) === "linux") {
    try {
      watcher = (options.watch ?? fsWatch)(options.dataDir, (_event, filename) => {
        if (filename === null || String(filename) !== LICENSE_FILE) return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => { settle = null; run(); }, SETTLE_MS);
        settle.unref?.();
      });
      watcher.on("error", () => { watcher?.close(); watcher = null; });
      watcher.unref?.();
    } catch {
      watcher = null; // no watch (e.g. the inotify limit): the hourly read still picks the licence up
    }
  }
  return {
    stop() {
      clearInterval(interval);
      if (settle) clearTimeout(settle);
      watcher?.close();
    },
  };
}
