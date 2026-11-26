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
  "bot-ops": [
    task("t-ops-busy", "Weekly report"),
    task("t-ops-new", "Export CSV", { botId: "bot-lead", name: "Lead", at: 5 }),
    { ...task("t-ops-closed", "Closed question"), activity: "waiting-on-you", closedBy: { botId: ops.id, name: ops.name, at: 2 } },
    { ...task("t-ops-open", "Open question"), activity: "waiting-on-you" },
  ],
};

async function listThreads(from: BotRecord) {
  const route = createInternalThreadRoutes({
    store: { bot: (id: string) => [lead, ops].find((bot) => bot.id === id), bots: [lead, ops], tasks: (id: string) => tasks[id] ?? [] } as never,
    coordinator: { awaitingAnswer: () => false, parkedDirect: () => undefined, activeDirect: (threadId: string) => threadId === "t-ops-new" ? handoff : undefined, active: () => [handoff] } as never,
    from, fromThreadId: "t-own", ownsThread: () => true, shown: () => true, mainThreadTasks: () => [],
    threadBusy: (_bot, threadId) => threadId === "t-ops-busy", queuedThreadPosition: () => null,
    queuedReason: (node, showTitle) => `${node.id} waits${showTitle ? " (titles)" : ""}`,
    readBody: async () => ({}),
  });
  let body: { threads: Array<Record<string, unknown>> } | undefined;
  await route({ res: {}, url: new URL("http://x/api/internal/threads"), path: "/api/internal/threads", method: "GET", json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
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

  it("reports a closed thread as closed even when its activity still says it waits on the person", async () => {
    const rows = await listThreads(ops);
    expect(rows.find((thread) => thread.threadId === "t-ops-closed")).toMatchObject({ state: "closed" });
    expect(rows.find((thread) => thread.threadId === "t-ops-open")).toMatchObject({ state: "waiting-on-you" });
  });
});

describe("list_threads past the first 100", () => {
  async function page(query: string) {
    const many = Array.from({ length: 130 }, (_, index) => task(`t-${index}`, `Event ${index}`, undefined));
    many.forEach((row, index) => { row.createdAt = index; });
    const route = createInternalThreadRoutes({
      store: { bot: () => undefined, bots: [lead], tasks: (id: string) => id === lead.id ? many : [] } as never,
      coordinator: { awaitingAnswer: () => false, parkedDirect: () => undefined, activeDirect: () => undefined, active: () => [] } as never,
      from: lead, fromThreadId: "t-own", ownsThread: () => true, shown: () => true, mainThreadTasks: () => [],
      threadBusy: () => false, queuedThreadPosition: () => null, queuedReason: () => "", readBody: async () => ({}),
    });
    let body: { threads: Array<{ threadId: string }>; total: number; page: number; pageSize: number } | undefined;
    await route({ res: {}, url: new URL(`http://x/api/internal/threads${query}`), path: "/api/internal/threads", method: "GET",
      json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
    return body!;
  }

  it("gives the newest 100 first and the older ones on page 2, with the total", async () => {
    const first = await page("");
    expect(first).toMatchObject({ total: 130, page: 1, pageSize: 100 });
    expect(first.threads).toHaveLength(100);
    expect(first.threads[0]!.threadId).toBe("t-129");
    const second = await page("?page=2");
    expect(second).toMatchObject({ total: 130, page: 2 });
    expect(second.threads.map((thread) => thread.threadId)).toEqual(Array.from({ length: 30 }, (_, index) => `t-${29 - index}`));
    expect((await page("?page=0")).page).toBe(1);
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
      from: lead, fromThreadId: "t-own", ownsThread: () => opts.owns ?? true, shown: () => true, mainThreadTasks: () => [],
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

describe("set_main_thread on the sender's own threads", () => {
  const leadTasks = [
    task("t-own", "Today"),
    task("t-yesterday", "Yesterday"),
    { ...task("t-run", "Daily brief run"), routineRunId: "run-1" } as TaskRecord,
    { ...task("t-archived", "Old"), archivedAt: 3 } as TaskRecord,
  ];
  async function setMain(body: unknown, opts: { owns?: boolean } = {}) {
    const patched: Array<[string, Partial<BotRecord>]> = [];
    const route = createInternalThreadRoutes({
      store: {
        bot: () => lead, bots: [lead, ops], tasks: (id: string) => id === lead.id ? leadTasks : tasks[id] ?? [],
        taskByThread: (botId: string, threadId: string) => (botId === lead.id ? leadTasks : tasks[botId] ?? []).find((one) => one.threadId === threadId),
        patchBot: (botId: string, patch: Partial<BotRecord>) => { patched.push([botId, patch]); return lead; },
      } as never,
      coordinator: {} as never,
      from: lead, fromThreadId: "t-own", ownsThread: () => opts.owns ?? true, shown: () => true,
      mainThreadTasks: (botId: string) => botId === lead.id ? leadTasks : [],
      threadBusy: () => false, queuedThreadPosition: () => null, queuedReason: () => "",
      readBody: async () => body,
    });
    let status = 0;
    let answer: Record<string, unknown> | undefined;
    await route({ res: {}, path: "/api/internal/main-thread", method: "POST", json: (_res: unknown, code: number, value: never) => { status = code; answer = value; } } as never);
    return { status, answer: answer!, patched };
  }

  it("makes the thread it speaks in, or one of its own it names, its main thread", async () => {
    const here = await setMain({});
    expect(here.status).toBe(200);
    expect(here.patched).toEqual([["bot-lead", { mainThreadChoice: "t-own", mainThreadKept: undefined }]]);
    const named = await setMain({ mainThreadId: "t-yesterday" });
    expect(named.answer).toMatchObject({ threadId: "t-yesterday", title: "Yesterday" });
    expect(named.patched).toEqual([["bot-lead", { mainThreadChoice: "t-yesterday", mainThreadKept: undefined }]]);
  });

  it("clears its own choice so the main thread goes back to the default", async () => {
    const cleared = await setMain({ clear: true });
    expect(cleared.status).toBe(200);
    expect(cleared.patched).toEqual([["bot-lead", { mainThreadChoice: undefined, mainThreadKept: undefined }]]);
  });

  it("refuses a teammate's thread, an automation run, an archived thread and a sender that does not own its conversation", async () => {
    const teammate = await setMain({ mainThreadId: "t-ops-busy" });
    expect(teammate.status).toBe(404);
    expect((await setMain({ mainThreadId: "t-run" })).status).toBe(409);
    expect((await setMain({ mainThreadId: "t-archived" })).status).toBe(409);
    expect((await setMain({}, { owns: false })).status).toBe(403);
    expect((await setMain({ clear: true }, { owns: false })).patched).toEqual([]);
    for (const threadId of ["t-ops-busy", "t-run", "t-archived"]) expect((await setMain({ mainThreadId: threadId })).patched).toEqual([]);
  });
});
