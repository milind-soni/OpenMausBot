import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cliToLaunch, cliVersionProbe } from "./cli-version-probe.ts";
import { findCliCandidates } from "./env-path.ts";
import { cliVersionReader, type execCli } from "./procs.ts";

afterEach(() => vi.useRealTimers());

it("shares overlapping slow probes and accepts a version after the old eight-second limit", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof execCli>((_cli, _args, options, callback) => {
    expect(options.timeout).toBe(30_000);
    setTimeout(() => callback(null, "2.1.311 (Claude Code)\n"), 16_000);
  });
  const probe = cliVersionProbe("claude", run);
  const first = probe({ PATH: "fixture" });
  expect(probe({ PATH: "fixture" })).toBe(first);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(await first).toEqual({ version: "2.1.311 (Claude Code)" });
  expect(run).toHaveBeenCalledTimes(1);
});

it("never hands a caller the version of a probe started with a different PATH", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof execCli>((_cli, _args, options, callback) => {
    const version = options.env?.PATH === "nvm" ? "2.1.197" : "2.1.321";
    setTimeout(() => callback(null, version), options.env?.PATH === "nvm" ? 1_000 : 2_000);
  });
  const probe = cliVersionProbe("claude", run);
  const homebrew = probe({ PATH: "homebrew" });
  const nvm = probe({ PATH: "nvm" });
  expect(nvm).not.toBe(homebrew);
  expect(probe({ PATH: "nvm" })).toBe(nvm);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await nvm).toEqual({ version: "2.1.197" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await homebrew).toEqual({ version: "2.1.321" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("retries an empty success once within the original thirty-second budget", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof execCli>()
    .mockImplementationOnce((_cli, _args, options, callback) => {
      expect(options.timeout).toBe(30_000);
      setTimeout(() => callback(null, ""), 20_000);
    })
    .mockImplementationOnce((_cli, _args, options, callback) => {
      expect(options.timeout).toBe(10_000);
      callback(null, "codex-cli 0.165.0");
    });
  const result = cliVersionProbe("codex", run)({});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toEqual({ version: "codex-cli 0.165.0" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not retry forever or label an empty success as a missing installation", async () => {
  const run = vi.fn<typeof execCli>((_cli, _args, _options, callback) => callback(null, " \n"));
  expect(await cliVersionProbe("codex", run)({})).toEqual({ reason: "`codex` returned no version. Check again." });
  expect(run).toHaveBeenCalledTimes(2);
});

it("rechecks after settlement and preserves the last version through temporary failures", async () => {
  const failed = Object.assign(new Error("fixture process failure"), { code: 1 });
  const run = vi.fn<typeof execCli>()
    .mockImplementationOnce((_cli, _args, _options, callback) => callback(null, "2.1.311"))
    .mockImplementationOnce((_cli, _args, _options, callback) => callback(failed, ""))
    .mockImplementation((_cli, _args, _options, callback) => callback(null, ""));
  const probe = cliVersionProbe("claude", run);
  expect(await probe({})).toEqual({ version: "2.1.311" });
  expect(await probe({})).toEqual({ version: "2.1.311" });
  expect(await probe({})).toEqual({ version: "2.1.311" });
  expect(run).toHaveBeenCalledTimes(4);
});

it.each(["ENOENT", "EACCES", "EPERM"])("forgets a known version after %s instead of resurrecting it on a later timeout", (code) => {
  const read = cliVersionReader("claude");
  expect(read(null, "2.1.311")).toEqual({ version: "2.1.311" });
  const unavailable = read(Object.assign(new Error("fixture launch failure"), { code }), "");
  expect(unavailable).toEqual({ reason: expect.stringContaining(code === "ENOENT" ? "CLI not found" : "file permissions") });
  expect(read(Object.assign(new Error("fixture timeout"), { killed: true }), "")).toEqual({ reason: expect.stringContaining("took longer than 30 seconds") });
});

it("reports an unrecognized failure without claiming the CLI is missing or exposing its output", () => {
  expect(cliVersionReader("codex")(new Error("private diagnostic"), "private output")).toEqual({
    reason: "`codex` could not report its version. Check that it starts in a terminal, then check again.",
  });
});

it("does not report one copy's version for another copy that PATH now finds first", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-cli-probe-"));
  try {
    const [newer, older] = ["newer", "older"].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      for (const file of ["claude", "claude.cmd"]) writeFileSync(join(dir, file), "");
      return dir;
    });
    const failed = Object.assign(new Error("fixture process failure"), { code: 1 });
    const run = vi.fn<typeof execCli>()
      .mockImplementationOnce((_cli, _args, _options, callback) => callback(null, "2.1.321"))
      .mockImplementationOnce((_cli, _args, _options, callback) => callback(failed, ""))
      .mockImplementation((_cli, _args, _options, callback) => callback(null, "2.1.197"));
    const probe = cliVersionProbe("claude", run);
    expect(await probe({ PATH: newer })).toEqual({ version: "2.1.321" });
    expect(await probe({ PATH: [older, newer].join(delimiter) })).toEqual({ reason: expect.stringContaining("could not report its version") });
    expect(await probe({ PATH: [older, newer].join(delimiter) })).toEqual({ version: "2.1.197" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("launches the checked copy by its path on Windows, where spawn resolves the app's PATH rather than the turn's", () => {
  const checked = join("C:", "Users", "me", "AppData", "Roaming", "npm", "claude.cmd");
  expect(cliToLaunch("claude", checked, "win32")).toBe(checked);
  expect(cliToLaunch("claude", undefined, "win32")).toBe("claude"); // nothing found on the turn's PATH: unchanged
  for (const platform of ["darwin", "linux"] as const) expect(cliToLaunch("claude", "/opt/homebrew/bin/claude", platform)).toBe("claude"); // POSIX spawn already uses the turn's PATH
});

it("checks the version of the copy the caller's PATH finds, by its path on Windows, so a PATH change cannot swap the copy mid-check", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-cli-probe-win-"));
  try {
    for (const file of ["claude", "claude.cmd"]) writeFileSync(join(root, file), "");
    const checked = findCliCandidates("claude", root)[0];
    const run = vi.fn<typeof execCli>((_cli, _args, _options, callback) => callback(null, "2.1.321"));
    expect(await cliVersionProbe("claude", run, "win32")({ PATH: root })).toEqual({ version: "2.1.321" });
    expect(run.mock.calls[0]?.[0]).toBe(checked); // execCli on Windows resolves a bare name with the app's PATH
    expect(await cliVersionProbe("claude", run, "linux")({ PATH: root })).toEqual({ version: "2.1.321" });
    expect(run.mock.calls[1]?.[0]).toBe("claude"); // POSIX lookups already use the caller's PATH
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
