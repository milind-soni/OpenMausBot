import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESKTOP_SIZE, DISPLAY_RANGE, DisplaySupervisor, findXvnc, xauthority, xvncArgs } from "./displays.ts";

class FakeXvnc extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  exited = false;
  /** Whether it ignores a polite stop. */
  stubborn = false;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.stubborn && signal === "SIGTERM") return true;
    this.exit();
    return true;
  }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => {
      this.stderr.end();
      this.emit("exit", null, "SIGTERM");
      this.emit("close", null, "SIGTERM");
    });
  }
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "displays-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function supervisor(overrides: { taken?: (n: number) => boolean; failOn?: Set<number>; orphans?: number[] } = {}) {
  const spawned: FakeXvnc[] = [];
  const killed: Array<[number, string]> = [];
  const displays = new DisplaySupervisor({
    root,
    xvnc: "/usr/bin/Xvnc",
    bwrap: "/usr/bin/bwrap",
    spawn: (_file, args) => {
      const child = new FakeXvnc(args);
      spawned.push(child);
      if (overrides.failOn?.has(Number(args[0]!.slice(1)))) {
        child.stderr.write("Fatal server error: Server is already active for display\n");
        child.exit();
      }
      return child as unknown as ChildProcess;
    },
    taken: overrides.taken ?? (() => false),
    orphans: () => overrides.orphans ?? [],
    kill: (pid, signal) => { killed.push([pid, signal]); },
    ready: (_socket, _timeoutMs, exited) => new Promise((resolve, reject) => {
      setTimeout(resolve, 5);
      void exited.then(() => reject(new Error("The display server exited while starting.")));
    }),
  });
  return { displays, spawned, killed };
}

describe("display supervisor", () => {
  it("starts one display per browser on the first free number, with its own cookie and private socket", async () => {
    const { displays, spawned } = supervisor({ taken: (n) => n === DISPLAY_RANGE.first });
    const first = await displays.acquire("bot:a");
    const second = await displays.acquire("bot:b");
    expect(first.number).toBe(DISPLAY_RANGE.first + 1);
    expect(second.number).toBe(DISPLAY_RANGE.first + 2);
    expect(first.env.DISPLAY).toBe(`:${first.number}`);
    expect(first.size).toEqual(DESKTOP_SIZE);
    expect(spawned[0]!.args).toEqual(xvncArgs(first.number, DESKTOP_SIZE, first.socket, first.env.XAUTHORITY));
    if (process.platform !== "win32") {
      expect(statSync(first.env.XAUTHORITY).mode & 0o777).toBe(0o600);
      expect(statSync(join(first.socket, "..")).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(first.env.XAUTHORITY).includes(Buffer.from("MIT-MAGIC-COOKIE-1"))).toBe(true);
    expect(readFileSync(first.env.XAUTHORITY).equals(readFileSync(second.env.XAUTHORITY))).toBe(false);
    const policy = join(first.socket, "..", "policy");
    expect(first.wrap.command).toBe("/usr/bin/bwrap");
    expect(first.wrap.args).toEqual(expect.arrayContaining(["--ro-bind", policy, "/etc/opt/chrome_for_testing/policies/managed"]));
    expect(JSON.parse(readFileSync(join(policy, "openmausbot.json"), "utf8")).URLBlocklist).toContain("file://*");
  });

  it("gives browsers that start together different displays, each with its own folder", async () => {
    const { displays, spawned } = supervisor();
    const [a, b, again] = await Promise.all([displays.acquire("bot:a"), displays.acquire("bot:b"), displays.acquire("bot:a")]);
    expect(a.number).not.toBe(b.number);
    expect(again.number).toBe(a.number);
    expect(spawned).toHaveLength(2);
    expect(existsSync(a.env.XAUTHORITY) && existsSync(b.env.XAUTHORITY)).toBe(true);
  });

  it("gives a second holder of the same browser the running display and stops it after the last release", async () => {
    const { displays, spawned } = supervisor();
    const one = await displays.acquire("bot:a");
    const two = await displays.acquire("bot:a");
    expect(two.number).toBe(one.number);
    expect(spawned).toHaveLength(1);
    await one.release();
    await one.release();
    expect(spawned[0]!.exited).toBe(false);
    await two.release();
    expect(spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(existsSync(join(one.socket, ".."))).toBe(false);
    expect(displays.numbers()).toEqual([]);
  });

  it("kills a display server that ignores the polite stop", async () => {
    const { displays, spawned } = supervisor();
    const display = await displays.acquire("bot:a");
    spawned[0]!.stubborn = true;
    await display.release();
    expect(spawned[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("moves on to the next number when a display server cannot start", async () => {
    const { displays, spawned } = supervisor({ failOn: new Set([DISPLAY_RANGE.first]) });
    const display = await displays.acquire("bot:a");
    expect(display.number).toBe(DISPLAY_RANGE.first + 1);
    expect(spawned).toHaveLength(2);
    expect(existsSync(join(root, `d${DISPLAY_RANGE.first}`))).toBe(false);
  });

  it("says why when no display can start", async () => {
    const { displays } = supervisor({ failOn: new Set(Array.from({ length: 70 }, (_, i) => DISPLAY_RANGE.first + i)) });
    await expect(displays.acquire("bot:a")).rejects.toThrow(/exited while starting.*already active/);
  });

  it("forgets a display whose server died, and starts a fresh one next time", async () => {
    const { displays, spawned } = supervisor();
    const display = await displays.acquire("bot:a");
    spawned[0]!.exit();
    await display.exited;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(displays.numbers()).toEqual([]);
    const again = await displays.acquire("bot:a");
    expect(spawned).toHaveLength(2);
    expect(again.number).toBe(display.number);
  });

  it("stops display servers an earlier run left, once, before starting its own", async () => {
    const { displays, killed } = supervisor({ orphans: [4242, 4343] });
    await displays.acquire("bot:a");
    await displays.acquire("bot:b");
    expect(killed).toEqual([[4242, "SIGKILL"], [4343, "SIGKILL"]]);
  });

  it("stops everything on close", async () => {
    const { displays, spawned } = supervisor();
    await displays.acquire("bot:a");
    await displays.acquire("bot:b");
    await displays.closeAll();
    expect(spawned.every((child) => child.exited)).toBe(true);
    expect(displays.numbers()).toEqual([]);
  });

  it("refuses without Xvnc", async () => {
    const displays = new DisplaySupervisor({ root, xvnc: null, bwrap: "/usr/bin/bwrap" });
    expect(displays.available).toBe(false);
    await expect(displays.acquire("bot:a")).rejects.toThrow(/Xvnc is not installed/);
    let probes = 0;
    const lazy = new DisplaySupervisor({ root, xvnc: "/usr/bin/Xvnc", bwrap: () => { probes++; return null; } });
    expect(probes).toBe(0);
    expect(lazy.available).toBe(false);
    expect(lazy.available).toBe(false);
    expect(probes).toBe(1);
    const unwrapped = new DisplaySupervisor({ root, xvnc: "/usr/bin/Xvnc", bwrap: null });
    expect(unwrapped.available).toBe(false);
    await expect(unwrapped.acquire("bot:a")).rejects.toThrow(/locked down/);
    expect(findXvnc({ PATH: "/usr/bin" }, "darwin")).toBeNull();
  });
});

describe("display launch details", () => {
  it("never opens a TCP port and never sends the desktop's clipboard", () => {
    const args = xvncArgs(21, DESKTOP_SIZE, "/s/rfb", "/s/auth");
    expect(args.slice(args.indexOf("-rfbport"), args.indexOf("-rfbport") + 2)).toEqual(["-rfbport", "-1"]);
    expect(args).toContain("-SendCutText=0");
    expect(args).toContain("-AcceptSetDesktopSize=1");
    expect(args.slice(args.indexOf("-nolisten"), args.indexOf("-nolisten") + 2)).toEqual(["-nolisten", "tcp"]);
  });

  it("writes an authority entry for any host", () => {
    const cookie = Buffer.alloc(16, 7);
    const file = xauthority(21, cookie);
    expect(file.readUInt16BE(0)).toBe(0xffff);
    expect(file.readUInt16BE(2)).toBe(0);
    expect(file.subarray(4, 6).readUInt16BE(0)).toBe(2);
    expect(file.subarray(6, 8).toString()).toBe("21");
    expect(file.subarray(-16).equals(cookie)).toBe(true);
  });
});
