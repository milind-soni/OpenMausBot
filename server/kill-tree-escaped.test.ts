import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCli } from "./procs.ts";

const posix = process.platform === "linux" || process.platform === "darwin";
let dir: string | undefined;
let grandchild: number | undefined;

afterEach(() => {
  if (grandchild) try { process.kill(grandchild, "SIGKILL"); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = grandchild = undefined;
});

const alive = (pid: number) => {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z");
  } catch { return false; }
};

describe.runIf(posix)("execCli timeout", () => {
  it("stops a SIGTERM-ignoring grandchild that left the process group", async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-escaped-"));
    const pidFile = join(dir, "pid");
    const sleeper = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const wrapper = `process.on('SIGTERM',()=>{});`
      + `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{detached:true,stdio:'ignore'});`
      + `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const done = new Promise<Error | null>((resolve) => execCli(process.execPath, ["-e", wrapper], { timeout: 1_500 }, (err) => resolve(err)));
    await done;
    grandchild = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 3_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(grandchild)).toBe(false);
  }, 15_000);
});
