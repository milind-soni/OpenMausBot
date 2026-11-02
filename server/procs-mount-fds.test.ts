import type { ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { botBox } from "./bot-box/box.ts";
import { bwrapArgs, type BoxPlan } from "./bot-box/plan.ts";
import { killCliTree, spawnCli } from "./procs.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, closeSync: vi.fn(fs.closeSync) };
});
const { closeSync: realCloseSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

describe.runIf(process.platform === "linux")("spawnCli pinned mount cleanup", () => {
  it.each([
    { outcome: "succeeds", args: ["-e", ""] },
    { outcome: "throws", args: ["\0"] },
  ])("keeps a reused descriptor open when spawn $outcome", async ({ outcome, args }) => {
    const source = mkdtempSync(join(tmpdir(), "omb-spawn-pin-"));
    const plan: BoxPlan = { mounts: [
      { kind: "ro", source, target: "/source" },
      { kind: "ro", source, target: "/alias" },
    ], options: [], net: "shared", writable: [], botId: null };
    const extraFds: number[] = [];
    bwrapArgs(plan, extraFds);
    const pinned = extraFds[0]!;
    let replacement: number | undefined;
    let child: ChildProcess | undefined;
    const wrap = vi.spyOn(botBox, "wrap").mockReturnValue({
      command: process.execPath, args, env: {}, plan, token: null, release: () => {}, unbrokered: [], extraFds,
    });
    vi.mocked(closeSync).mockImplementation((fd) => {
      realCloseSync(fd);
      if (fd === pinned && replacement === undefined) replacement = openSync(source, "r");
    });
    try {
      expect(extraFds).toEqual([pinned, pinned]);
      const start = () => { child = spawnCli(process.execPath, [], { box: true, stdio: ["pipe", "pipe", "pipe"] }); };
      if (outcome === "throws") expect(start).toThrow(/null bytes/);
      else start();
      expect(replacement).toBe(pinned);
      expect(fstatSync(replacement!).isDirectory()).toBe(true);
    } finally {
      wrap.mockRestore();
      vi.mocked(closeSync).mockImplementation(realCloseSync);
      try { realCloseSync(replacement ?? pinned); } catch {}
      if (child) await killCliTree(child);
      rmSync(source, { recursive: true, force: true });
    }
  });
});
