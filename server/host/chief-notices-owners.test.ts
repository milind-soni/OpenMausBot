import { describe, expect, it, vi } from "vitest";

import { createChiefNotices } from "./chief-notices.ts";

const BOB = "p_bobbobbobbobbobbobbobb", OLIVE = "p_oliveoliveoliveoliveo";

function fixture() {
  const bots = [
    { id: "bobs-chief", name: "Bob's Chief", chiefOfStaff: true, reportsTo: "bob@acme.test", threadId: "chief-main", tasks: [] as Array<{ threadId: string; title: string }> },
    { id: "fox", name: "Fox", section: "Product A", reportsTo: "bob@acme.test", threadId: "fox-main", tasks: [{ threadId: "fox-main", title: "Fox" }, { threadId: "fox-olive", title: "Olive and Fox" }] },
  ];
  const starters = new Map<string, string>([["fox-olive", OLIVE]]);
  const lines: Array<{ threadId: string; row: unknown }> = [];
  let made = 0;
  const store = {
    bots, bot: (id: string) => bots.find((one) => one.id === id),
    tasks: (id: string) => bots.find((one) => one.id === id)?.tasks ?? [],
    taskByThread: (id: string, threadId: string) => bots.find((one) => one.id === id)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    createTask: (id: string, title: string) => {
      const task = { threadId: `notices-${++made}`, title };
      bots.find((one) => one.id === id)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, row: unknown) => { lines.push({ threadId, row }); },
    messagesFor: () => [],
  };
  const notified: unknown[] = [];
  const startTurn = vi.fn(async (_botId: string, _text: string, _opts: { threadId: string }) => undefined);
  const notices = createChiefNotices({
    store: store as never, notify: (notification) => { notified.push(notification); }, threadBusy: () => false, botAtThreadCapacity: () => false,
    groupTurnActive: () => false, startTurn, assignerOf: () => undefined, escalationsEnabled: () => true,
    routing: {
      askedPerson: (_botId, threadId) => starters.get(threadId) ?? BOB,
      personOf: (chief) => (chief.reportsTo === "bob@acme.test" ? BOB : null),
      startedBy: (threadId) => starters.get(threadId),
      open: (threadId, person) => { starters.set(threadId, person); },
    },
  });
  return { notices, notified, startTurn, starters, fox: bots[1]! };
}

describe("a Team Cloud Chief's notices", () => {
  it("reach the owner's Chief, in a notices chat of the owner's own", () => {
    const f = fixture();
    f.notices.reportIncident({ kind: "failed", bot: f.fox as never, threadId: "fox-main", detail: "The build failed" });
    expect(f.startTurn).toHaveBeenCalledTimes(1);
    expect(f.startTurn.mock.calls[0]![0]).toBe("bobs-chief");
    const threadId = f.startTurn.mock.calls[0]![2].threadId;
    expect(f.starters.get(threadId)).toBe(BOB);
  });

  it("never carry someone else's private chat to the owner's Chief: that person is told instead", () => {
    const f = fixture();
    f.notices.reportIncident({ kind: "failed", bot: f.fox as never, threadId: "fox-olive", detail: "Olive's draft failed" });
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.notified).toEqual([expect.objectContaining({ kind: "incident", threadId: "fox-olive" })]);
    expect(f.notices.reportEscalation({ kind: "raised", bot: f.fox as never, threadId: "fox-olive", gate: "x", reason: "y", alreadyNotified: false })).toBe("person");
  });
});
