import { describe, expect, it, vi } from "vitest";

import { createAutomationDestinations, type AutomationDestinationDeps } from "./automation-destinations.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { Message, Store, TaskRecord } from "./store.ts";

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

describe("createAutomationDestinations", () => {
  describe("event()", () => {
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

    it("reuses earlier results thread in cloud mode when matching run was saved", () => {
      const opened = vi.fn();
      const { destinations, addTask, addMessage, runs } = fixture({
        cloud: {
          owner: "person-owner",
          opener: () => "person-owner",
          reportFromOthers: (msg) => typeof msg.text === "string" && msg.text.includes("report"),
          opened,
        },
      });
      addTask("bot-1", "kept-thread", "Lead · Results");
      addMessage("kept-thread", "an earlier report");
      runs.push({ webhookId: "wh-1", botId: "bot-1", resultsThreadId: "kept-thread" });

      const resolved = destinations.event({
        webhookId: "wh-1",
        webhookName: "Lead",
        botId: "bot-1",
      });
      expect(resolved).toBe("kept-thread");
      expect(opened).not.toHaveBeenCalled();
    });

    it("does not reuse earlier results thread in cloud mode when that task is archived", () => {
      const opened = vi.fn();
      const { destinations, addTask, addMessage, runs } = fixture({
        cloud: {
          owner: "person-owner",
          opener: () => "person-owner",
          reportFromOthers: (msg) => typeof msg.text === "string" && msg.text.includes("report"),
          opened,
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
      expect(resolved).not.toBe("kept-thread");
      expect(opened).toHaveBeenCalledWith(resolved, "person-owner");
    });

    it("ignores caller resultsThreadId in cloud mode and routes to cloud destination", () => {
      const opened = vi.fn();
      const { destinations, addTask } = fixture({
        cloud: {
          owner: "person-owner",
          opener: () => "person-owner",
          reportFromOthers: () => false,
          opened,
        },
      });
      addTask("bot-1", "custom-thread", "Webhook Leads");
      const resolved = destinations.event({
        webhookId: "wh-1",
        webhookName: "Lead",
        botId: "bot-1",
        resultsThreadId: "custom-thread",
      });
      expect(resolved).not.toBe("custom-thread");
      expect(opened).toHaveBeenCalledWith(resolved, "person-owner");
    });

    it("creates dedicated chatOfItsOwn in cloud mode when no earlier task exists", () => {
      const opened = vi.fn();
      const { destinations } = fixture({
        cloud: {
          owner: "person-owner",
          opener: () => "person-owner",
          reportFromOthers: () => false,
          opened,
        },
      });
      const resolved = destinations.event({
        webhookId: "wh-1",
        webhookName: "Alerts",
        botId: "bot-1",
      });
      expect(resolved).toMatch(/^created-task-\d+$/);
      expect(opened).toHaveBeenCalledWith(resolved, "person-owner");
    });
  });

  describe("routine()", () => {
    const routine: Routine = {
      id: "routine-1",
      name: "Daily Sync",
      prompt: "Sync data",
      target: "bot",
      botId: "bot-1",
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      durationMinutes: 30,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    it("routes to configured resultsThreadId when valid and not a legacy title", () => {
      const { destinations, addTask } = fixture();
      addTask("bot-1", "custom-sync", "Sync Output");
      expect(destinations.routine({ ...routine, resultsThreadId: "custom-sync" }, false)).toEqual({
        threadId: "custom-sync",
      });
    });

    it("falls back to mainThread when routine has no resultsThreadId", () => {
      const { destinations } = fixture();
      expect(destinations.routine(routine, false)).toEqual({
        threadId: "main-bot-1",
        main: true,
      });
    });

    it("skips legacy results thread (ending in · Results) when main is allowed", () => {
      const { destinations, addTask } = fixture();
      addTask("bot-1", "old-results", "Daily Sync · Results");
      expect(destinations.routine({ ...routine, resultsThreadId: "old-results" }, false)).toEqual({
        threadId: "main-bot-1",
        main: true,
      });
    });
  });
});
