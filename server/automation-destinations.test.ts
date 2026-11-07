import { describe, expect, it, vi } from "vitest";

import { createAutomationDestinations, type AutomationDestinationDeps } from "./automation-destinations.ts";
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { Message, Store, TaskRecord } from "./store.ts";

function world(writer: string) {
  const tasks = new Map([
    ["person-chat", { threadId: "person-chat", title: "Person" }],
    ["hook-chat", { threadId: "hook-chat", title: "Hook · Results" }],
  ]);
  const opened: Array<[string, string]> = [];
  const outside: string[] = [];
  let made = 0;
  const store = {
    bot: () => ({ id: "bot" }),
    createTask: (_botId: string, title: string) => {
      const task = { threadId: `made-${++made}`, title };
      tasks.set(task.threadId, task);
      return task;
    },
    messagesFor: () => [],
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
  } as unknown as AutomationDestinationDeps["store"];
  const destinations = createAutomationDestinations({
    store,
    mainThread: () => "main",
    runs: () => [],
    cloud: {
      owner: "owner",
      opener: () => writer,
      reportFromOthers: () => false,
      opened: (threadId, person) => {
        opened.push([threadId, person]);
      },
      outside: (threadId) => {
        outside.push(threadId);
      },
    },
  });
  return { destinations, opened, outside };
}
const routine = { id: "r", name: "Daily", botId: "bot", resultsThreadId: "person-chat" } as Routine;

describe("where an automation reports on a Cloud", () => {
  it("keeps the chat a person's routine chose", () => {
    expect(world("p_someone").destinations.routine(routine, false)).toEqual({ threadId: "person-chat" });
  });

  it("gives a routine outside work wrote a chat of its own, whatever chat it names", () => {
    const w = world(CLOUD_OUTSIDE_KEY);
    expect(w.destinations.routine(routine, false)).toEqual({ threadId: "made-1" });
    expect(w.opened).toEqual([["made-1", CLOUD_OUTSIDE_KEY]]);
  });

  it("names an event's own chat, never a person's or the chat a wait reports to", () => {
    const { destinations } = world("owner");
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "hook-chat" })).toBe("hook-chat");
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "person-chat" })).toBeUndefined();
    expect(destinations.eventChat({ botId: "bot", routineName: "Hook", resultsThreadId: "hook-chat", eventSource: "wait" })).toBeUndefined();
  });

  it("records an event's own chat as holding outside work", () => {
    const w = world("owner");
    expect(w.destinations.event({ webhookId: "w", webhookName: "Hook", botId: "bot" })).toBe("made-1");
    expect(w.outside).toEqual(["made-1"]);
  });
});

function fixture(overrides: Partial<AutomationDestinationDeps> = {}) {
  const tasks = new Map<string, TaskRecord>();
  const messages = new Map<string, Message[]>();
  const bots = new Map<string, { id: string; hidden?: boolean }>([
    ["bot-1", { id: "bot-1" }],
    ["hidden-bot", { id: "hidden-bot", hidden: true }],
  ]);
  let taskCounter = 0;

  const store: Pick<Store, "bot" | "createTask" | "messagesFor" | "taskByThread"> = {
    bot: (id: string) => (bots.get(id) ?? null) as never,
    createTask: (botId: string, title: string, _busy?: boolean) => {
      const threadId = `created-task-${++taskCounter}`;
      const record = { threadId, title, createdAt: Date.now() } as unknown as TaskRecord;
      tasks.set(`${botId}:${threadId}`, record);
      return record;
    },
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    taskByThread: (botId: string, threadId: string) => tasks.get(`${botId}:${threadId}`),
  };

  const runs: Array<Pick<RoutineRun, "webhookId" | "botId" | "resultsThreadId">> = [];

  const deps: AutomationDestinationDeps = {
    store,
    mainThread: (botId: string) => `main-${botId}`,
    runs: () => runs,
    cloud: null,
    ...overrides,
  };

  return {
    destinations: createAutomationDestinations(deps),
    store,
    tasks,
    messages,
    runs,
    addTask: (botId: string, threadId: string, title: string, routineRunId?: string) => {
      const record = { threadId, title, createdAt: Date.now(), ...(routineRunId ? { routineRunId } : {}) } as unknown as TaskRecord;
      tasks.set(`${botId}:${threadId}`, record);
      return record;
    },
    addMessage: (threadId: string, text: string) => {
      const existing = messages.get(threadId) ?? [];
      existing.push({ id: `msg-${existing.length + 1}`, role: "assistant", kind: "text", text, at: Date.now(), createdAt: Date.now() } as unknown as Message);
      messages.set(threadId, existing);
    },
  };
}

describe("webhook destination resolution", () => {
  it("returns undefined when bot is missing or hidden", () => {
    const { destinations } = fixture();
    expect(destinations.event({ webhookId: "wh-1", webhookName: "Lead", botId: "nonexistent" })).toBeUndefined();
    expect(destinations.event({ webhookId: "wh-1", webhookName: "Lead", botId: "hidden-bot" })).toBeUndefined();
  });

  it("routes to configured resultsThreadId when thread exists and is not a run conversation", () => {
    const { destinations, addTask } = fixture();
    addTask("bot-1", "custom-thread", "Webhook Leads");
    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
      resultsThreadId: "custom-thread",
    });
    expect(resolved).toBe("custom-thread");
  });

  it("falls back to mainThread when resultsThreadId points to an ephemeral routineRunId task", () => {
    const { destinations, addTask } = fixture();
    addTask("bot-1", "ephemeral-thread", "Run 1", "run-1");
    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
      resultsThreadId: "ephemeral-thread",
    });
    expect(resolved).toBe("main-bot-1");
  });

  it("falls back to mainThread when resultsThreadId points to an archived task", () => {
    const { destinations, addTask } = fixture();
    const task = addTask("bot-1", "archived-thread", "Archived Thread");
    task.archivedAt = Date.now();
    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
      resultsThreadId: "archived-thread",
    });
    expect(resolved).toBe("main-bot-1");
  });

  it("falls back to mainThread when resultsThreadId does not exist in store", () => {
    const { destinations } = fixture();
    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
      resultsThreadId: "deleted-thread",
    });
    expect(resolved).toBe("main-bot-1");
  });

  it("falls back to mainThread in local mode when no resultsThreadId is supplied", () => {
    const { destinations } = fixture();
    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
    });
    expect(resolved).toBe("main-bot-1");
  });

  it("ignores configured resultsThreadId on Cloud and reuses earlier results thread", () => {
    const opened = vi.fn();
    const outside = vi.fn();
    const { destinations, addTask, addMessage, runs } = fixture({
      cloud: {
        owner: "person-owner",
        opener: () => "person-owner",
        reportFromOthers: (msg) => typeof msg.text === "string" && msg.text.includes("report"),
        opened,
        outside,
      },
    });
    addTask("bot-1", "custom-thread", "Custom Thread");
    addTask("bot-1", "kept-thread", "Lead · Results");
    addMessage("kept-thread", "an earlier report");
    runs.push({ webhookId: "wh-1", botId: "bot-1", resultsThreadId: "kept-thread" });

    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
      resultsThreadId: "custom-thread",
    });
    expect(resolved).toBe("kept-thread");
    expect(outside).toHaveBeenCalledWith("kept-thread");
  });

  it("does not reuse earlier results thread in cloud mode when that task is archived", () => {
    const opened = vi.fn();
    const outside = vi.fn();
    const { destinations, addTask, addMessage, runs } = fixture({
      cloud: {
        owner: "person-owner",
        opener: () => "person-owner",
        reportFromOthers: (msg) => typeof msg.text === "string" && msg.text.includes("report"),
        opened,
        outside,
      },
    });
    const task = addTask("bot-1", "kept-thread", "Lead · Results");
    task.archivedAt = Date.now();
    addMessage("kept-thread", "an earlier report");
    runs.push({ webhookId: "wh-1", botId: "bot-1", resultsThreadId: "kept-thread" });

    const resolved = destinations.event({
      webhookId: "wh-1",
      webhookName: "Lead",
      botId: "bot-1",
    });
    expect(resolved).toBe("created-task-1");
    expect(outside).toHaveBeenCalledWith("created-task-1");
  });
});
