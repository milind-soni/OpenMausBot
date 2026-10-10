import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enginesBinDir, enginesPrefix, installNpmEngine, npmPackageOf, serverInstallFor } from "./engine-install.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCacheForTests } from "./env-path.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import * as procs from "./procs.ts";

// A stand-in npm: records its arguments, honours --prefix, and behaves per
// FAKE_NPM_MODE. Nothing reaches a registry or the network.
// CommonJS on purpose: an extensionless shebang script parses as CJS, which
// skips the ESM-detection reparse and lets the stubborn-mode trap below arm
// itself before anything slower (requires, log writes) can delay boot.
const FAKE_NPM = `#!/usr/bin/env node
if (process.env.FAKE_NPM_MODE === 'stubborn') process.on('SIGTERM', () => {});
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_NPM_MODE || 'ok';
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd(), secret: process.env.XAI_API_KEY ?? null }) + '\\n');
if (mode === 'fail') { console.error('npm ERR! code E404\\nnpm ERR! 404 Not Found - registry-token-fixture'); process.exit(1); }
if (mode === 'hang' || mode === 'stubborn') { setInterval(() => {}, 1000); }
else {
  const prefix = args[args.indexOf('--prefix') + 1];
  // Like npm in #2064: exit 0 having dropped the platform package, so the
  // launcher is there but cannot start. 'broken-once' does it on run one only.
  const runs = readFileSync(process.env.FAKE_NPM_LOG, 'utf8').trim().split('\\n').length;
  const broken = mode === 'broken' || (mode === 'broken-once' && runs === 1);
  if (mode !== 'no-bin' && process.platform === 'win32') {
    writeFileSync(join(prefix, 'fakebin.js'), broken ? "throw new Error('Missing optional dependency fake-engine-platform.');\\n" : "console.log('fixture');\\n");
    writeFileSync(join(prefix, 'fakebin.cmd'), '@echo off\\r\\nnode "%~dp0\\\\fakebin.js" %*\\r\\n');
  } else if (mode !== 'no-bin') {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'bin', 'fakebin'), broken
      ? '#!/bin/sh\\necho "fakebin.js:1" >&2\\necho "Error: Missing optional dependency fake-engine-platform." >&2\\nexit 1\\n'
      : '#!/bin/sh\\necho fixture\\n', { mode: 0o755 });
  }
  if (mode === 'slow') setTimeout(() => process.exit(0), 300); else process.exit(0);
}
`;

/** Put the stand-in npm in `dir`: a shebang script, or on Windows the
 * `.cmd` shim npm itself would write, which spawnCli resolves to Node. */
function writeFakeNpm(dir: string): void {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "npm.js"), FAKE_NPM);
    writeFileSync(join(dir, "npm.cmd"), '@echo off\r\nnode "%~dp0\\npm.js" %*\r\n');
    return;
  }
  writeFileSync(join(dir, "npm"), FAKE_NPM, { mode: 0o755 });
  chmodSync(join(dir, "npm"), 0o755);
}

/** A scratch data dir and a PATH holding only the stand-in npm. */
function useFakeNpm() {
  const ctx = { scratch: "", binDir: "", base: "" };
  let originalPath: string | undefined;
  beforeEach(() => {
    ctx.scratch = mkdtempSync(join(tmpdir(), "omb-engine-install-"));
    ctx.binDir = join(ctx.scratch, "fake-path");
    ctx.base = join(ctx.scratch, "data");
    mkdirSync(ctx.binDir);
    writeFakeNpm(ctx.binDir);
    originalPath = process.env.PATH;
    process.env.PATH = ctx.binDir;
    process.env.FAKE_NPM_LOG = join(ctx.scratch, "calls.jsonl");
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
    await removeTempDir(ctx.scratch);
  });
  const calls = () => readFileSync(join(ctx.scratch, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string; secret: string | null });
  return { ctx, calls };
}

describe("npm package detection", () => {
  it("reads only a plain npm one-liner", () => {
    expect(npmPackageOf({ command: { linux: "npm install -g @anthropic-ai/claude-code" } })).toBe("@anthropic-ai/claude-code");
    expect(npmPackageOf({ command: { darwin: "npm install -g mmx-cli" } })).toBe("mmx-cli");
    expect(npmPackageOf({ command: { linux: "curl -fsSL https://x.ai/cli/install.sh | bash" } })).toBeNull();
    expect(npmPackageOf({ command: { linux: "npm install -g codex; rm -rf /" } })).toBeNull();
    expect(npmPackageOf({ command: { linux: "npm install -g ../evil" } })).toBeNull();
    expect(npmPackageOf(undefined)).toBeNull();
  });

  it("lays the prefix out per platform", () => {
    expect(enginesBinDir("/data", "linux")).toBe(join("/data", "tools", "npm", "bin"));
    expect(enginesBinDir("/data", "win32")).toBe(enginesPrefix("/data"));
  });
});

describe("checking the installed command starts", () => {
  const { ctx, calls } = useFakeNpm();

  it("installs again when npm left a command that does not start", async () => {
    process.env.FAKE_NPM_MODE = "broken-once";
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    expect(calls()).toHaveLength(2);
    for (const call of calls()) expect(call.args).toContain("--include=optional");
  });

  it("reports a command that still does not start, in its own words", async () => {
    process.env.FAKE_NPM_MODE = "broken";
    const failure = await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" }).catch((error: Error) => error.message);
    expect(failure).toContain("`fakebin` does not start: Error: Missing optional dependency fake-engine-platform.");
    expect(failure).toContain("install again from Settings");
    expect(calls()).toHaveLength(2);
  });
});

describe.skipIf(process.platform === "win32")("installing with npm", () => {
  const { ctx, calls } = useFakeNpm();

  it("installs into the app's prefix with a fixed argument list and no workspace credentials", async () => {
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } })).toEqual({ package: "fake-engine" });
    registerPathDir(enginesBinDir(ctx.base));
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin", env: { ...process.env, XAI_API_KEY: "workspace-secret" } });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.args).toEqual(["install", "-g", "--prefix", enginesPrefix(ctx.base), "--loglevel=error", "--include=optional", "--allow-scripts=fake-engine", "fake-engine@latest"]);
    // The child reports its cwd resolved; macOS puts the temp dir under /private.
    expect(realpathSync(calls()[0]!.cwd)).toBe(realpathSync(enginesPrefix(ctx.base)));
    expect(calls()[0]!.secret).toBeNull();
    // The freshly installed binary is what a bare name now resolves to.
    expect(realpathSync(findCliCandidates("fakebin")[0]!)).toBe(realpathSync(join(enginesBinDir(ctx.base), "fakebin")));
    expect(augmentedPath().split(delimiter)[0]).toBe(enginesBinDir(ctx.base));
  });

  it("coalesces concurrent clicks into one npm run", async () => {
    process.env.FAKE_NPM_MODE = "slow";
    await Promise.all([installNpmEngine("fake-engine", { baseDir: ctx.base }), installNpmEngine("fake-engine", { baseDir: ctx.base })]);
    expect(calls()).toHaveLength(1);
  });

  it("reports a failed install with npm's last lines, and a package that provides no command", async () => {
    process.env.FAKE_NPM_MODE = "fail";
    const failure = await installNpmEngine("fake-engine", { baseDir: ctx.base }).catch((error: Error) => error.message);
    expect(failure).toContain("could not install fake-engine");
    expect(failure).toContain("404 Not Found");
    process.env.FAKE_NPM_MODE = "no-bin";
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" })).rejects.toThrow("did not provide a `fakebin` command");
  });

  it("stops an install that hangs", async () => {
    process.env.FAKE_NPM_MODE = "hang";
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 300 })).rejects.toThrow("took too long");
  });

  it("force-stops an install that ignores TERM", async () => {
    process.env.FAKE_NPM_MODE = "stubborn";
    const stopped = vi.spyOn(procs, "killCliTree");
    try {
      // Enough headroom for the fixture's Node boot under load, so TERM
      // arrives after the trap above is armed and only KILL can finish it.
      await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 5000 })).rejects.toThrow("took too long and was stopped");
      expect(stopped.mock.calls[0]![0].signalCode).toBe("SIGKILL");
    } finally {
      stopped.mockRestore();
    }
  }, 20_000);

  it("reports an uncertain stop without waiting forever for npm close", async () => {
    process.env.FAKE_NPM_MODE = "hang";
    const kill = procs.killCliTree;
    const stopped = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    try {
      await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 300 })).rejects.toThrow("could not be confirmed stopped");
      expect(stopped.mock.calls[0]![0].exitCode).toBeNull();
      expect(stopped.mock.calls[0]![0].signalCode).toBeNull();
    } finally {
      const children = stopped.mock.calls.map(([child]) => child);
      stopped.mockRestore();
      await Promise.all(children.map((child) => kill(child, 0)));
    }
  });

  it("says plainly when npm is missing", async () => {
    // The PATH scan also looks in standard install locations, which a test
    // cannot empty, so absence is injected at both call sites.
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } }, false)).toBeNull();
    mkdirSync(join(ctx.scratch, "empty"));
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, path: join(ctx.scratch, "empty") })).rejects.toThrow("npm is not installed");
  });
});
