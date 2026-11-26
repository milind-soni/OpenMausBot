import { execFile, spawn } from "node:child_process";
import { sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { AntigravityProcesses, orphanedRuntimeProcesses, stopOrphanedAntigravityRuntimes } from "./antigravity-processes.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function idle() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

describe("waiting for an account's runtime processes to end", () => {
  it("is true once every process is gone", async () => {
    const processes = new AntigravityProcesses();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore" });
    processes.track("a", child);
    expect(await processes.stopped("a", 60_000)).toBe(true);
    expect(processes.count("a")).toBe(0);
  });

  it("is false while a process outlives its kill, and the process is still tracked", async () => {
    const kill = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    const processes = new AntigravityProcesses();
    processes.track("a", idle());
    expect(await processes.stopped("a", 50)).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
    expect(processes.count("a")).toBe(1);
  });
});

describe("runtimes an earlier server left running on Windows", () => {
  const dataDir = "C:\\Users\\a\\.openmausbot";
  const release = `${dataDir}\\tools\\antigravity-acp\\win32-x64\\versions\\abc`;
  const row = (pid: number, path: string, parentStarted: string | null, started = "2026-11-21T08:00:00.0000000Z") => ({ pid, path, started, parentStarted });

  it("lists only this app's runtime images whose parent is gone or holds a reused pid", () => {
    const rows = [
      row(1, `${release}\\agy_acp_server.exe`, null),
      row(2, `${release}\\AGY_ACP_SERVER.EXE`, "2026-11-22T09:00:00.0000000Z"),
      row(3, `${release}\\agy_acp_server.exe`, "2026-11-21T07:59:00.0000000Z"),
      row(4, `${release}\\localharness_external.exe`, "2026-11-21T08:00:00.0000000Z"),
      row(5, "C:\\Users\\a\\Zed\\agy\\agy_acp_server.exe", null),
      row(6, `${release}\\other.exe`, null),
      row(7, `${dataDir}\\tools\\antigravity-acp-copy\\agy_acp_server.exe`, null),
    ];
    expect(orphanedRuntimeProcesses(rows, `${dataDir}\\tools\\antigravity-acp`).map(({ pid }) => pid)).toEqual([1, 2]);
  });

  it("stops each orphan once with the start time it was listed with", async () => {
    const run = vi.fn(async (_script: string, env: NodeJS.ProcessEnv) => env.OMB_AGY_RUNTIMES === undefined ? "41\r\n" : JSON.stringify([
      { ProcessId: 41, ExecutablePath: `${release}\\agy_acp_server.exe`, Started: "2026-11-21T08:00:00.0000000Z", ParentStarted: null },
      { ProcessId: 42, ExecutablePath: `${release}\\localharness_external.exe`, Started: "2026-11-21T08:00:01.0000000Z", ParentStarted: "2026-11-21T08:00:00.0000000Z" },
      { ProcessId: 43, ExecutablePath: `${release}\\agy_acp_server.exe`, Started: "2026-11-25T08:00:00.0000000Z", ParentStarted: "2026-11-25T07:00:00.0000000Z" },
    ]));
    expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir, run })).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1]).toEqual({ OMB_AGY_RUNTIMES: `${dataDir}${sep}tools${sep}antigravity-acp` });
    expect(run.mock.calls[1]![1]).toEqual({ OMB_AGY_STOP: "41=2026-11-21T08:00:00.0000000Z" });
    expect(run.mock.calls[1]![0]).toContain("taskkill /PID $id /T /F");
  });

  it("counts only the runtimes the stop confirms are gone", async () => {
    const listed = (pid: number) => ({ ProcessId: pid, ExecutablePath: `${release}\\agy_acp_server.exe`, Started: "2026-11-21T08:00:00.0000000Z", ParentStarted: null });
    for (const [confirmed, count] of [["", 0], ["41\r\n", 1], ["41\r\n42\r\n99\r\n", 2]] as const) {
      const run = vi.fn(async (_script: string, env: NodeJS.ProcessEnv) => env.OMB_AGY_RUNTIMES === undefined ? confirmed : JSON.stringify([listed(41), listed(42)]));
      expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir, run })).toBe(count);
    }
  });

  it("reads a data folder with non-ASCII letters the way PowerShell writes it", async () => {
    const homeDir = "C:\\Users\\René\\.openmausbot";
    const listing = `\uFEFF${JSON.stringify([{ ProcessId: 41, ExecutablePath: `${homeDir}\\tools\\antigravity-acp\\win32-x64\\agy_acp_server.exe`, Started: "2026-11-21T08:00:00.0000000Z", ParentStarted: null }])}`;
    const run = vi.fn(async (_script: string, env: NodeJS.ProcessEnv) => env.OMB_AGY_RUNTIMES === undefined ? "41" : listing);
    expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir: homeDir, run })).toBe(1);
    expect(run.mock.calls[0]![0]).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
  });

  it("counts none stopped when the stop itself fails", async () => {
    const run = vi.fn(async (_script: string, env: NodeJS.ProcessEnv) => env.OMB_AGY_RUNTIMES === undefined ? null : JSON.stringify(
      { ProcessId: 41, ExecutablePath: `${release}\\agy_acp_server.exe`, Started: "2026-11-21T08:00:00.0000000Z", ParentStarted: null },
    ));
    expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir, run })).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("counts the stops PowerShell confirmed before it ran out of time, not a pid it was still writing", async () => {
    const listed = (pid: number) => ({ ProcessId: pid, ExecutablePath: `${release}\\agy_acp_server.exe`, Started: "2026-11-21T08:00:00.0000000Z", ParentStarted: null });
    type Done = (error: Error | null, stdout: string) => void;
    const ran = vi.mocked(execFile as unknown as (file: string, args: string[], options: { timeout: number }, done: Done) => void);
    ran.mockImplementationOnce((_file, _args, _options, done) => done(null, JSON.stringify([listed(41), listed(4), listed(43)])))
      .mockImplementationOnce((_file, _args, _options, done) => done(Object.assign(new Error("timed out"), { killed: true }), "41\r\n4"));
    expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir })).toBe(1);
    expect(ran.mock.calls[1]![2].timeout).toBeGreaterThan(3 * 10_000);
  });

  it("stops nothing when no orphan is listed or the listing fails", async () => {
    for (const listing of [null, "", "[]"]) {
      const run = vi.fn(async () => listing);
      expect(await stopOrphanedAntigravityRuntimes({ platform: "win32", dataDir, run })).toBe(0);
      expect(run).toHaveBeenCalledOnce();
    }
  });

  it("does nothing outside Windows, where a runtime ends with its server", async () => {
    const run = vi.fn(async () => "[]");
    for (const platform of ["linux", "darwin"] as const) expect(await stopOrphanedAntigravityRuntimes({ platform, dataDir, run })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
