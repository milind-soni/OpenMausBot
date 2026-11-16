import { describe, expect, it } from "vitest";

import { createThreadMaps, keepThreadEntry } from "./thread-maps.ts";

describe("per-conversation maps", () => {
  it("forgets a deleted conversation at once, and an archived or gone one at the sweep, but never one that runs or is open", () => {
    const maps = createThreadMaps();
    const triggers = maps.track(new Map<string, string>()), noticed = maps.track(new Set<string>());
    for (const threadId of ["open", "archived", "running", "gone", "main", "room", "deleted"]) { triggers.set(threadId, "x"); noticed.add(threadId); }
    maps.forget("deleted");
    expect(triggers.has("deleted") || noticed.has("deleted")).toBe(false);
    const tasks: Record<string, { archivedAt?: number }> = { open: {}, archived: { archivedAt: 1 }, running: { archivedAt: 1 }, main: { archivedAt: 1 } };
    const keep = keepThreadEntry({
      botByThread: (threadId) => threadId in tasks ? { id: "bot", threadId: "main" } : null,
      taskByThread: (_botId, threadId) => tasks[threadId],
      groupByThread: (threadId) => threadId === "room" ? {} : undefined,
    }, (_botId, threadId) => threadId === "running");
    maps.sweep(keep);
    expect([...triggers.keys()].sort()).toEqual(["main", "open", "room", "running"]);
    expect([...noticed].sort()).toEqual(["main", "open", "room", "running"]);
    expect(maps.entries()).toBe(8);
  });
});
