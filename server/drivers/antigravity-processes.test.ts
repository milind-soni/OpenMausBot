import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { AntigravityProcesses } from "./antigravity-processes.ts";

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
