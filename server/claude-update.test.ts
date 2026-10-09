import type { ExecFileOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_CODE_PACKAGE, isAppInstalledClaude, updateClaudeCli, type AppCopy } from "./claude-update.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { npmPackageOf } from "./engine-install.ts";
import { registerPathDir, resetPathCacheForTests } from "./env-path.ts";

type Callback = (error: Error | null, stdout: string, stderr?: string) => void;

const noAppCopy: AppCopy = { owns: () => false, reinstall: async () => { throw new Error("not the app's copy"); } };

describe("updateClaudeCli", () => {
  it("runs the official updater before verifying the installed version", async () => {
    const calls: Array<{ cli: string; args: string[]; options: ExecFileOptions }> = [];
    const execute = (cli: string, args: string[], options: ExecFileOptions, callback: Callback) => {
      calls.push({ cli, args, options });
      callback(null, args[0] === "--version" ? "2.1.257 (Claude Code)\n" : "updated\n");
    };

    await expect(updateClaudeCli("/opt/claude", { PATH: "/bin" }, execute, noAppCopy)).resolves.toEqual({
      version: "2.1.257 (Claude Code)",
    });
    expect(calls.map((call) => call.args)).toEqual([["update"], ["--version"]]);
    expect(calls[0].options).toMatchObject({ timeout: 180_000, killSignal: "SIGKILL" });
    expect(calls[0].options.env).toEqual({ PATH: "/bin" });
  });

  it("does not probe the version after a failed update and gives a manual fallback", async () => {
    let calls = 0;
    const execute = (_cli: string, _args: string[], _options: ExecFileOptions, callback: Callback) => {
      calls += 1;
      const error = Object.assign(new Error("exit 1"), { code: 1, stderr: "permission denied by updater\nmore" });
      callback(error, "", "permission denied by updater");
    };

    await expect(updateClaudeCli("claude", {}, execute, noAppCopy)).rejects.toThrow(
      "Claude update failed: permission denied by updater. Run `claude update` in Terminal",
    );
    expect(calls).toBe(1);
  });

  it("reports when the update finishes but version verification fails", async () => {
    const execute = (_cli: string, args: string[], _options: ExecFileOptions, callback: Callback) => {
      if (args[0] === "update") callback(null, "updated");
      else callback(Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "");
    };

    await expect(updateClaudeCli("claude", {}, execute, noAppCopy)).rejects.toThrow(
      "Claude finished updating, but OpenMausBot could not verify",
    );
  });

  // The app's copy shadows every other Claude on PATH. `claude update` on it
  // reinstalled through some other npm and left it old, so the turn kept
  // failing "does not support this model" however often the person updated.
  it("updates the copy the app installed through npm, not `claude update`, and reports that copy's version", async () => {
    const calls: string[][] = [];
    const reinstalled: Array<{ cli: string; env: NodeJS.ProcessEnv }> = [];
    const execute = (_cli: string, args: string[], _options: ExecFileOptions, callback: Callback) => {
      calls.push(args);
      callback(null, "2.1.295 (Claude Code)\n");
    };
    const own: AppCopy = { owns: () => true, reinstall: async (cli, env) => { reinstalled.push({ cli, env }); } };

    await expect(updateClaudeCli("claude", { PATH: "/engines" }, execute, own)).resolves.toEqual({ version: "2.1.295 (Claude Code)" });
    expect(reinstalled).toEqual([{ cli: "claude", env: { PATH: "/engines" } }]);
    expect(calls).toEqual([["--version"]]);
  });

  it("reports an npm failure on the app's copy without probing the version", async () => {
    let calls = 0;
    const execute = (_cli: string, _args: string[], _options: ExecFileOptions, callback: Callback) => {
      calls += 1;
      callback(null, "2.1.272 (Claude Code)\n");
    };
    const own: AppCopy = { owns: () => true, reinstall: async () => { throw new Error("npm could not install @anthropic-ai/claude-code on this server."); } };

    await expect(updateClaudeCli("claude", {}, execute, own)).rejects.toThrow(
      "Claude update failed: npm could not install @anthropic-ai/claude-code on this server.",
    );
    expect(calls).toBe(0);
  });
});

describe("isAppInstalledClaude", () => {
  it("is true only when the claude a turn runs is the one in the app's engines folder", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-claude-update-"));
    try {
      const engines = join(root, "tools", "npm", "bin");
      const other = join(root, "elsewhere");
      mkdirSync(engines, { recursive: true });
      mkdirSync(other, { recursive: true });
      // Windows discovery follows PATHEXT; an extensionless POSIX stub is not a runnable CLI there.
      const name = process.platform === "win32" ? "claude.cmd" : "claude";
      writeFileSync(join(engines, name), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
      resetPathCacheForTests();
      registerPathDir(engines);

      expect(isAppInstalledClaude("claude", engines)).toBe(true);
      // Another engines folder, a configured path, or a wrapper is not the app's copy.
      expect(isAppInstalledClaude("claude", other)).toBe(false);
      expect(isAppInstalledClaude("/opt/homebrew/bin/claude", engines)).toBe(false);
      expect(isAppInstalledClaude("/usr/local/bin/ag claude agp", engines)).toBe(false);
    } finally {
      resetPathCacheForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the same package ClaudeDriver installs", () => {
    expect(npmPackageOf(ClaudeDriver.install)).toBe(CLAUDE_CODE_PACKAGE);
  });
});
