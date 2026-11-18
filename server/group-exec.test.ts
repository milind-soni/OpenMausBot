import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execFileInGroup, execFileInGroupAsync, OWN_GROUP, stopGroup } from "./group-exec.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A shell that starts a background child (as git starts git-remote-https) and writes its pid. */
function script(): { file: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "omb-group-exec-"));
  folders.push(dir);
  return { file: "/bin/sh", args: ["-c", `sleep 30 & echo $! > "$0"; wait`, join(dir, "child.pid")] };
}
const childOf = async (path: string) => {
  await vi.waitFor(() => expect(existsSync(path) && readFileSync(path, "utf8").trim()).toBeTruthy());
  return Number(readFileSync(path, "utf8").trim());
};

describe.skipIf(!posix)("a child in a group of its own", () => {
  it("stops what it started too when its timeout passes, and reports the run killed", async () => {
    const { file, args } = script();
    const done = execFileInGroupAsync(file, args, { timeout: 300 });
    const child = await childOf(args[2]!);
    await expect(done).rejects.toMatchObject({ killed: true });
    await vi.waitFor(() => expect(alive(child)).toBe(false));
  });

  it("stops the whole group when its signal aborts", async () => {
    const { file, args } = script();
    const abort = new AbortController();
    const result = new Promise<{ killed?: boolean } | null>((resolve) => { execFileInGroup(file, args, { signal: abort.signal }, (error) => resolve(error)); });
    const child = await childOf(args[2]!);
    abort.abort();
    expect(await result).toMatchObject({ killed: true });
    await vi.waitFor(() => expect(alive(child)).toBe(false));
  });

  it("answers as execFile does when the command finishes", async () => {
    await expect(execFileInGroupAsync("/bin/sh", ["-c", "echo out; echo err >&2"])).resolves.toEqual({ stdout: "out\n", stderr: "err\n" });
    await expect(execFileInGroupAsync("/bin/sh", ["-c", "exit 3"])).rejects.toMatchObject({ code: 3 });
  });

  it("stopGroup ends a spawned child's group, and does nothing once the child has exited", async () => {
    const { file, args } = script();
    const shell = spawn(file, args, { stdio: "ignore", ...OWN_GROUP });
    const child = await childOf(args[2]!);
    const exited = new Promise((resolve) => shell.once("exit", resolve));
    stopGroup(shell, 100);
    await exited;
    await vi.waitFor(() => expect(alive(child)).toBe(false));
    expect(() => stopGroup(shell)).not.toThrow();
  });
});
