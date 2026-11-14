import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, TaskRecord } from "../store.ts";
import { createInternalThreadRoutes } from "./internal-threads.ts";

const lead = { id: "bot-lead", name: "Lead", section: "Work" } as BotRecord;
const ops = { id: "bot-ops", name: "Ops", section: "Work" } as BotRecord;
const task = (threadId: string, title: string, openedBy?: unknown) => ({ threadId, title, createdAt: 1, openedBy }) as TaskRecord;
const handoff = { id: "h-42", rootId: "h-1", parentId: "h-1", threadId: "t-ops-new", botId: "bot-ops", status: "queued" } as HandoffView;
const tasks: Record<string, TaskRecord[]> = {
  "bot-lead": [task("t-lead", "Lead main")],
  "bot-ops": [task("t-ops-busy", "Weekly report"), task("t-ops-new", "Export CSV", { botId: "bot-lead", name: "Lead", at: 5 })],
};

async function listThreads(from: BotRecord) {
  const route = createInternalThreadRoutes({
    store: { bot: (id: string) => [lead, ops].find((bot) => bot.id === id), bots: [lead, ops], tasks: (id: string) => tasks[id] ?? [] } as never,
    coordinator: { awaitingAnswer: () => false, parkedDirect: () => undefined, activeDirect: (threadId: string) => threadId === "t-ops-new" ? handoff : undefined, active: () => [handoff] } as never,
    from, fromThreadId: "t-own", ownsThread: () => true, shown: () => true,
    threadBusy: (_bot, threadId) => threadId === "t-ops-busy", queuedThreadPosition: () => null,
    queuedReason: (node, showTitle) => `${node.id} waits${showTitle ? " (titles)" : ""}`,
    readBody: async () => ({}),
  });
  let body: { threads: Array<Record<string, unknown>> } | undefined;
  await route({ res: {}, path: "/api/internal/threads", method: "GET", json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
  return body!.threads;
}

describe("list_threads on a queued handoff", () => {
  it("tells the sender why it waits and which handoff it is, without the receiver's thread titles", async () => {
    const row = (await listThreads(lead)).find((thread) => thread.threadId === "t-ops-new");
    expect(row).toMatchObject({ state: "queued", waiting: "h-42 waits", delegationId: "h-42", own: false });
  });

  it("lets the receiver name its own busy threads, and adds nothing to a thread that is not queued", async () => {
    const rows = await listThreads(ops);
    expect(rows.find((thread) => thread.threadId === "t-ops-new")).toMatchObject({ state: "queued", waiting: "h-42 waits (titles)", delegationId: "h-42", own: true });
    const running = rows.find((thread) => thread.threadId === "t-ops-busy");
    expect(running).toMatchObject({ state: "running" });
    expect(running).not.toHaveProperty("waiting");
  });
});

describe("rename_thread on the conversation the turn speaks in", () => {
  async function rename(body: unknown, opts: { own?: TaskRecord; owns?: boolean } = {}) {
    const own = opts.own ?? task("t-own", "Terminei o design e a skill de carrossel pra cl…");
    const renamed: Array<[string, string, string]> = [];
    const route = createInternalThreadRoutes({
      store: {
        bot: () => lead, bots: [lead, ops], tasks: () => [own],
        taskByThread: (botId: string, threadId: string) => botId === lead.id && threadId === own.threadId ? own : undefined,
        renameTask: (botId: string, threadId: string, title: string) => { renamed.push([botId, threadId, title]); return { ...own, title }; },
      } as never,
      coordinator: {} as never,
      from: lead, fromThreadId: "t-own", ownsThread: () => opts.owns ?? true, shown: () => true,
      threadBusy: () => false, queuedThreadPosition: () => null, queuedReason: () => "",
      readBody: async () => body,
    });
    let status = 0;
    let answer: Record<string, unknown> | undefined;
    await route({ res: {}, path: "/api/internal/thread-title", method: "POST", json: (_res: unknown, code: number, value: never) => { status = code; answer = value; } } as never);
    return { status, answer: answer!, renamed };
  }

  it("renames only its own current thread, trimmed to one line of at most 80 characters", async () => {
    const { status, answer, renamed } = await rename({ title: `  ACME:\n carousel design ${"x".repeat(100)}` });
    expect(status).toBe(200);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.slice(0, 2)).toEqual(["bot-lead", "t-own"]);
    expect(renamed[0]![2]).toMatch(/^ACME: carousel design x+$/);
    expect(renamed[0]![2]).toHaveLength(80);
    expect(answer).toMatchObject({ title: renamed[0]![2], previous: "Terminei o design e a skill de carrossel pra cl…" });
  });

  it("refuses an empty title, a conversation that is not the sender's, a room's thread and an automation's chat", async () => {
    expect((await rename({ title: "   " })).status).toBe(400);
    expect((await rename({ title: "New name" }, { owns: false })).status).toBe(403);
    const room = await rename({ title: "New name" }, { own: task("t-room", "Room thread") });
    expect(room.status).toBe(404);
    for (const own of [task("t-own", "Daily brief · Results"), { ...task("t-own", "Run"), routineRunId: "run-1" } as TaskRecord]) {
      const refused = await rename({ title: "New name" }, { own });
      expect(refused.status).toBe(409);
      expect(refused.renamed).toEqual([]);
    }
  });
});
