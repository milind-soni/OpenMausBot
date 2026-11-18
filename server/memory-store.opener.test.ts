// The real opener, not an injected runner: how the memory folder or Obsidian is launched.
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawn }));

const { openMemoryLocation } = await import("./memory-store.ts");
const { workspaceDir } = await import("./workspace.ts");

let counter = 0;
const freshBot = () => `opener-bot-${process.pid}-${counter++}`;

beforeEach(() => {
  spawn.mockReset();
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
    setImmediate(() => child.emit("exit", 1));
    return child;
  });
});

describe("openMemoryLocation's opener", () => {
  // Windows starts a GUI program hidden when windowsHide is set, so File Explorer opened an invisible window:
  // the Memory tab's "Show in File Manager" did nothing and showed no error.
  it.each([["folder"], ["obsidian"]] as const)("does not start the Windows %s opener hidden", async (target) => {
    const bot = freshBot();
    await openMemoryLocation(bot, target, "win32");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(target === "folder" ? "explorer.exe" : "rundll32.exe");
    expect(args.at(-1)).toContain(target === "folder" ? workspaceDir(bot) : "obsidian://open?path=");
    expect(options.stdio).toBe("ignore");
    expect(options.shell).toBeFalsy();
    expect(options.windowsHide).toBe(false);
  });
});
