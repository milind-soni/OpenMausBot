import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { launchChrome } from "./launch.ts";
import { ProcessRegistry, staleSingletonLock, strays, sweep, userDataDirOf, type ListedProcess } from "./processes.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-chrome-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const chrome = (pid: number, dir: string, extra = ""): ListedProcess => ({ pid, ppid: 1, startTime: "t", args: `/opt/chrome/chrome --remote-debugging-pipe --user-data-dir=${dir} --headless=new${extra} about:blank` });

describe("the process sweep", () => {
  it("reads --user-data-dir with spaces, quotes or exact arguments", () => {
    expect(userDataDirOf({ args: "/Apps/Chrome --user-data-dir=/Users/a/Library/Application Support/OMB/browser/profiles/x --no-first-run" })).toBe("/Users/a/Library/Application Support/OMB/browser/profiles/x");
    expect(userDataDirOf({ args: '"C:\\Chrome\\chrome.exe" "--user-data-dir=C:\\Users\\a b\\browser\\p" --headless=new' })).toBe("C:\\Users\\a b\\browser\\p");
    expect(userDataDirOf({ args: "x", argv: ["chrome", "--user-data-dir=/a b/--c"] })).toBe("/a b/--c");
    expect(userDataDirOf({ args: "/usr/bin/node server.js" })).toBeNull();
  });

  it("kills browsers on OMB's profiles that no live server registered, and nothing else", () => {
    const root = "/data/browser";
    const processes = [
      chrome(10, "/data/browser/profiles/a"),
      chrome(11, "/data/browser/profiles/b"),
      chrome(12, "/data/browser/profiles/c"),
      chrome(13, "/data/browser/profiles/a", " --type=renderer"),
      chrome(14, "/home/person/.config/google-chrome"),
      chrome(15, "/data/browser-other/profiles/z"),
      { ...chrome(16, "/data/browser/temp/d"), startTime: "later" },
    ];
    const registered = [
      { pid: 10, startTime: "t", userDataDir: "/data/browser/profiles/a", ownerPid: 500, launchedAt: "" },
      { pid: 11, startTime: "t", userDataDir: "/data/browser/profiles/b", ownerPid: 501, launchedAt: "" },
      { pid: 16, startTime: "t", userDataDir: "/data/browser/temp/d", ownerPid: 500, launchedAt: "" },
    ];
    const alive = (pid: number) => pid === 500;
    expect(strays({ processes, registered, root, alive }).map((listed) => listed.pid)).toEqual([11, 12, 16]);
  });

  it("clears a stale lock, deletes unused temporary profiles and forgets processes that are gone", async () => {
    const root = scratch();
    const busy = join(root, "profiles", "busy");
    const stale = join(root, "profiles", "stale");
    const temporary = join(root, "temp", "old");
    for (const dir of [busy, stale, temporary]) mkdirSync(dir, { recursive: true });
    const posix = process.platform !== "win32";
    if (posix) {
      symlinkSync(`${hostname()}-999999`, join(stale, "SingletonLock"));
      symlinkSync(`${hostname()}-${process.pid}`, join(busy, "SingletonLock"));
    }
    const registry = new ProcessRegistry(root);
    registry.add({ pid: 999998, startTime: null, userDataDir: busy, ownerPid: process.pid, launchedAt: "" });
    const killed: number[] = [];
    const report = await sweep({
      root,
      registry,
      list: async () => [chrome(4242, stale)],
      kill: async (pid) => { killed.push(pid); },
      alive: (pid) => pid === process.pid,
    });
    expect(killed).toEqual([4242]);
    expect(report.temporaryRemoved).toEqual([temporary]);
    expect(existsSync(temporary)).toBe(false);
    expect(registry.list()).toEqual([]);
    if (posix) {
      expect(report.locksCleared).toEqual([stale]);
      expect(staleSingletonLock(busy)).toBe(false);
      expect(lstatSync(join(busy, "SingletonLock"), { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
      expect(lstatSync(join(stale, "SingletonLock"), { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  it.skipIf(process.platform === "win32")("leaves a Chrome that has not answered its pipe yet, and forgets it once it exits", async () => {
    const root = scratch();
    const executablePath = join(root, "chrome");
    writeFileSync(executablePath, '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexec sleep 30\n', { mode: 0o755 });
    const userDataDir = join(root, "temp", "starting");
    mkdirSync(userDataDir, { recursive: true });
    const registry = new ProcessRegistry(root);
    const launching = launchChrome({ executablePath, userDataDir, mode: "headless", host: "desktop", env: { PATH: "/usr/bin:/bin" }, registry, handshakeTimeoutMs: 1_000 });
    const failed = launching.catch((error: Error) => error);
    const [entry] = registry.list();
    expect(entry).toMatchObject({ userDataDir, ownerPid: process.pid });
    const killed: number[] = [];
    const report = await sweep({ root, registry, list: async () => [chrome(entry!.pid, userDataDir)], kill: async (pid) => { killed.push(pid); } });
    expect(killed).toEqual([]);
    expect(report.temporaryRemoved).toEqual([]);
    expect(await failed).toBeInstanceOf(Error);
    await expect.poll(() => registry.list()).toEqual([]);
  });

  it("leaves a profile folder a launch is preparing until the launch lets it go", async () => {
    const root = scratch();
    const temporary = join(root, "temp", "preparing");
    mkdirSync(temporary, { recursive: true });
    const registry = new ProcessRegistry(root);
    const release = registry.reserve(temporary);
    expect((await sweep({ root, registry, list: async () => [] })).temporaryRemoved).toEqual([]);
    release();
    release();
    expect((await sweep({ root, registry, list: async () => [] })).temporaryRemoved).toEqual([temporary]);
  });

  it("leaves the folder of a registered Chrome that started after the process list was read", async () => {
    const root = scratch();
    const temporary = join(root, "temp", "just-started");
    mkdirSync(temporary, { recursive: true });
    const registry = new ProcessRegistry(root);
    registry.add({ pid: 4242, startTime: null, userDataDir: temporary, ownerPid: process.pid, launchedAt: new Date().toISOString() });
    const report = await sweep({ root, registry, list: async () => [], alive: () => true });
    expect(report.temporaryRemoved).toEqual([]);
    expect(existsSync(temporary)).toBe(true);
  });
});
