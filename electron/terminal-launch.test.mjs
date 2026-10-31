import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { openBlankTerminal } from "./terminal-launch.mjs";

function launcher(outcomes = {}) {
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    const outcome = outcomes[executable] ?? "throw";
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
    const fake = launcher({ osascript: "spawn" });
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
    const fake = launcher({ "powershell.exe": "spawn" });
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

  it("tries the next Linux terminal after an asynchronous launch error", async () => {
    const fake = launcher({ "gnome-terminal": "spawn" });
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls.map((call) => call.executable)).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
    ]);
    expect(fake.calls.every((call) => call.args.length === 0)).toBe(true);
  });

  it("returns false when no Linux terminal launches", async () => {
    const fake = launcher();
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(false);
  });

  it.each(["foot", "ghostty", "kitty", "alacritty"])(
    "opens a blank %s terminal when the earlier Linux terminals are missing",
    async (terminal) => {
      const fake = launcher({ [terminal]: "spawn" });
      await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
      expect(fake.calls.at(-1)).toEqual({ executable: terminal, args: [], options: undefined });
      expect(fake.calls.every((call) => call.args.length === 0)).toBe(true);
    },
  );

  it("returns false when the launcher throws synchronously", async () => {
    const run = () => {
      throw new Error("launch failed");
    };
    await expect(openBlankTerminal("darwin", run)).resolves.toBe(false);
  });
});
