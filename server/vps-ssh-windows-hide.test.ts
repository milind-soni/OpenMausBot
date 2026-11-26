// The wake script is a console child: without windowsHide Windows gives it a visible console window. These tests
// stub the platform because the POSIX wake fixtures cannot run on the Windows CI shards that exercise this path.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureVpsSshMaster, prepareVpsSsh, VPS_SSH_DIR, VPS_WAKE_SCRIPT } from "./vps-ssh.ts";

const spawns = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(file: string, args: string[], options: Record<string, unknown>) {
      spawns.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { pid: 60_000, stderr: new EventEmitter() });
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A host that refuses SSH, with an executable wake script, so ensureVpsSshMaster runs the script as a child. */
function refusingHost() {
  const root = mkdtempSync(join(tmpdir(), "omb-vps-hide-"));
  roots.push(root);
  const bin = join(root, "bin");
  const data = join(root, "data");
  mkdirSync(bin);
  mkdirSync(data);
  writeFileSync(join(bin, "ssh"), [
    "#!/bin/sh",
    `echo 'ssh: connect to host refused.example port 22: Connection refused' >&2`,
    "exit 255",
    "",
  ].join("\n"), { mode: 0o700 });
  const ssh = prepareVpsSsh(data, bin, "linux");
  writeFileSync(join(data, VPS_SSH_DIR, VPS_WAKE_SCRIPT), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return ssh;
}

describe("VPS wake script spawn options", () => {
  it("hides the wake script's console on Windows, without a process group there", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const ssh = refusingHost();
    await expect(ensureVpsSshMaster(ssh, "hidden-vps")).rejects.toThrow("Connection refused");
    expect(spawns.at(-1)?.options).toMatchObject({ windowsHide: true, detached: false });
  });

  it("keeps the POSIX process group while hiding the console", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const ssh = refusingHost();
    await expect(ensureVpsSshMaster(ssh, "grouped-vps")).rejects.toThrow("Connection refused");
    expect(spawns.at(-1)?.options).toMatchObject({ windowsHide: true, detached: true });
  });
});
