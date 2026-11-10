import { expect, it } from "vitest";
import type { BotRecord } from "../store.ts";
import { createBotWire } from "./bot-wire.ts";

it("projects each thread's external wait without exposing provider cursors", () => {
  const bot: BotRecord = {
    id: "b", threadId: "one", name: "Bot", title: "", description: "", notifications: true,
    color: "green", unread: false, modelSelection: { instanceId: "claude", model: "m" },
    resumeCursors: { claude: "private" }, createdAt: 1,
    tasks: [{ threadId: "one", title: "One", createdAt: 1, resumeCursors: { claude: "private" } },
      { threadId: "two", title: "Two", createdAt: 2, resumeCursors: {} }],
  };
  const wire = createBotWire({ teammates: () => new Set(), localAgents: () => new Set(["one"]), keepWarm: () => undefined,
    ownTurn: () => false, inbox: () => ({}), threadBusy: () => false, mainThread: () => "one",
    askedBy: task => task.threadId === "one" ? { askedBy: { name: "Ada", id: "ada" } } : {},
  }).wireBot(bot);
  expect(wire.waitingForExternalAgent).toBe(true);
  expect(wire.tasks?.map(task => task.waitingForExternalAgent)).toEqual([true, false]);
  expect(wire.tasks?.[0]?.askedBy).toEqual({ name: "Ada", id: "ada" });
  expect(wire).not.toHaveProperty("resumeCursors");
  expect(wire.tasks?.[0]).not.toHaveProperty("resumeCursors");
});
