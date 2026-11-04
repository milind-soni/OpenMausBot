// POSIX only: the fake engines are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = workerPort(18800, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("bulk delete tasks e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const taskIds = async (botId: string): Promise<string[]> => (await getBot(botId)).tasks.map((t: any) => t.threadId);
  const newBot = async (name: string, selection?: unknown) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, ...(selection ? { modelSelection: selection } : {}) });
    return bot;
  };
  const newTask = async (botId: string): Promise<string> => (await api("POST", `/api/bots/${botId}/tasks`, {})).body.task.threadId;
  const waitUntil = async (predicate: () => Promise<boolean>, timeout: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-bulk-delete-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claudeSlow: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    writeFileSync(finishGate, "go");
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("deletes the listed tasks, reports unknown ids per thread, and leaves the rest", async () => {
    const bot = await newBot("Bulk A");
    const first = bot.threadId;
    const second = await newTask(bot.id);
    const third = await newTask(bot.id);
    const fourth = await newTask(bot.id);

    const res = await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [second, third, "never-existed"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted.sort()).toEqual([second, third].sort());
    expect(res.body.refused).toEqual([{ threadId: "never-existed", reason: "not-found" }]);
    expect(res.body.bot.id).toBe(bot.id);
    expect((await taskIds(bot.id)).sort()).toEqual([first, fourth].sort());
    expect((await getBot(bot.id)).threadId).toBe(fourth);
  });

  it("replaces the conversation with a fresh one when every task is deleted", async () => {
    const bot = await newBot("Bulk B");
    const all = [bot.threadId, await newTask(bot.id), await newTask(bot.id)];

    const res = await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: all });

    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([...all].sort());
    const remaining = await taskIds(bot.id);
    expect(remaining).toHaveLength(1);
    expect(all).not.toContain(remaining[0]);
    expect((await getBot(bot.id)).threadId).toBe(remaining[0]);
  });

  it("refuses a running task per id but still deletes the others", async () => {
    rmSync(finishGate, { force: true });
    const bot = await newBot("Bulk C", { instanceId: "claudeSlow", model: "claude-fake" });
    const running = bot.threadId;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "go" })).status).toBe(202);
    await waitUntil(async () => (await getBot(bot.id))?.busy === true, 15_000, "turn never started");
    const idle = await newTask(bot.id);

    const res = await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [running, idle] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted).toEqual([idle]);
    expect(res.body.refused).toEqual([{ threadId: running, reason: "busy" }]);
    expect(await taskIds(bot.id)).toContain(running);
    expect(await taskIds(bot.id)).not.toContain(idle);
    writeFileSync(finishGate, "go");
    await waitUntil(async () => (await getBot(bot.id))?.busy === false, 15_000, "turn never finished");
  });

  it("rejects malformed bodies and unknown bots", async () => {
    const bot = await newBot("Bulk D");
    const url = `/api/bots/${bot.id}/tasks/delete`;
    for (const body of [{}, { threadIds: "x" }, { threadIds: [] }, { threadIds: [1] }, { threadIds: [""] }, [], { threadIds: Array.from({ length: 501 }, (_, i) => `t${i}`) }]) {
      const res = await api("POST", url, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await api("POST", "/api/bots/no-such-bot/tasks/delete", { threadIds: ["a"] })).status).toBe(404);
    expect(await taskIds(bot.id)).toEqual([bot.threadId]);
  });

  const newRoom = async (name: string, bot: any) => (await api("POST", "/api/groups", {
    name, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
  })).body.group;
  const roomTaskIds = async (groupId: string): Promise<string[]> =>
    (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === groupId).tasks.map((t: any) => t.threadId);

  it("deletes channel tasks in one request and keeps the channel pointing at a survivor", async () => {
    const bot = await newBot("Bulk F");
    const room = await newRoom("Bulk room", bot);
    const first = room.threadId;
    const second = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;
    const third = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;

    const res = await api("POST", `/api/groups/${room.id}/tasks/delete`, { threadIds: [third, second, "never-existed"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted.sort()).toEqual([second, third].sort());
    expect(res.body.refused).toEqual([{ threadId: "never-existed", reason: "not-found" }]);
    expect(res.body.group.id).toBe(room.id);
    expect(res.body.group.threadId).toBe(first);
    expect(await roomTaskIds(room.id)).toEqual([first]);
  });

  it("refuses to delete every task of a channel and changes nothing", async () => {
    const bot = await newBot("Bulk G");
    const room = await newRoom("Bulk room 2", bot);
    const second = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;

    const res = await api("POST", `/api/groups/${room.id}/tasks/delete`, { threadIds: [room.threadId, second] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least one");
    expect((await roomTaskIds(room.id)).sort()).toEqual([room.threadId, second].sort());
  });

  it("refuses a channel thread with a running turn per id but still deletes the others", async () => {
    rmSync(finishGate, { force: true });
    const bot = await newBot("Bulk J", { instanceId: "claudeSlow", model: "claude-fake" });
    const room = await newRoom("Bulk room busy", bot);
    const second = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;
    const third = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "go", threadId: room.threadId })).status).toBe(202);
    await waitUntil(async () => (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === room.id)?.working === true, 15_000, "room turn never started");

    const res = await api("POST", `/api/groups/${room.id}/tasks/delete`, { threadIds: [room.threadId, second] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted).toEqual([second]);
    expect(res.body.refused).toEqual([{ threadId: room.threadId, reason: "busy" }]);
    expect((await roomTaskIds(room.id)).sort()).toEqual([room.threadId, third].sort());
    writeFileSync(finishGate, "go");
    await waitUntil(async () => (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === room.id)?.working === false, 15_000, "room turn never finished");
  });

  it("rejects malformed channel bodies, unknown channels and bot-to-bot channels", async () => {
    const bot = await newBot("Bulk H");
    const room = await newRoom("Bulk room 3", bot);
    for (const body of [{}, { threadIds: "x" }, { threadIds: [] }, { threadIds: [1] }, [], { threadIds: Array.from({ length: 501 }, (_, i) => `t${i}`) }]) {
      expect((await api("POST", `/api/groups/${room.id}/tasks/delete`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await api("POST", "/api/groups/no-such-room/tasks/delete", { threadIds: ["a"] })).status).toBe(404);
    expect(await roomTaskIds(room.id)).toEqual([room.threadId]);
  });

  it("keeps the single channel-task DELETE working", async () => {
    const bot = await newBot("Bulk I");
    const room = await newRoom("Bulk room 4", bot);
    const second = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.task.threadId;
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${second}`)).status).toBe(200);
    expect(await roomTaskIds(room.id)).toEqual([room.threadId]);
    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${room.threadId}`)).status).toBe(400);
  });

  it("keeps the single-task DELETE working on the same helper", async () => {
    const bot = await newBot("Bulk E");
    const extra = await newTask(bot.id);
    expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${extra}`)).status).toBe(200);
    expect(await taskIds(bot.id)).toEqual([bot.threadId]);
    expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${extra}`)).status).toBe(404);
  });
});
