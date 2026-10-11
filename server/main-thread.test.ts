import { describe, expect, it } from "vitest";

import { mainThread, oldestThread, wasOldestThread } from "./main-thread.ts";

const first = { threadId: "first", createdAt: 1 };
const later = { threadId: "later", createdAt: 2 };
const latest = { threadId: "latest", createdAt: 3 };

describe("a bot's main thread", () => {
  it("is the open thread a person last wrote in, wherever the selection is", () => {
    const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];
    expect(mainThread(tasks, "first")).toBe("later");
    expect(mainThread(tasks)).toBe("later");
  });

  it("is never a routine run or an archived thread, however recently written in", () => {
    const tasks = [
      { ...latest, askedAt: 50, routineRunId: "run" },
      { ...later, askedAt: 40, archivedAt: 41 },
      { ...first, askedAt: 10 },
    ];
    expect(mainThread(tasks, "later")).toBe("first");
  });

  it("is the selected thread before anyone writes, while that is an open conversation", () => {
    expect(mainThread([latest, later, first], "later")).toBe("later");
    expect(mainThread([latest, { ...later, archivedAt: 5 }, first], "later")).toBe("first");
    expect(mainThread([{ ...latest, routineRunId: "run" }, later, first], "latest")).toBe("first");
    expect(mainThread([latest, later, first], "deleted")).toBe("first");
  });

  it("is the oldest archived thread when every thread is archived, and nothing without threads", () => {
    expect(mainThread([{ ...latest, archivedAt: 9, askedAt: 9 }, { ...later, archivedAt: 8 }], "latest")).toBe("later");
    expect(mainThread([{ ...first, routineRunId: "run" }])).toBeUndefined();
    expect(mainThread([])).toBeUndefined();
  });
});

describe("the oldest thread", () => {
  it("is the oldest open conversation, else the oldest archived one, never a routine run", () => {
    expect(oldestThread([latest, later, { ...first, routineRunId: "run" }])).toBe("later");
    expect(oldestThread([latest, { ...first, archivedAt: 4 }])).toBe("latest");
    expect(oldestThread([{ ...latest, archivedAt: 6 }, { ...later, archivedAt: 5 }])).toBe("later");
  });
});

describe("a thread saved on a routine as the oldest one", () => {
  it("is a conversation no open thread is older than, open still or archived since", () => {
    expect(wasOldestThread([latest, later, first], "first")).toBe(true);
    // Archived after it was saved: today's oldest open thread is another.
    expect(wasOldestThread([latest, later, { ...first, archivedAt: 9 }], "first")).toBe(true);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, { ...first, archivedAt: 8 }], "later")).toBe(true);
    // An older open thread means a person chose this one.
    expect(wasOldestThread([latest, later, first], "later")).toBe(false);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, first], "later")).toBe(false);
    // An older routine run is no conversation; a run, a deleted thread never.
    expect(wasOldestThread([latest, later, { ...first, routineRunId: "run" }], "later")).toBe(true);
    expect(wasOldestThread([latest, { ...later, routineRunId: "run" }], "later")).toBe(false);
    expect(wasOldestThread([latest, later], "deleted")).toBe(false);
  });
});
