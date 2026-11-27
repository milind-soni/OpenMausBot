import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import { planBox, visibleInBox } from "../bot-box/plan.ts";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { piSessionDir, piSessionPath } from "./pi-session.ts";
import { PiDriver } from "./pi.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), mkdtempSync: vi.fn(fs.mkdtempSync) };
});

const cli = fileURLToPath(new URL("../testing/fake-pi-cli.ts", import.meta.url));
const create = () => PiDriver.create({ instanceId: "pi-session-spawn", displayName: undefined, enabled: true, environment: {}, config: { cli, fullAuto: false } });
afterEach(() => { engineHomes.stop(); vi.restoreAllMocks(); vi.mocked(mkdirSync).mockRestore(); vi.mocked(mkdtempSync).mockClear(); });

describe("Pi session spawn setup", () => {
  it.skipIf(process.platform === "win32")("isolates audience/conversation sandbox plans while resuming persisted turns", async () => {
    ensureDirs();
    chmodSync(cli, 0o755);
    const dump = join(mkdtempSync(join(tmpdir(), "omb-pi-audience-")), "rpc.jsonl");
    const instance = await PiDriver.create({ instanceId: "pi-session-spawn", displayName: undefined, enabled: true,
      environment: { FAKE_PI_DUMP: dump, FAKE_PI_PERSIST_SESSION: "1", FAKE_PI_SESSION_FILE_IN_STATE_ONLY: "1" }, config: { cli, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    const spawned = vi.spyOn(procs, "spawnCli");
    let audience: "member:alice" | "member:bob" | "team" = "member:alice";
    engineHomes.start({ dataDir: DATA_DIR, audienceOf: () => audience, threads: () => [] });
    // Keep the fake process environment unchanged; audience identity still comes from the real async context.
    vi.spyOn(engineHomes, "forSpawn").mockReturnValue(null);
    const turns: Array<{ dir: string; path: string; plan: ReturnType<typeof planBox> }> = [];
    const send = async (threadId: string, text: string, resumeCursor?: string) => engineHomes.within(threadId, async () => {
      const turn = { threadId, botId: "bot-a", text, resumeCursor };
      const dir = piSessionDir(turn, "pi-session-spawn");
      const before = spawned.mock.calls.length;
      const { turnId } = await instance.adapter.sendTurn(turn);
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const started = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId);
      if (started?.type !== "session.started" || !started.sessionId) throw new Error("missing session file");
      const call = spawned.mock.calls.slice(before).find(([, args]) => args.includes("--session-dir"))!;
      expect(call[2]!.box).toEqual({ rw: [dir, expect.stringContaining("omb-pi-mcp-")], engine: "piAgent" });
      const setup = { dataDir: DATA_DIR, home: join(DATA_DIR, ".."), codeRoots: [], engineRoots: [], bridges: [] };
      const request = { command: cli, args: call[1], env: {}, audience: { teamReadOnly: audience !== "team" } };
      expect(visibleInBox(planBox(setup, request), dir)).toBe("none");
      const plan = planBox(setup, { ...request, ...(call[2]!.box as { rw: string[] }) });
      turns.push({ dir, path: started.sessionId, plan });
      return started.sessionId;
    }, "bot-a");
    try {
      const first = await send("thread-a", "first");
      expect(await send("thread-a", "second", first)).toBe(first);
      expect(JSON.parse(readFileSync(first, "utf8"))).toEqual(["first", "second"]);
      const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.find((row) => row.loadedHistory)?.loadedHistory).toEqual(["first"]);
      expect(rows.filter((row) => row.rpc).map((row) => row.rpc)).toEqual(["new_session", "switch_session"]);
      await engineHomes.within("thread-b", async () => {
        expect(piSessionPath({ resumeCursor: first }, piSessionDir({ threadId: "thread-b", botId: "bot-a" }, "pi-session-spawn"))).toBeNull();
      });
      await send("thread-b", "another conversation");
      audience = "member:bob";
      await engineHomes.within("thread-a", async () => {
        expect(piSessionPath({ resumeCursor: first }, piSessionDir({ threadId: "thread-a", botId: "bot-a" }, "pi-session-spawn"))).toBeNull();
      });
      await send("thread-a", "another audience");
      audience = "team";
      await send("thread-a", "team conversation");
      for (const own of turns) {
        expect(visibleInBox(own.plan, own.path)).toBe("rw");
        for (const other of turns.filter((entry) => entry.dir !== own.dir)) expect(visibleInBox(own.plan, other.path)).toBe("none");
        expect(visibleInBox(own.plan, join(DATA_DIR, "config.json"))).toBe("none");
        expect(visibleInBox(own.plan, join(DATA_DIR, "pi-sessions", "legacy.jsonl"))).toBe("none");
      }
      expect(new Set(turns.map((turn) => turn.dir)).size).toBe(4);
      engineHomes.stop();
      expect(piSessionPath({ resumeCursor: first }, piSessionDir({ threadId: "different-thread", botId: "bot-a" }, "pi-session-spawn"))).toBeNull();
      expect(piSessionPath({ resumeCursor: first }, dirname(first))).toBe(first);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("refuses a Team Cloud turn without audience context before creating credentials", async () => {
    ensureDirs();
    chmodSync(cli, 0o755);
    const instance = await create();
    engineHomes.start({ dataDir: DATA_DIR, audienceOf: () => "team", threads: () => [] });
    vi.mocked(mkdtempSync).mockClear();
    try {
      await expect(instance.adapter.sendTurn({ threadId: "missing-audience", text: "hi" }))
        .rejects.toThrow("requires an audience context");
      expect(mkdtempSync).not.toHaveBeenCalled();
    } finally {
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
      if (String(path).startsWith(join(DATA_DIR, "pi-sessions"))) throw new Error("session directory is not writable");
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
