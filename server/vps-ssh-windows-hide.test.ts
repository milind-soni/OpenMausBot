import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureVpsSshMaster, VPS_WAKE_SCRIPT } from "./vps-ssh.ts";

const fixture = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  commands: [] as string[][],
  wakePaths: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync(path: Parameters<typeof actual.statSync>[0]) {
      const stat = actual.statSync(path);
      if (typeof path === "string" && fixture.wakePaths.has(path)) stat.mode |= 0o100;
      return stat;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile(_file: string, args: string[], _options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) {
      fixture.commands.push(args);
      queueMicrotask(() => callback(new Error("SSH failed"), "", "Connection refused"));
      return { stdin: { end() {} } };
    },
    spawn(file: string, args: string[], options: Record<string, unknown>) {
      fixture.spawns.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { pid: 60_000, stderr: new EventEmitter() });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.spawns.length = 0;
  fixture.commands.length = 0;
  fixture.wakePaths.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function refusingHost() {
  const root = mkdtempSync(join(tmpdir(), "omb-vps-hide-"));
  roots.push(root);
  const wake = join(root, VPS_WAKE_SCRIPT);
  writeFileSync(wake, "", { mode: 0o700 });
  fixture.wakePaths.add(wake);
  return { configPath: join(root, "config"), path: root };
}

describe("VPS wake script spawn options", () => {
  it.each([
    { platform: "win32", detached: false },
    { platform: "linux", detached: true },
  ] as const)("hides the wake child and sets its process group on $platform", async ({ platform, detached }) => {
    vi.stubGlobal("process", { ...process, platform, getuid: undefined });
    const ssh = refusingHost();
    await expect(ensureVpsSshMaster(ssh, "fixture-vps")).rejects.toThrow("Connection refused");
    expect(fixture.commands).toEqual([
      ["-O", "check", "--", "fixture-vps"],
      ["-o", "BatchMode=yes", "-o", "PermitLocalCommand=no", "-T", "--", "fixture-vps", "true"],
      ["-o", "BatchMode=yes", "-o", "PermitLocalCommand=no", "-T", "--", "fixture-vps", "true"],
    ]);
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]).toMatchObject({ file: join(dirname(ssh.configPath), VPS_WAKE_SCRIPT), args: ["fixture-vps"], options: { windowsHide: true, detached } });
  });
});
