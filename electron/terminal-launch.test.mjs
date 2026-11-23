import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { openBlankTerminal } from "./terminal-launch.mjs";

function launcher(outcomes, defaultTerminal = "fixture.desktop") {
  const calls = [];
  const run = (executable, args, options, callback) => {
    if (callback) {
      expect([executable, args]).toEqual(["xdg-terminal-exec", ["--print-id"]]);
      callback(defaultTerminal ? null : new Error("No default terminal"), defaultTerminal);
      return;
    }
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    const outcome = outcomes.shift() ?? "spawn";
    queueMicrotask(() => {
      if (outcome === "throw") child.emit("error", new Error("missing terminal"));
      else child.emit("spawn");
    });
    return child;
  };
  return { calls, run };
}

describe("blank terminal launcher", () => {
  it("opens Terminal on macOS without a command argument", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("darwin", fake.run)).resolves.toBe(true);
    expect(fake.calls).toEqual([
      {
        executable: "osascript",
        args: ["-e", 'tell application "Terminal" to activate'],
        options: undefined,
      },
    ]);
  });

  it("opens a blank PowerShell window on Windows", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("win32", fake.run)).resolves.toBe(true);
    // Not the launcher's own child: that child's stdio is piped to the app and never gets a window.
    expect(fake.calls).toEqual([
      {
        executable: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process powershell.exe"],
        options: { windowsHide: true },
      },
    ]);
  });

  it("opens the configured Linux terminal without a command", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls).toEqual([{ executable: "xdg-terminal-exec", args: [], options: undefined }]);
  });

  it("tries the next Linux terminal after an asynchronous launch error", async () => {
    const fake = launcher(["throw", "spawn"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls.map((call) => call.executable)).toEqual([
      "xdg-terminal-exec",
      "x-terminal-emulator",
    ]);
    expect(fake.calls.every((call) => call.args.length === 0)).toBe(true);
  });

  it("falls back when the desktop launcher has no configured terminal", async () => {
    const fake = launcher(["spawn"], "");
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls).toEqual([{ executable: "x-terminal-emulator", args: [], options: undefined }]);
  });

  it("returns false when no Linux terminal launches", async () => {
    const fake = launcher(["throw", "throw", "throw", "throw", "throw"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(false);
  });

  it("returns false when the launcher throws synchronously", async () => {
    const run = () => {
      throw new Error("launch failed");
    };
    await expect(openBlankTerminal("darwin", run)).resolves.toBe(false);
  });
});
