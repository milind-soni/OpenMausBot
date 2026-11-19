import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import { planBox, visibleInBox } from "../bot-box/plan.ts";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { piSessionDir } from "./pi-session.ts";
import { PiDriver } from "./pi.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), mkdtempSync: vi.fn(fs.mkdtempSync) };
});

const cli = fileURLToPath(new URL("../testing/fake-pi-cli.ts", import.meta.url));
const create = () => PiDriver.create({ instanceId: "pi-session-spawn", displayName: undefined, enabled: true, environment: {}, config: { cli, fullAuto: false } });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(mkdirSync).mockRestore(); vi.mocked(mkdtempSync).mockClear(); });

describe("Pi session spawn setup", () => {
  it.skipIf(process.platform === "win32")("binds persisted sessions through the data tmpfs without exposing sibling data", async () => {
    ensureDirs();
    chmodSync(cli, 0o755);
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    const spawned = vi.spyOn(procs, "spawnCli");
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "pi-box-session", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const call = spawned.mock.calls.find(([, args]) => args.includes("--session-dir"));
      expect(call).toBeDefined();
      const options = call![2]!;
      expect(options.box).toEqual({ rw: [piSessionDir()] });
      // Put DATA_DIR under a home in the plan, reproducing the default hidden-data layout
      // even when the test runner's OMB_DATA_DIR is outside the real home.
      const home = join(DATA_DIR, "..");
      const request = { command: cli, args: call![1], cwd: homedir(), env: { HOME: home } };
      const setup = { dataDir: DATA_DIR, home, codeRoots: [], engineRoots: [], bridges: [] };
      const hidden = planBox(setup, request);
      expect(visibleInBox(hidden, piSessionDir())).toBe("none");
      for (let turn = 0; turn < 2; turn++) {
        const plan = planBox(setup, { ...request, ...(options.box as { rw: string[] }) });
        expect(visibleInBox(plan, join(piSessionDir(), "saved.jsonl"))).toBe("rw");
        expect(visibleInBox(plan, join(DATA_DIR, "config.json"))).toBe("none");
        expect(visibleInBox(plan, join(DATA_DIR, "pi-sessions-other", "secret"))).toBe("none");
      }
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("creates no credential temp directory when the session directory cannot be prepared", async () => {
    ensureDirs();
    chmodSync(cli, 0o755);
    const instance = await create();
    const originalMkdir = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(mkdtempSync).mockClear();
    vi.mocked(mkdirSync).mockImplementation((path, options) => {
      if (path === piSessionDir()) throw new Error("session directory is not writable");
      return originalMkdir.mkdirSync(path, options as { recursive: true });
    });
    const spawned = vi.spyOn(procs, "spawnCli");
    try {
      await expect(instance.adapter.sendTurn({ threadId: "pi-session-setup-fails", text: "hi" }))
        .rejects.toThrow("session directory is not writable");
      expect(vi.mocked(mkdtempSync).mock.calls.filter(([prefix]) => String(prefix).includes("omb-pi-mcp-"))).toEqual([]);
      expect(spawned).not.toHaveBeenCalled();
    } finally {
      await instance.dispose();
    }
  });
});
