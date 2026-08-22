// PATH augmentation contract (issues #8, #12): a CLI living in a
// well-known install dir — or an nvm bin dir — must be findable even
// when the process itself started with a bare GUI PATH.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { augmentedPath, resetPathCache, resetPathCacheForTests, splitCliString } from "./env-path.ts";
import { resolveCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posixIt = it.skipIf(process.platform === "win32");

describe("augmentedPath", () => {
  afterEach(() => {
    delete process.env.OMB_EXTRA_PATH;
    resetPathCacheForTests();
  });

  it("keeps the existing PATH entries first", () => {
    resetPathCacheForTests();
    const path = augmentedPath();
    const firstExisting = (process.env.PATH ?? "").split(delimiter).filter(Boolean)[0];
    // OMB_EXTRA_PATH is unset here, so the inherited PATH leads
    expect(path.split(delimiter)[0]).toBe(firstExisting);
  });

  it("prepends OMB_EXTRA_PATH and dedupes", () => {
    process.env.OMB_EXTRA_PATH = ["/tmp/omb-extra", "/tmp/omb-extra"].join(delimiter);
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    expect(parts[0]).toBe("/tmp/omb-extra");
    expect(parts.filter((p) => p === "/tmp/omb-extra")).toHaveLength(1);
  });

  posixIt("includes nvm bin dirs from the home dir, newest node first", () => {
    // setup.ts points homedir at a temp dir, so this is hermetic
    const nvm = join(homedir(), ".nvm", "versions", "node");
    mkdirSync(join(nvm, "v9.0.0", "bin"), { recursive: true });
    mkdirSync(join(nvm, "v24.2.0", "bin"), { recursive: true });
    resetPathCacheForTests();

    const parts = augmentedPath().split(delimiter);
    const v24 = parts.indexOf(join(nvm, "v24.2.0", "bin"));
    const v9 = parts.indexOf(join(nvm, "v9.0.0", "bin"));
    expect(v24).toBeGreaterThan(-1);
    expect(v9).toBeGreaterThan(-1);
    // numeric sort: v24 outranks v9 despite lexicographic order
    expect(v24).toBeLessThan(v9);
  });

  posixIt("includes a user npm prefix at ~/.npm-global/bin", () => {
    const npmGlobal = join(homedir(), ".npm-global", "bin");
    mkdirSync(npmGlobal, { recursive: true });
    resetPathCacheForTests();
    expect(augmentedPath().split(delimiter)).toContain(npmGlobal);
  });

  posixIt("makes a CLI in a known install dir spawnable despite a bare PATH", async () => {
    const bin = join(homedir(), ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "omb-fake-cli");
    writeFileSync(fake, "#!/bin/sh\necho found-me\n");
    chmodSync(fake, 0o755);
    resetPathCacheForTests();

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "omb-fake-cli",
        [],
        // bare GUI-style PATH + our augmentation — the augmentation must win
        { env: { PATH: augmentedPath() } },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    expect(stdout.trim()).toBe("found-me");
  });

  posixIt("finds the CLI opencode's own installer drops in ~/.opencode/bin", () => {
    // opencode.ai/install — the route the opencode driver's install descriptor
    // recommends — puts a standalone binary here, not an npm shim in a node
    // bin dir. Without this entry the engine reports "`opencode` CLI not found"
    // on a machine where opencode is installed and working.
    const bin = join(homedir(), ".opencode", "bin");
    mkdirSync(bin, { recursive: true });
    resetPathCacheForTests();

    expect(augmentedPath().split(delimiter).filter((entry) => entry === bin)).toHaveLength(1);
  });

  posixIt("keeps the last login-shell PATH available during a rescan", async () => {
    const shell = join(homedir(), "fake-login-shell");
    const rcOnlyBin = join(homedir(), "rc-only", "bin");
    writeFileSync(shell, `#!/bin/sh\nprintf '__OMB_PATH__%s' '${rcOnlyBin}'\n`);
    chmodSync(shell, 0o755);

    const previousShell = process.env.SHELL;
    const previousVitest = process.env.VITEST;
    try {
      process.env.SHELL = shell;
      delete process.env.VITEST;
      resetPathCacheForTests();

      augmentedPath();
      await vi.waitFor(() => expect(augmentedPath().split(delimiter)).toContain(rcOnlyBin));

      resetPathCache();
      expect(augmentedPath().split(delimiter)).toContain(rcOnlyBin);
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      resetPathCacheForTests();
    }
  });

  it("skips known dirs that do not exist", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    // temp home: .volta was never created, so it must not appear
    expect(parts).not.toContain(join(homedir(), ".volta", "bin"));
  });

  it.skipIf(process.platform !== "win32")("finds Antigravity installed after launch", () => {
    const previous = process.env.LOCALAPPDATA;
    const localAppData = mkdtempSync(join(tmpdir(), "omb-localappdata-"));
    try {
      process.env.LOCALAPPDATA = localAppData;
      const agyBin = join(localAppData, "agy", "bin");
      mkdirSync(agyBin, { recursive: true });
      resetPathCacheForTests();
      expect(augmentedPath().split(delimiter)).toContain(agyBin);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      resetPathCacheForTests();
      rmSync(localAppData, { recursive: true, force: true });
    }
  });
});

// Windows CLI resolution — spawn(cli) alone finds nothing on Windows (no
// PATHEXT in libuv, no #!, and a .cmd throws outright since Node's
// CVE-2024-27980 fix). Fixtures are the two real npm shim shapes.
const winOnly = describe.skipIf(process.platform !== "win32");

// the exact bytes npm writes for a CLI whose bin is a native binary
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\pkg\\bin\\ombfake.exe"   %*
`;

// ...and for one whose bin is a node script (the "_prog" dance)
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\ombfake.js" %*
`;

describe("resolveCli", () => {
  it.skipIf(process.platform === "win32")("is identity off Windows — the kernel already resolves PATH and #!", () => {
    expect(resolveCli("claude", ["-p", "hi"])).toEqual({ command: "claude", args: ["-p", "hi"] });
  });
});

winOnly("resolveCli (Windows)", () => {
  let dir: string;
  const onPath = () => {
    process.env.OMB_EXTRA_PATH = dir;
    resetPathCacheForTests();
  };
  const shimWith = (name: string, body: string, target: string, targetBody: string) => {
    writeFileSync(join(dir, name), body);
    mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "bin", target), targetBody);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-shim-"));
  });
  afterEach(async () => {
    delete process.env.OMB_EXTRA_PATH;
    resetPathCacheForTests();
    // These tests spawn the shims out of this directory; a just-exited one can
    // still be holding it for a beat after the call returns.
    await removeTempDir(dir);
  });

  it("parses an npm .cmd shim down to the .exe it wraps", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    onPath();
    expect(resolveCli("ombfake", ["-p", "hi"])).toEqual({
      command: join(dir, "node_modules", "pkg", "bin", "ombfake.exe"),
      args: ["-p", "hi"],
    });
  });

  it("parses an npm .cmd shim down to `node <cli.js>`, never the shim's own node.exe", async () => {
    shimWith("ombfake.cmd", JS_SHIM, "ombfake.js", "console.log('js target ' + process.argv.slice(2).join(','));\n");
    onPath();
    const r = resolveCli("ombfake", ["-p", "hi"]);
    expect(r.args).toEqual([join(dir, "node_modules", "pkg", "bin", "ombfake.js"), "-p", "hi"]);
    expect(r.command.toLowerCase()).toMatch(/node\.exe$/);
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("js target -p,hi");
  });

  it("prefers the PATHEXT hit over the extensionless sibling npm installs beside it", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    writeFileSync(join(dir, "ombfake"), "#!/bin/sh\n# the POSIX shim — unrunnable here\n");
    onPath();
    expect(resolveCli("ombfake", []).command).toBe(join(dir, "node_modules", "pkg", "bin", "ombfake.exe"));
  });

  it("runs a #!node script through node — Windows has no shebang support", async () => {
    const script = join(dir, "ombfake-cli.ts");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log('shebang ' + process.argv.slice(2).join(','));\n");
    const r = resolveCli(script, ["a", "b"]);
    expect(r.command.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(r.args).toEqual([script, "a", "b"]);

    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("shebang a,b");
  });

  it("never crosses the no-shell boundary for an unparseable shim", () => {
    const shim = join(dir, "ombfake.cmd");
    writeFileSync(shim, "@ECHO OFF\ncustom-launcher %*\n");
    onPath();
    const payload = JSON.stringify({
      mcpServers: {
        ogb: {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["a b", "%PATH%", "x&y|z", "q^r", "<in>out"],
          env: { TOK: 'he said "hi"' },
        },
      },
    });
    const resolved = resolveCli("ombfake", ["--mcp-config", payload]);
    expect(resolved.command.toLowerCase()).toBe(shim.toLowerCase());
    expect(resolved.args).toEqual(["--mcp-config", payload]);
  });

  it("hands an unknown CLI back untouched so spawn reports its own ENOENT", () => {
    onPath();
    expect(resolveCli("definitely-not-installed", ["-p"])).toEqual({
      command: "definitely-not-installed",
      args: ["-p"],
    });
  });
});

describe("splitCliString", () => {
  it("splits wrapper command + fixed args, honoring quotes", () => {
    expect(splitCliString("/usr/local/bin/ag claude agp")).toEqual(["/usr/local/bin/ag", "claude", "agp"]);
    expect(splitCliString('"/opt/my tools/cli" --flag with space')).toEqual(["/opt/my tools/cli", "--flag", "with", "space"]);
    expect(splitCliString("claude")).toEqual(["claude"]);
    expect(splitCliString("  ")).toEqual([]);
  });

  it("strips quotes from a lone quoted path — the spaced-path case", () => {
    // a user quoting a path with spaces pastes ONE token; the quotes must
    // not survive into the spawn, or every turn dies ENOENT on a filename
    // that literally contains quote characters
    expect(splitCliString('"/opt/my tools/claude"')).toEqual(["/opt/my tools/claude"]);
  });
});

describe("resolveCli with wrapper commands", () => {
  posixIt("puts wrapper subcommands BEFORE invocation args", () => {
    const resolved = resolveCli("/usr/local/bin/ag claude agp", ["--help"]);
    expect(resolved.command).toBe("/usr/local/bin/ag");
    expect(resolved.args).toEqual(["claude", "agp", "--help"]);
  });

  posixIt("strips quotes from a single-token quoted path", () => {
    expect(resolveCli('"/opt/my tools/claude"', ["--help"])).toEqual({
      command: "/opt/my tools/claude",
      args: ["--help"],
    });
  });

  posixIt("keeps an EXISTING unquoted spaced path whole — what the candidates list emits", () => {
    const bin = join(homedir(), ".local", "bin");
    mkdirSync(bin, { recursive: true });
    // simulate "/Applications/My Tools/claude": a real file at a spaced path
    const spacedDir = join(bin, "omb space dir");
    mkdirSync(spacedDir, { recursive: true });
    const spaced = join(spacedDir, "myclaude");
    writeFileSync(spaced, "#!/bin/sh\n");
    expect(resolveCli(spaced, ["--version"])).toEqual({
      command: spaced,
      args: ["--version"],
    });
    // a NONEXISTENT spaced string still splits (wrapper interpretation)
    expect(resolveCli(join(spacedDir, "nope two words"), ["--version"])).toEqual({
      command: join(bin, "omb"),
      args: ["space", "dir/nope", "two", "words", "--version"],
    });
  });
});
