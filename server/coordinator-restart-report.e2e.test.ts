// A running routine on the parent thread forces the coordinator open during RoutineManager's constructor. A running
// child already marked restart "rerun" settles in that open and reports at once. Both have to be on disk together.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import type { Assignment } from "./runtime/types.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

const CHILD_TITLE = "Ledger check";
const CHILD_ID = "child-cut";
const ROOT_ID = "root-cut";

it("reports a twice-cut own thread when a restart opens the coordinator, without reading ownThreads too early", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as { task: { threadId: string } };
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(200);
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Scout", "--url", server.url]) as { bot: { id: string } };
    const parent = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Parent brief" })).task;
    const child = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: CHILD_TITLE })).task;
    expect(parent.threadId).not.toBe(child.threadId);

    await server.stop();
    const logAt = statSync(server.logPath).size;
    const now = Date.now();
    const runtime = openRuntimeStore(join(server.dataDir, "runtime.db"));
    try {
      runtime.insert(assignment({
        id: ROOT_ID, botId: bot.id, threadId: parent.threadId, status: "waiting", depth: 0, at: now,
      }), { kind: "enqueued", at: now });
      runtime.insert(assignment({
        id: CHILD_ID, rootId: ROOT_ID, parentId: ROOT_ID, botId: bot.id, threadId: child.threadId,
        requesterThreadId: parent.threadId, status: "running", depth: 1, restart: "rerun", at: now,
      }), { kind: "started", at: now });
    } finally {
      runtime.close();
    }
    const routinesPath = join(server.dataDir, "routines.json");
    const disk = existsSync(routinesPath)
      ? JSON.parse(readFileSync(routinesPath, "utf8")) as { runs?: unknown[] }
      : { version: 1, routines: [], runs: [] as unknown[] };
    disk.runs = [...(disk.runs ?? []), {
      id: "run-cut", routineId: "routine-cut", routineName: "Ledger routine", prompt: "Check the ledger",
      target: "bot", botId: bot.id, runOn: "maus", scheduledFor: now, status: "running", manual: false,
      triggerSource: "schedule", threadId: parent.threadId, startedAt: now, createdAt: now,
    }];
    writeFileSync(routinesPath, JSON.stringify(disk));

    await server.start();
    const segment = () => readFileSync(server.logPath).subarray(logAt).toString("utf8");
    await expect.poll(async () => {
      const log = segment();
      const coordinatorErrors = log.split("\n").filter((line) =>
        line.startsWith("coordinator:") && (line.includes("threw") || /Cannot access '[^']+' before initialization/.test(line)));
      const response = await fetch(`${server.url}/api/threads/${parent.threadId}/messages?limit=100`, { headers: { origin: server.url } });
      const body = response.ok ? await response.json() as { messages?: Array<{ roomRequest?: { id?: string; phase?: string }; tool?: { name?: string; ok?: boolean } }> } : { messages: [] };
      const results = (body.messages ?? []).filter((message) => message.roomRequest?.id === CHILD_ID && message.roomRequest.phase === "result");
      return {
        coordinatorErrors,
        count: results.length,
        ok: results.map((message) => message.tool?.ok),
        names: results.map((message) => message.tool?.name ?? ""),
      };
    }, { timeout: 20_000, interval: 200 }).toEqual({
      coordinatorErrors: [],
      count: 1,
      ok: [false],
      names: [expect.stringContaining(`#${CHILD_TITLE}`)],
    });
  } finally {
    await server.close();
  }
}, 120_000);

function assignment(input: {
  id: string; botId: string; threadId: string; status: Assignment["status"]; depth: number; at: number;
  rootId?: string; parentId?: string; requesterThreadId?: string; restart?: Assignment["restart"];
}): Assignment {
  const rootId = input.rootId ?? input.id;
  return {
    id: input.id, rootId, ...(input.parentId ? { parentId: input.parentId } : {}), depth: input.depth,
    origin: { kind: "person", source: "chat", ref: input.requesterThreadId ?? input.threadId, quote: "Check the ledger" },
    requester: input.parentId
      ? { kind: "bot_turn", botId: input.botId, threadId: input.requesterThreadId ?? input.threadId }
      : { kind: "person" },
    assignee: { botId: input.botId, destination: { kind: "work_thread", threadId: input.threadId } },
    mode: "work", reply: "resume", brief: "Check the ledger", status: input.status, level: "ask", levelSource: "own",
    executions: input.status === "running" ? 1 : 0, restarts: input.restart === "rerun" ? 1 : 0,
    ...(input.restart ? { restart: input.restart } : {}),
    ...(input.status === "running" ? { startedAt: input.at } : {}),
    createdAt: input.at, lastActivityAt: input.at, result: "", rework: false, version: 1,
  };
}
