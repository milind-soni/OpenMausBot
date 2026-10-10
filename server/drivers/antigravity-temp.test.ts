// Antigravity's Windows unpack folders: where they go, and what may delete
// them. Every test runs on every OS: Windows paths and process lookups are
// injected, and the folders are real directories under a throwaway root.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  SYSTEM_LEFTOVER_MIN_AGE_MS,
  antigravityTempDir,
  antigravityTempRoot,
  findAntigravityLeftovers,
  processIsAlive,
  removeAntigravityLeftovers,
  setAntigravityTempEnvironment,
  sweepAntigravityTemp,
  unpackFolderOwnerPids,
} from "./antigravity-temp.ts";

// Runs just before the code under test renames (claims) a folder, so a test
// can stage what another remover does in between. Unset: a plain rename.
const beforeRename = vi.hoisted(() => ({ run: null as null | ((from: string) => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      beforeRename.run?.(String(args[0]));
      return fs.rename(...args);
    },
  };
});

const scratch: string[] = [];
afterEach(async () => {
  beforeRename.run = null;
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

function tempRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `omb-agy-temp-${label}-`));
  scratch.push(directory);
  return directory;
}

/** PyInstaller 6.22.1+ names: `_MEI` + 8 hex digits of the ID + counter. */
const hexName = (pid: number, counter = 2) => `_MEI${pid.toString(16).padStart(8, "0")}${counter}`;
/** Older names: `_MEI` + decimal ID + counter. */
const decimalName = (pid: number, counter = 2) => `_MEI${pid}${counter}`;

/** A fake unpack folder with a file inside, optionally with Antigravity's
 * marker files, and optionally dated in the past. */
function unpackFolder(
  parent: string,
  name: string,
  options: { markers?: "both" | "dll-only"; ageMs?: number; bytes?: number } = {},
): string {
  const directory = join(parent, name);
  mkdirSync(join(directory, "google3"), { recursive: true });
  writeFileSync(join(directory, "google3", "payload.bin"), Buffer.alloc(options.bytes ?? 1_000));
  if (options.markers === "both") writeFileSync(join(directory, "agy_acp_licenses.txt"), "licences");
  if (options.markers) writeFileSync(join(directory, "python310.dll"), "dll");
  if (options.ageMs) {
    const then = new Date(Date.now() - options.ageMs);
    utimesSync(directory, then, then);
  }
  return directory;
}

const linkType = process.platform === "win32" ? "junction" : "dir";

describe("Antigravity's temp folder", () => {
  it("is one short, stable folder per instance under tmp/agy", () => {
    const dataDir = join("C:", "Users", "ada", ".openmausbot");
    const work = antigravityTempDir(dataDir, "work");
    expect(work).toBe(antigravityTempDir(dataDir, "work"));
    expect(dirname(work)).toBe(join(dataDir, "tmp", "agy"));
    expect(antigravityTempRoot(dataDir)).toBe(dirname(work));
    // Short: the runtime unpacks files up to 120 characters deep.
    expect(work.slice(dataDir.length)).toMatch(/^[\\/]tmp[\\/]agy[\\/][0-9a-f]{12}$/u);
    // Instance IDs that differ only in case stay apart on case-insensitive disks.
    expect(antigravityTempDir(dataDir, "Work")).not.toBe(work);
    expect(antigravityTempDir(dataDir, "personal")).not.toBe(work);
  });

  it("replaces every spelling of TEMP and TMP on Windows and changes nothing elsewhere", () => {
    const inherited = { Temp: "C:\\Users\\ada\\AppData\\Local\\Temp", tmp: "C:\\Temp", Path: "C:\\bin" };
    const windows: NodeJS.ProcessEnv = { ...inherited };
    setAntigravityTempEnvironment(windows, "C:\\Users\\ada\\.openmausbot\\tmp\\agy\\0123456789ab", "win32");
    expect(windows).toEqual({
      Path: "C:\\bin",
      TEMP: "C:\\Users\\ada\\.openmausbot\\tmp\\agy\\0123456789ab",
      TMP: "C:\\Users\\ada\\.openmausbot\\tmp\\agy\\0123456789ab",
    });
    for (const platform of ["darwin", "linux"] as const) {
      const posix: NodeJS.ProcessEnv = { ...inherited };
      setAntigravityTempEnvironment(posix, "/somewhere", platform);
      expect(posix).toEqual(inherited);
    }
  });
});

describe("reading an unpack folder's process ID", () => {
  it("reads the 8-hex-digit ID of PyInstaller 6.22.1 and later", () => {
    expect(unpackFolderOwnerPids(hexName(0x437c))).toEqual([0x437c]);
    expect(unpackFolderOwnerPids(hexName(0xabcd, 13))).toEqual([0xabcd]);
  });

  it("keeps every reading of an older decimal name, so a live owner is never missed", () => {
    expect(unpackFolderOwnerPids(decimalName(17348))).toEqual([17348, 1734, 173]);
    // Eight digits read both ways.
    expect(unpackFolderOwnerPids(`_MEI${12345678}2`)).toEqual(expect.arrayContaining([0x12345678, 12345678, 1234567, 123456]));
  });

  it("ignores anything that is not a PyInstaller unpack folder", () => {
    for (const name of ["_MEI", "_MEI0", "_MEIabc", "MEI12342", "tmpabc123", ".omb-removing-_MEI173482-1"]) {
      expect(unpackFolderOwnerPids(name)).toBeNull();
    }
  });

  it("treats a process it may not inspect as alive", () => {
    const fails = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(processIsAlive(1234, fails("ESRCH"))).toBe(false);
    expect(processIsAlive(1234, fails("EPERM"))).toBe(true);
    expect(processIsAlive(1234, fails("EINVAL"))).toBe(true);
    expect(processIsAlive(1234, () => true)).toBe(true);
    expect(processIsAlive(process.pid)).toBe(true);
  });
});

describe("the automatic sweep", () => {
  it("removes only unpack folders whose process is gone", async () => {
    const dataDir = tempRoot("sweep");
    const directory = antigravityTempDir(dataDir, "work");
    mkdirSync(directory, { recursive: true });
    const alive = new Set([0x1111, 17348]);
    const dead = unpackFolder(directory, hexName(0x2222));
    const deadDecimal = unpackFolder(directory, decimalName(20004));
    const live = unpackFolder(directory, hexName(0x1111));
    const liveDecimal = unpackFolder(directory, decimalName(17348));
    const claimed = unpackFolder(directory, `.omb-removing-${hexName(0x3333)}-abcdef12`);
    mkdirSync(join(directory, "keep-me"));
    writeFileSync(join(directory, hexName(0x4444)), "a file, not an unpack folder");
    writeFileSync(join(directory, "tmp_python_scratch"), "the runtime's own temp file");

    expect(await sweepAntigravityTemp("work", { dataDir, isAlive: (pid) => alive.has(pid) })).toBe(3);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(deadDecimal)).toBe(false);
    expect(existsSync(claimed)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(liveDecimal)).toBe(true);
    expect(readdirSync(directory).sort()).toEqual([hexName(0x1111), hexName(0x4444), decimalName(17348), "keep-me", "tmp_python_scratch"].sort());
  });

  it("counts a process it may not inspect (EPERM) as alive", async () => {
    const dataDir = tempRoot("eperm");
    const directory = antigravityTempDir(dataDir, "work");
    const folder = unpackFolder(directory, hexName(0x2222));
    const denied = (pid: number) => processIsAlive(pid, () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
    expect(await sweepAntigravityTemp("work", { dataDir, isAlive: denied })).toBe(0);
    expect(existsSync(folder)).toBe(true);
  });

  it("stays inside this instance's folder", async () => {
    const dataDir = tempRoot("other-instance");
    const other = unpackFolder(antigravityTempDir(dataDir, "personal"), hexName(0x2222));
    const systemTemp = tempRoot("system");
    const system = unpackFolder(systemTemp, hexName(0x2222), { markers: "both", ageMs: SYSTEM_LEFTOVER_MIN_AGE_MS * 6 });
    mkdirSync(antigravityTempDir(dataDir, "work"), { recursive: true });
    expect(await sweepAntigravityTemp("work", { dataDir, isAlive: () => false })).toBe(0);
    expect(existsSync(other)).toBe(true);
    // The system temp folder is only ever cleaned when the person asks.
    expect(existsSync(system)).toBe(true);
  });

  it("never follows a link out of OMB's own folder", async () => {
    const dataDir = tempRoot("links");
    const outside = tempRoot("outside");
    const precious = unpackFolder(outside, hexName(0x2222));
    // The instance folder itself is a link to somewhere else.
    mkdirSync(antigravityTempRoot(dataDir), { recursive: true });
    symlinkSync(outside, antigravityTempDir(dataDir, "work"), linkType);
    expect(await sweepAntigravityTemp("work", { dataDir, isAlive: () => false })).toBe(0);
    expect(existsSync(join(precious, "google3", "payload.bin"))).toBe(true);
    expect(await findAntigravityLeftovers({ dataDir, isAlive: () => false, platform: "linux" })).toMatchObject({ folders: [] });
    expect(await removeAntigravityLeftovers({ dataDir, isAlive: () => false, platform: "linux" })).toMatchObject({ removed: 0 });
    expect(existsSync(join(precious, "google3", "payload.bin"))).toBe(true);
  });

  it("never follows a linked tmp folder out of OMB's own folder", async () => {
    const dataDir = tempRoot("linked-tmp");
    const outside = tempRoot("outside-tmp");
    const precious = unpackFolder(join(outside, "agy", antigravityTempDir(dataDir, "work").slice(-12)), hexName(0x2222));
    symlinkSync(outside, join(dataDir, "tmp"), linkType);
    expect(await sweepAntigravityTemp("work", { dataDir, isAlive: () => false })).toBe(0);
    expect(await removeAntigravityLeftovers({ dataDir, isAlive: () => false, platform: "linux" })).toMatchObject({ removed: 0 });
    expect(existsSync(join(precious, "google3", "payload.bin"))).toBe(true);
  });

  it("does not delete through a link that looks like an unpack folder", async () => {
    const dataDir = tempRoot("entry-link");
    const outside = tempRoot("outside-entry");
    writeFileSync(join(outside, "keep.txt"), "not Antigravity's");
    const directory = antigravityTempDir(dataDir, "work");
    mkdirSync(directory, { recursive: true });
    symlinkSync(outside, join(directory, hexName(0x2222)), linkType);
    await sweepAntigravityTemp("work", { dataDir, isAlive: () => false });
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("Free up space", () => {
  const OLD = SYSTEM_LEFTOVER_MIN_AGE_MS * 3;

  function fixture() {
    const dataDir = tempRoot("free");
    // Resolved as the code resolves it, with the native call: macOS keeps
    // temp behind a link, and Windows runners name it with an 8.3 short
    // name (RUNNER~1) that only the native call expands.
    const systemTemp = realpathSync.native(tempRoot("free-system"));
    const alive = new Set([0x1111]);
    const folders = {
      app: unpackFolder(antigravityTempDir(dataDir, "work"), hexName(0x2222), { bytes: 4_000 }),
      appLive: unpackFolder(antigravityTempDir(dataDir, "work"), hexName(0x1111)),
      leftover: unpackFolder(systemTemp, hexName(0x2222, 3), { markers: "both", ageMs: OLD, bytes: 10_000 }),
      leftoverDecimal: unpackFolder(systemTemp, decimalName(20004), { markers: "both", ageMs: OLD, bytes: 20_000 }),
      claimed: unpackFolder(systemTemp, `.omb-removing-${hexName(0x5555)}-abcdef12`, { ageMs: OLD }),
      recent: unpackFolder(systemTemp, hexName(0x3333), { markers: "both", ageMs: 60_000 }),
      running: unpackFolder(systemTemp, hexName(0x1111), { markers: "both", ageMs: OLD }),
      // Another PyInstaller app: only one of the two marker files.
      otherApp: unpackFolder(systemTemp, hexName(0x4444), { markers: "dll-only", ageMs: OLD }),
    };
    const options = { dataDir, systemTemp, platform: "win32" as const, isAlive: (pid: number) => alive.has(pid) };
    return { folders, options };
  }

  it("finds only Antigravity's folders whose process is gone and that have been left for ten minutes", async () => {
    const { folders, options } = fixture();
    const scan = await findAntigravityLeftovers(options);
    expect(scan.folders.map((folder) => folder.path).sort()).toEqual(
      [folders.app, folders.leftover, folders.leftoverDecimal, folders.claimed].sort(),
    );
    expect(scan.complete).toBe(true);
    // Payloads plus the two marker files in each system leftover.
    expect(scan.bytes).toBe(4_000 + 10_000 + 20_000 + 1_000 + 2 * ("licences".length + "dll".length));
    // Looking deletes nothing.
    for (const path of Object.values(folders)) expect(existsSync(path)).toBe(true);
  });

  it("deletes what it found and leaves everything else", async () => {
    const { folders, options } = fixture();
    const result = await removeAntigravityLeftovers(options);
    expect(result).toEqual({
      removed: 4,
      remaining: 0,
      freedBytes: 4_000 + 10_000 + 20_000 + 1_000 + 2 * ("licences".length + "dll".length),
    });
    for (const gone of [folders.app, folders.leftover, folders.leftoverDecimal, folders.claimed]) expect(existsSync(gone)).toBe(false);
    for (const kept of [folders.appLive, folders.recent, folders.running, folders.otherApp]) expect(existsSync(kept)).toBe(true);
    expect(readdirSync(options.systemTemp).some((name) => name.startsWith(".omb-removing-"))).toBe(false);
  });

  it("searches the system temp folder only on Windows", async () => {
    const { folders, options } = fixture();
    const scan = await findAntigravityLeftovers({ ...options, platform: "darwin" });
    expect(scan.folders.map((folder) => folder.path)).toEqual([folders.app]);
    await removeAntigravityLeftovers({ ...options, platform: "linux" });
    expect(existsSync(folders.leftover)).toBe(true);
  });

  it("does not call a folder another remover got to first still in use", async () => {
    // The automatic sweep and "Free up space" can pick the same folder.
    const dataDir = tempRoot("race-listed");
    const listed = unpackFolder(antigravityTempDir(dataDir, "work"), hexName(0x2222));
    // Gone between the listing and the claim.
    const isAlive = () => { rmSync(listed, { recursive: true, force: true }); return false; };
    expect(await removeAntigravityLeftovers({ dataDir, isAlive, platform: "linux" }))
      .toEqual({ removed: 0, remaining: 0, freedBytes: 0 });

    // Claimed by the other remover between the last check and the rename.
    const racedDir = tempRoot("race-claimed");
    const raced = unpackFolder(antigravityTempDir(racedDir, "work"), hexName(0x2222));
    beforeRename.run = (from) => {
      if (from === raced) renameSync(raced, join(dirname(raced), `.omb-removing-${hexName(0x2222)}-0therone`));
    };
    expect(await removeAntigravityLeftovers({ dataDir: racedDir, isAlive: () => false, platform: "linux" }))
      .toEqual({ removed: 0, remaining: 0, freedBytes: 0 });
  });

  it("still reports a folder it could not claim because it is in use", async () => {
    const dataDir = tempRoot("in-use");
    const busy = unpackFolder(antigravityTempDir(dataDir, "work"), hexName(0x2222));
    // What Windows answers while the runtime still has its DLLs loaded.
    beforeRename.run = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };
    expect(await removeAntigravityLeftovers({ dataDir, isAlive: () => false, platform: "linux" }))
      .toEqual({ removed: 0, remaining: 1, freedBytes: 0 });
    expect(existsSync(busy)).toBe(true);
  });

  it("reports a lower bound when counting runs out of time", async () => {
    const { options } = fixture();
    const scan = await findAntigravityLeftovers({ ...options, budgetMs: -1 });
    expect(scan.complete).toBe(false);
    expect(scan.folders.length).toBe(4);
  });
});
