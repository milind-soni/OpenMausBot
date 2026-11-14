import { it, expect } from "vitest";

import { launchVerificationServer } from "../../scripts/control-omb.ts";

it("creates a conversation and its board row in one request, and rolls the conversation back on a bad board", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text.slice(0, 400)}`).toBe(status);
    return text ? JSON.parse(text) as Record<string, unknown> : null;
  };
  try {
    const listed = await api("GET", "/api/bots") as { bots: Array<{ id: string; threadId: string }> };
    const bot = listed.bots[0]!;
    const created = await api("POST", "/api/board/projects", { name: "看板 e2e" }, 201);
    const projectId = (created!.board as { projects: Array<{ id: string }> }).projects[0]!.id;

    const attributed = await api("POST", `/api/bots/${bot.id}/tasks`, {
      title: "看板归属 e2e", board: { projectId, phase: "build", status: "in_progress", owner: "Lin" },
    }, 201);
    const threadId = (attributed!.task as { threadId: string }).threadId;
    expect((attributed!.board as { tasks: Array<{ threadId: string }> }).tasks.map((task) => task.threadId)).toContain(threadId);

    const before = (await api("GET", `/api/bots/${bot.id}?messages=0`) as { bot: { tasks: unknown[] } }).bot.tasks.length;
    await api("POST", `/api/bots/${bot.id}/tasks`, { title: "坏归属", board: { projectId: "p_missing" } }, 400);
    const after = (await api("GET", `/api/bots/${bot.id}?messages=0`) as { bot: { tasks: unknown[] } }).bot.tasks.length;
    expect(after).toBe(before);

    const board = await api("GET", "/api/board") as { tasks: Array<{ threadId: string; phase: string }>; capabilities: { manage: boolean } };
    expect(board.tasks.find((task) => task.threadId === threadId)?.phase).toBe("build");
    expect(board.capabilities.manage).toBe(true);
  } finally {
    await fixture.close();
  }
}, 60_000);
