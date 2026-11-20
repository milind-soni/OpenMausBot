import { describe, expect, it } from "vitest";

import { createAutomationDestinations, type AutomationDestinationDeps } from "./automation-destinations.ts";
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import type { Routine } from "./routines.ts";

function world(writer: string, cloud = true, earlier: Array<{ webhookId: string; botId: string; resultsThreadId: string }> = []) {
  const tasks = new Map([["person-chat", { threadId: "person-chat", title: "Person" }], ["hook-chat", { threadId: "hook-chat", title: "Hook · Results" }]]);
  const opened: Array<[string, string]> = [];
  const outside: string[] = [];
  let made = 0;
  const store = {
    bot: () => ({ id: "bot" }),
    createTask: (_botId: string, title: string, ...rest: unknown[]) => { const task = { threadId: `made-${++made}`, title }; tasks.set(task.threadId, task); (rest[6] as ((made: { threadId: string }) => void) | undefined)?.(task); return task; },
    messagesFor: () => [],
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
  } as unknown as AutomationDestinationDeps["store"];
  const destinations = createAutomationDestinations({ store, mainThread: () => "main", runs: () => earlier,
    cloud: cloud ? { owner: "owner", personChat: (_botId, person) => person === "p_someone" ? "person-chat" : undefined, opener: () => writer, reportFromOthers: () => false, opened: (threadId, person) => { opened.push([threadId, person]); }, outside: (threadId) => { outside.push(threadId); } } : null });
  return { destinations, opened, outside, tasks };
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

describe("where an outside event reports on a desktop or self-hosted home", () => {
  const event = { webhookId: "w", webhookName: "Hook", botId: "bot" };

  it("reports events and scheduled runs in the bot's main chat", () => {
    const w = world("owner", false);
    expect(w.destinations.event(event)).toBe("main");
    expect(w.destinations.routine({ ...routine, resultsThreadId: undefined }, false)).toEqual({ threadId: "main", main: true });
    expect(w.destinations.routine(routine, false)).toEqual({ threadId: "person-chat" });
    expect(w.tasks.size).toBe(2);
  });
});
