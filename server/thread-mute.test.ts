import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { callTool, type ToolCallContext } from "./drivers/agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";
import { createChiefNotices } from "./host/chief-notices.ts";
import { INCIDENT_HARD_LIMIT } from "./incidents.ts";
import { closeMessageDb } from "./message-db.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { createInternalThreadRoutes } from "./routes/internal-threads.ts";
import { Store } from "./store.ts";
import { createThreadMute, mutedThreadNotifies, THREAD_MUTE_POLICY, threadNotificationsMuted, type ThreadMuteDefault, type ThreadMuteNotice } from "./thread-mute.ts";

const opener = { botId: "chief", name: "Chief", at: 1 };
const off: ThreadMuteDefault = { botOpened: false, mainThreadId: "main" };
const on: ThreadMuteDefault = { botOpened: true, mainThreadId: "main" };

describe("which notifications a muted thread still sends", () => {
  // true: the muted thread still sends it. A failure is then withheld only once the Chief took its report (below).
  const expected: Record<ThreadMuteNotice, boolean> = {
    done: false,
    "delegation-settled": false,
    mention: false,
    "routine-deferred": false,
    approval: true,
    question: true,
    "sign-in": true,
    "turn-failed": true,
    "routine-failed": true,
    incident: true,
    "peer-approval": true,
    spend: true,
    brief: true,
  };

  it("covers every notification kind", () => {
    expect(Object.keys(THREAD_MUTE_POLICY).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected) as Array<[ThreadMuteNotice, boolean]>)("%s, muted", (notice, sent) => {
    expect(mutedThreadNotifies(notice)).toBe(sent);
  });

  it("keeps every gate only the person can lift", () => {
    for (const gate of ["approval", "question", "sign-in", "peer-approval"] as const) expect(THREAD_MUTE_POLICY[gate]).toBe("kept");
    for (const failure of ["turn-failed", "routine-failed"] as const) expect(THREAD_MUTE_POLICY[failure]).toBe("kept-unless-chief-took-it");
  });
});

describe("the brief in a muted thread", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("still reaches the person when the person muted the main agent's chat, while the chat's other notices stop", () => {
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const chief = store.createBot({ name: "Charlie" });
    const main = store.createTask(chief.id, "Charlie", false)!;
    store.patchTask(chief.id, main.threadId, { notificationsMuted: true, notificationsMutedBy: "person" });
    const sent: Notification[] = [];
    const mute = createThreadMute({
      store, config: {}, mainThread: () => main.threadId, notify: () => {}, chief: () => { throw new Error("no report here"); }, assignerOf: () => undefined,
    });
    const bot = store.bot(chief.id)!;
    // The brief notifies in the bot's main chat.
    for (const kind of ["done", "brief"] as const) {
      const notification = buildNotification(kind, bot, main.threadId, "Your 3pm with Acme moved to 4pm");
      if (notification && mute.lets(notification)) sent.push(notification);
    }
    expect(sent).toEqual([expect.objectContaining({ kind: "brief", botId: chief.id, threadId: main.threadId })]);
  });
});

describe("what a muted thread reports through the Chief", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  // The Chief's report turns of the latest team(); a refusal's handler runs before this settles, being registered first.
  let turns: Array<Promise<unknown>> = [];
  const flush = () => Promise.allSettled(turns);
  /** Quinn's muted thread in a fresh home; a Chief of Staff in reach when `chief`, whose report turns start, or are refused. */
  const team = (opts: { chief: boolean; refuses?: boolean; escalations?: boolean; assigned?: boolean }) => {
    // Windows will not remove a directory holding an open SQLite database: the previous team's Store opened one.
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(selection);
    const qa = store.createBot({ name: "Quinn" });
    if (opts.chief) {
      const chief = store.createBot({ name: "Charlie" });
      store.patchBot(chief.id, { chiefOfStaff: true, peers: [qa.id] });
    }
    const work = store.createTask(qa.id, "QA: PR #9", false, undefined, opener)!;
    store.patchTask(qa.id, work.threadId, { notificationsMuted: true });
    const sent: Notification[] = [], started: string[] = [];
    const notify = (notification: Notification | null) => { if (notification) sent.push(notification); };
    const assignerOf = () => (opts.assigned ? { id: "assignment" } : undefined);
    turns = [];
    const notices = createChiefNotices({
      store, notify, threadBusy: () => false, botAtThreadCapacity: () => false, groupTurnActive: () => false,
      startTurn: (botId) => {
        started.push(botId);
        const turn = opts.refuses ? Promise.reject(new Error("the Chief's engine is signed out")) : Promise.resolve();
        turns.push(turn);
        return turn;
      },
      assignerOf, escalationsEnabled: () => opts.escalations === true,
    });
    const mute = createThreadMute({ store, config: {}, mainThread: () => qa.threadId, notify, chief: () => notices, assignerOf });
    const bot = store.bot(qa.id)!;
    const fail = (kind: "could-not-start" | "routine-failed") => mute.reportFailure({
      notification: buildNotification(kind === "routine-failed" ? "routine-failed" : "turn-failed", bot, work.threadId, "the engine exited"),
      kind, bot, threadId: work.threadId, detail: "the engine exited",
    });
    return { bot, work, sent, started, mute, fail };
  };
  const failures = ["could-not-start", "routine-failed"] as const;
  const direct = { "could-not-start": "turn-failed", "routine-failed": "routine-failed" } as const;

  it.each(failures)("%s: tells the person once when the Chief's report turn is refused", async (kind) => {
    const { bot, work, sent, started, fail } = team({ chief: true, refuses: true });
    fail(kind);
    await flush();
    expect(started).toHaveLength(1);
    expect(sent).toEqual([expect.objectContaining({ kind: "incident", botId: bot.id, threadId: work.threadId })]);
  });

  it.each(failures)("%s: tells the person nothing once the Chief takes the report", async (kind) => {
    const { sent, started, fail } = team({ chief: true });
    fail(kind);
    await flush();
    expect(started).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it.each(failures)("%s: tells the person once when there is no Chief, the report folds into assigned work, or is rate-limited", async (kind) => {
    for (const opts of [{ chief: false }, { chief: true, assigned: true }]) {
      const { sent, started, fail } = team(opts);
      fail(kind);
      await flush();
      expect(started, JSON.stringify(opts)).toEqual([]);
      expect(sent, JSON.stringify(opts)).toEqual([expect.objectContaining({ kind: direct[kind] })]);
    }
    const { sent, fail } = team({ chief: true });
    for (let i = 0; i < INCIDENT_HARD_LIMIT; i++) fail(kind);
    await flush();
    expect(sent).toEqual([]);
    fail(kind);
    expect(sent).toEqual([expect.objectContaining({ kind: direct[kind] })]);
  });

  it.each([false, true])("a turn that ends needing input, with escalations on: %s, tells the person once, Chief or not", async (escalations) => {
    for (const chief of [false, true]) {
      const { bot, work, sent, started, mute } = team({ chief, escalations, refuses: true });
      mute.reportNeedsInput({ bot, threadId: work.threadId, question: "which repository should I tag?" });
      await flush();
      expect(sent, `chief: ${chief}`).toEqual([expect.objectContaining({ kind: "question", threadId: work.threadId, body: "which repository should I tag?" })]);
      // With a Chief, the escalation still goes out, already counted as told: even its refusal adds nothing.
      expect(started, `chief: ${chief}`).toHaveLength(chief && escalations ? 1 : 0);
    }
  });
});

// The coordinator's park handler, run without a server: a parent whose thread is gone cannot be reached live, since
// deleting the thread or its bot cancels the assignment first.
describe("the park handler for a muted thread a teammate assigned", () => {
  const park = (muted: boolean) => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = source.indexOf("\n    park: (node, question, restored) => {"), to = source.indexOf("\n    levelOf:", from);
    if (from < 0 || to <= from) throw new Error("park handler moved");
    const handler = source.slice(from, to).trim().replace(/^park:/, "globalThis.park =").replace(/,$/, ";");
    const sent: Notification[] = [];
    const nell = { id: "nell", name: "Nell", threadId: "nell-main" };
    // The server's notify, gated by its thread mute; the work thread is the only thread the mute knows.
    const notify = (notification: Notification | null) => { if (notification && threadMute.lets(notification)) sent.push(notification); };
    const threadMute = createThreadMute({
      store: { taskByThread: (_botId: string, threadId: string) => (threadId === "work-thread" ? { threadId, notificationsMuted: muted } : undefined), groupByThread: () => undefined } as never,
      config: {}, mainThread: () => nell.threadId, notify, chief: () => { throw new Error("the park handler reports nothing to a Chief"); }, assignerOf: () => undefined,
    });
    const context = vm.createContext({
      store: {
        bot: (id: string) => (id === "nell" ? nell : undefined), taskByThread: () => undefined, groupTaskByThread: () => undefined,
        group: () => undefined, appendMessage() {}, patchGroup() {}, patchTask() {},
      },
      // Ava's assignment is still on record; her thread is not.
      coordinator: { node: (id: string) => (id === "ava-root" ? { id, botId: "ava", threadId: "ava-gone" } : undefined) },
      newestQuestionChip: () => undefined, buildNotification, threadMute, notify,
    });
    vm.runInContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
    const node = { id: "work", rootId: "ava-root", parentId: "ava-root", threadId: "work-thread", botId: "nell", reply: "resume" };
    context.park(node, "which repository should I tag?", false);
    return sent;
  };

  it("tells the person once when the assigner's thread is gone", () => {
    expect(park(true)).toEqual([expect.objectContaining({ kind: "question", threadId: "work-thread", body: "which repository should I tag?" })]);
    expect(park(false)).toEqual([expect.objectContaining({ kind: "delegation-settled", threadId: "work-thread" })]);
  });
});

describe("threadNotificationsMuted", () => {
  it("changes nothing for anyone who never muted a thread or opted in", () => {
    expect(threadNotificationsMuted({ threadId: "t" }, off)).toBe(false);
    expect(threadNotificationsMuted({ threadId: "t", openedBy: opener }, off)).toBe(false);
  });

  it("follows an explicit choice either way, whatever the default", () => {
    expect(threadNotificationsMuted({ threadId: "t", notificationsMuted: true }, off)).toBe(true);
    expect(threadNotificationsMuted({ threadId: "main", notificationsMuted: true }, on)).toBe(true);
    expect(threadNotificationsMuted({ threadId: "t", openedBy: opener, notificationsMuted: false }, on)).toBe(false);
  });

  it("with the opt-in, mutes threads a bot opened but never the person's own or the bot's main chat", () => {
    expect(threadNotificationsMuted({ threadId: "t", openedBy: opener }, on)).toBe(true);
    expect(threadNotificationsMuted({ threadId: "t" }, on)).toBe(false);
    expect(threadNotificationsMuted({ threadId: "main", openedBy: opener }, on)).toBe(false);
  });
});

describe("a thread's stored mute", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  const storedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<{ id: string; tasks: Array<Record<string, unknown>> }>)
      .find((bot) => bot.id === botId)!.tasks.find((task) => task.threadId === threadId)!;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is absent on threads saved before it existed, so they follow the default", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Quinn" });
    const work = store.createTask(bot.id, "QA: PR #1", false, undefined, opener)!;
    expect(storedTask(bot.id, work.threadId)).not.toHaveProperty("notificationsMuted");
    const reloaded = new Store(selection).taskByThread(bot.id, work.threadId)!;
    expect(threadNotificationsMuted(reloaded, off)).toBe(false);
    expect(threadNotificationsMuted(reloaded, { botOpened: true, mainThreadId: bot.threadId })).toBe(true);
  });

  it("survives a restart once set, and clearing it returns the thread to the default", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Quinn" });
    const work = store.createTask(bot.id, "QA: PR #2", false, undefined, opener)!;
    store.patchTask(bot.id, work.threadId, { notificationsMuted: false });
    expect(new Store(selection).taskByThread(bot.id, work.threadId)?.notificationsMuted).toBe(false);
    store.patchTask(bot.id, work.threadId, { notificationsMuted: true });
    expect(new Store(selection).taskByThread(bot.id, work.threadId)?.notificationsMuted).toBe(true);
    store.patchTask(bot.id, work.threadId, { notificationsMuted: undefined });
    expect(storedTask(bot.id, work.threadId)).not.toHaveProperty("notificationsMuted");
  });
});

describe("mute_thread's route", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  /** A Chief that reaches Quinn, and a thread the Chief opened on Quinn. */
  const team = () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Charlie" });
    const qa = store.createBot({ name: "Quinn" });
    store.patchBot(chief.id, { chiefOfStaff: true, peers: [qa.id] });
    const work = store.createTask(qa.id, "Hidden title", false, undefined, { botId: chief.id, name: "Charlie", at: 1 })!;
    const mute = async (muted: boolean, shown: (threadId: string) => boolean = () => true) => {
      const out: { status?: number; body?: unknown } = {};
      const route = createInternalThreadRoutes({
        store, from: store.bot(chief.id)!, fromThreadId: chief.threadId,
        coordinator: { awaitingAnswer: () => false, parkedDirect: () => false, activeDirect: () => false } as never,
        ownsThread: () => true, shown, threadBusy: () => false, queuedThreadPosition: () => null,
        muteDefault: (botId) => ({ botOpened: false, mainThreadId: store.bot(botId)?.threadId }),
        readBody: async () => ({ muted }), requireActive: () => undefined,
      });
      await route({ res: {}, path: `/api/internal/threads/${work.threadId}/mute`, method: "POST",
        json: (_res: unknown, status: number, body: unknown) => { out.status = status; out.body = body; } } as never);
      return out;
    };
    const stored = () => store.taskByThread(qa.id, work.threadId)!;
    return { store, qa, work, mute, stored };
  };

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("answers a thread the Chief may not see as missing: no title, nothing written", async () => {
    const { work, mute, stored } = team();
    const hidden = await mute(true, (threadId) => threadId !== work.threadId);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain("Hidden title");
    expect(stored()).not.toHaveProperty("notificationsMuted");
    expect((await mute(true)).status).toBe(200);
  });

  it("never changes the person's choice, and records its own as the Chief's", async () => {
    const { qa, work, store, mute, stored } = team();
    store.patchTask(qa.id, work.threadId, { notificationsMuted: true, notificationsMutedBy: "person" });
    const refused = await mute(false);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: expect.stringContaining("only they can change it") });
    expect((await mute(true)).status, "agreeing with the person is no change").toBe(200);
    expect(stored()).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "person" });

    store.patchTask(qa.id, work.threadId, { notificationsMuted: undefined, notificationsMutedBy: undefined });
    expect((await mute(true)).status).toBe(200);
    expect(stored()).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "chief" });
    expect((await mute(false)).status).toBe(200);
    expect(stored()).toMatchObject({ notificationsMuted: false, notificationsMutedBy: "chief" });
  });
});

describe("the mute_thread tool", () => {
  const routed = (respond: (path: string, body: unknown) => Record<string, unknown>) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const context: ToolCallContext = {
      botId: "chief", threadId: "chief-thread", depth: 0, externalRuntime: false, sharedComputers: false,
      client: {
        api: async (path, init) => {
          const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
          calls.push({ path, body });
          return respond(path, body);
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    };
    return { calls, context };
  };

  it("is offered to a Chief of Staff only", () => {
    const names = (chief: boolean) => availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "b", ...(chief ? { OMB_CHIEF_OF_STAFF: "1" } : {}) })).map((tool) => tool.name);
    expect(names(true)).toContain("mute_thread");
    expect(names(false)).not.toContain("mute_thread");
  });

  it("sends the choice to the thread's mute route and hands a refusal back as an error", async () => {
    const { calls, context } = routed((_path, body) => body && typeof body === "object" && "muted" in body && body.muted === true
      ? { threadId: "t-1", title: "QA: PR #9", botName: "Quinn", muted: true }
      : { error: "that thread is not yours to mute" });
    const muted = await callTool("mute_thread", { thread_id: " t-1 ", muted: true }, context);
    expect(muted.isError).toBeFalsy();
    expect(muted.text).toContain("Muted #QA: PR #9 on @Quinn");
    const refused = await callTool("mute_thread", { thread_id: "t-1", muted: false }, context);
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("that thread is not yours to mute") });
    expect(calls).toEqual([
      { path: "/api/internal/threads/t-1/mute", body: { fromBotId: "chief", fromThreadId: "chief-thread", muted: true } },
      { path: "/api/internal/threads/t-1/mute", body: { fromBotId: "chief", fromThreadId: "chief-thread", muted: false } },
    ]);
    expect((await callTool("mute_thread", { thread_id: "t-1", muted: "yes" }, context)).isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("is what list_threads reports for each thread", async () => {
    const { context } = routed(() => ({ threads: [
      { threadId: "t-1", botName: "Quinn", title: "QA: PR #9", state: "idle", unread: false, muted: true, own: false },
      { threadId: "t-2", botName: "Quinn", title: "QA: PR #10", state: "idle", unread: false, muted: false, own: false },
    ] }));
    const lines = (await callTool("list_threads", {}, context)).text.split("\n");
    expect(lines.find((line) => line.includes("t-1"))).toContain("idle, notifications muted)");
    expect(lines.find((line) => line.includes("t-2"))).not.toContain("muted");
  });
});
