import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LICENSE_REREAD_MS, licenseFilePath, readLicenseFile, startLicenseRefresh } from "./license-source.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-license-source-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reading license.key", () => {
  it("reads the key trimmed, treats a missing or empty file as none, and never throws", async () => {
    const data = temp();
    expect(licenseFilePath(data)).toBe(join(data, "license.key"));
    expect(await readLicenseFile(data)).toEqual({ state: "absent" });
    expect(await readLicenseFile(join(data, "no-such-folder"))).toEqual({ state: "absent" });
    writeFileSync(join(data, "license.key"), "  \r\n");
    expect(await readLicenseFile(data)).toEqual({ state: "absent" });
    writeFileSync(join(data, "license.key"), "omb1.claims.signature\r\n");
    expect(await readLicenseFile(data)).toEqual({ state: "present", key: "omb1.claims.signature" });
  });

  it("refuses to read what cannot be a licence: a folder, or a large file", async () => {
    const data = temp();
    mkdirSync(join(data, "license.key"));
    expect(await readLicenseFile(data)).toEqual({ state: "unreadable", error: `${join(data, "license.key")} is not a file` });
    const other = temp();
    writeFileSync(join(other, "license.key"), "x".repeat(64 * 1024 + 1));
    expect(await readLicenseFile(other)).toEqual({ state: "unreadable", error: `${join(other, "license.key")} is too large to be a licence` });
  });
});

describe("re-reading it", () => {
  it("reads hourly, keeps going after a failed read, and stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const log = vi.fn<(line: string) => void>();
    const refresh = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error("disk gone")).mockResolvedValue(undefined);
    const running = startLicenseRefresh({ dataDir: temp(), platform: "win32", refresh, log });
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("licence re-read failed: disk gone");
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    running.stop();
    await vi.advanceTimersByTimeAsync(3 * LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("watches the folder on Linux only, and a watch that cannot start or fails leaves the hourly read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const watch = vi.fn(() => { throw Object.assign(new Error("no inotify watches left"), { code: "ENOSPC" }); });
    const refresh = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    for (const platform of ["darwin", "win32"] as const) startLicenseRefresh({ dataDir: temp(), platform, refresh, watch }).stop();
    expect(watch).not.toHaveBeenCalled();
    const failing = startLicenseRefresh({ dataDir: temp(), platform: "linux", refresh, watch });
    expect(watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    failing.stop();

    let onError: (() => void) | undefined;
    const watcher = { on: (_event: string, handler: () => void) => { onError = handler; return watcher; }, unref: () => watcher, close: vi.fn() };
    const erroring = startLicenseRefresh({ dataDir: temp(), platform: "linux", refresh, watch: () => watcher as unknown as FSWatcher });
    onError!();
    expect(watcher.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    erroring.stop();
  });
});
