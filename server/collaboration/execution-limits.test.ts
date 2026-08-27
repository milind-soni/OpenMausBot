import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isolatedExecutionEnvironment, runArgv } from "./execution-limits.ts";
import { renderCandidateStatus, validateTargetCommandSpec } from "./quality-gate.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cwd(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-limits-"));
  scratch.push(directory);
  return directory;
}

describe("bounded argv execution", () => {
  it("passes shell metacharacters literally and strips credential environment", async () => {
    const home = cwd();
    const env = isolatedExecutionEnvironment(
      { PATH: process.env.PATH, SECRET_TOKEN: "secret", GITHUB_TOKEN: "github", SAFE_VALUE: "not-forwarded" },
      home,
    );
    const literal = "$(touch should-not-exist); && echo pwned";
    const result = await runArgv(
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.SECRET_TOKEN,github:process.env.GITHUB_TOKEN}))",
          literal,
        ],
        timeoutMs: 2_000,
        maxOutputBytes: 8_000,
      },
      { cwd: home, env },
    );
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({ arg: literal });
    expect(result.exitCode).toBe(0);
  });

  it("kills output floods and SIGTERM-resistant process groups within a bounded time", async () => {
    const home = cwd();
    const env = isolatedExecutionEnvironment(process.env, home);
    const flood = await runArgv(
      {
        argv: [process.execPath, "-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)),0)"],
        timeoutMs: 5_000,
        maxOutputBytes: 10_000,
      },
      { cwd: home, env },
    );
    expect(flood.outputLimitExceeded).toBe(true);
    expect(flood.stdout.length + flood.stderr.length).toBeLessThanOrEqual(10_000);

    const started = Date.now();
    const stubborn = await runArgv(
      {
        argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeoutMs: 100,
        maxOutputBytes: 1_000,
      },
      { cwd: home, env },
    );
    expect(stubborn.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("reaps descendants before resolving after the process-group leader exits successfully", async () => {
    if (process.platform === "win32") return;
    const home = cwd();
    const env = isolatedExecutionEnvironment(process.env, home);
    const descendant = [
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));",
      "if(process.send)process.send('ready');",
      "setInterval(()=>{},1000);",
    ].join("");
    const leader = [
      "const {spawn}=require('node:child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});`,
      "child.once('message',()=>{process.stdout.write(String(child.pid));process.exit(0);});",
    ].join("");
    const result = await runArgv(
      { argv: [process.execPath, "-e", leader], timeoutMs: 2_000, maxOutputBytes: 1_000 },
      { cwd: home, env },
    );
    const descendantPid = Number(result.stdout.toString("utf8"));
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("rejects configured network and installation commands", () => {
    expect(() =>
      validateTargetCommandSpec("download", { argv: ["curl", "https://example.invalid"], timeoutMs: 1, maxOutputBytes: 1 }),
    ).toThrow("network access");
    expect(() =>
      validateTargetCommandSpec("install", { argv: ["pnpm", "install"], timeoutMs: 1, maxOutputBytes: 1 }),
    ).toThrow("installs dependencies");
    expect(renderCandidateStatus({ modified: true, evidence: [] })).toMatchObject({
      state: "not_verified",
      fullGatePassed: false,
      label: "已修改，尚未验证",
    });
  });
});
