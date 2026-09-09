import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enginesBinDir, enginesPrefix, installNpmEngine, npmPackageOf, serverInstallFor } from "./engine-install.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCacheForTests } from "./env-path.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// A stand-in npm: records its arguments, honours --prefix, and behaves per
// FAKE_NPM_MODE. Nothing reaches a registry or the network.
const FAKE_NPM = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const mode = process.env.FAKE_NPM_MODE || 'ok';
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd(), secret: process.env.XAI_API_KEY ?? null }) + '\\n');
if (mode === 'fail') { console.error('npm ERR! code E404\\nnpm ERR! 404 Not Found - registry-token-fixture'); process.exit(1); }
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  const prefix = args[args.indexOf('--prefix') + 1];
  if (mode !== 'no-bin') {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'bin', 'fakebin'), '#!/bin/sh\\necho fixture\\n', { mode: 0o755 });
  }
  if (mode === 'slow') setTimeout(() => process.exit(0), 300); else process.exit(0);
}
`;

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

describe.skipIf(process.platform === "win32")("installing with npm", () => {
  let scratch: string;
  let binDir: string;
  let base: string;
  let originalPath: string | undefined;
  const calls = () => readFileSync(join(scratch, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string; secret: string | null });

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-engine-install-"));
    binDir = join(scratch, "fake-path");
    base = join(scratch, "data");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "npm"), FAKE_NPM, { mode: 0o755 });
    chmodSync(join(binDir, "npm"), 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = binDir;
    process.env.FAKE_NPM_LOG = join(scratch, "calls.jsonl");
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
    await removeTempDir(scratch);
  });

  it("installs into the app's prefix with a fixed argument list and no workspace credentials", async () => {
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } })).toEqual({ package: "fake-engine" });
    registerPathDir(enginesBinDir(base));
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", env: { ...process.env, XAI_API_KEY: "workspace-secret" } });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.args).toEqual(["install", "-g", "--prefix", enginesPrefix(base), "--loglevel=error", "--allow-scripts=fake-engine", "fake-engine@latest"]);
    // The child reports its cwd resolved; macOS puts the temp dir under /private.
    expect(realpathSync(calls()[0]!.cwd)).toBe(realpathSync(enginesPrefix(base)));
    expect(calls()[0]!.secret).toBeNull();
    // The freshly installed binary is what a bare name now resolves to.
    expect(realpathSync(findCliCandidates("fakebin")[0]!)).toBe(realpathSync(join(enginesBinDir(base), "fakebin")));
    expect(augmentedPath().split(delimiter)[0]).toBe(enginesBinDir(base));
  });

  it("coalesces concurrent clicks into one npm run", async () => {
    process.env.FAKE_NPM_MODE = "slow";
    await Promise.all([installNpmEngine("fake-engine", { baseDir: base }), installNpmEngine("fake-engine", { baseDir: base })]);
    expect(calls()).toHaveLength(1);
  });

  it("reports a failed install with npm's last lines, and a package that provides no command", async () => {
    process.env.FAKE_NPM_MODE = "fail";
    const failure = await installNpmEngine("fake-engine", { baseDir: base }).catch((error: Error) => error.message);
    expect(failure).toContain("could not install fake-engine");
    expect(failure).toContain("404 Not Found");
    process.env.FAKE_NPM_MODE = "no-bin";
    await expect(installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin" })).rejects.toThrow("did not provide a `fakebin` command");
  });

  it("stops an install that hangs", async () => {
    process.env.FAKE_NPM_MODE = "hang";
    await expect(installNpmEngine("fake-engine", { baseDir: base, timeoutMs: 300 })).rejects.toThrow("took too long");
  });

  it("says plainly when npm is missing", async () => {
    // The PATH scan also looks in standard install locations, which a test
    // cannot empty, so absence is injected at both call sites.
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } }, false)).toBeNull();
    mkdirSync(join(scratch, "empty"));
    await expect(installNpmEngine("fake-engine", { baseDir: base, path: join(scratch, "empty") })).rejects.toThrow("npm is not installed");
  });
});
