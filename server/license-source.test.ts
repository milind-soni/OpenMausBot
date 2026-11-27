import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LICENSE_REREAD_MS, licenseFilePath, readLicenseFile, startLicenseRefresh, writeLastGood } from "./license-source.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-license-source-"));
  dirs.push(dir);
  return dir;
};
const posix = process.platform !== "win32";

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

  it.skipIf(!posix)("never waits on a pipe and never follows a link", async () => {
    const data = temp();
    const made = spawnSync("mkfifo", [join(data, "license.key")]);
    if (made.status === 0) {
      // A read that waited on the pipe would never settle; this one answers at once.
      expect(await readLicenseFile(data)).toEqual({ state: "unreadable", error: `${join(data, "license.key")} is not a file` });
      rmSync(join(data, "license.key"));
    }
    writeFileSync(join(data, "elsewhere"), "omb1.claims.signature");
    symlinkSync(join(data, "elsewhere"), join(data, "license.key"));
    expect(await readLicenseFile(data)).toEqual({ state: "unreadable", error: `${join(data, "license.key")} is a link; put the licence itself there` });
  });
});

describe("the kept copy of the last good licence", () => {
  it("is written in one step, readable by this user only, and not rewritten when unchanged", async () => {
    const data = temp();
    await writeLastGood(data, "omb1.first.key");
    const path = join(data, "license.last-good");
    expect(readFileSync(path, "utf8")).toBe("omb1.first.key\n");
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = statSync(path).mtimeMs;
    await writeLastGood(data, "omb1.first.key");
    expect(statSync(path).mtimeMs).toBe(written);
    await writeLastGood(data, "omb1.second.key");
    expect(readFileSync(path, "utf8")).toBe("omb1.second.key\n");
    expect(readdirSync(data)).toEqual(["license.last-good"]); // no temporary file left behind
  });
});

describe("re-reading it", () => {
  it("reads hourly, keeps going after a failed read, and stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const log = vi.fn<(line: string) => void>();
    const refresh = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error("disk gone")).mockResolvedValue(undefined);
    const running = startLicenseRefresh({ dataDir: temp(), refresh, log });
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("licence re-read failed: disk gone");
    await vi.advanceTimersByTimeAsync(LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    running.stop();
    await vi.advanceTimersByTimeAsync(3 * LICENSE_REREAD_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never keeps the process alive", () => {
    const data = temp();
    writeFileSync(join(data, "license.key"), "omb1.claims.signature");
    const source = pathToFileURL(join(import.meta.dirname, "license-source.ts")).href;
    const program = `import { startLicenseRefresh } from ${JSON.stringify(source)};
      startLicenseRefresh({ dataDir: ${JSON.stringify(data)}, refresh: async () => {} });
      console.log("started");`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.stdout.trim()).toBe("started");
    expect(child.status, child.stderr).toBe(0);
  });
});
