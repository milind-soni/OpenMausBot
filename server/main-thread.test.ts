import { describe, expect, it } from "vitest";

import { mainThread, mainThreadToKeep, oldestThread, wasOldestThread } from "./main-thread.ts";

const first = { threadId: "first", createdAt: 1 };
const later = { threadId: "later", createdAt: 2 };
const latest = { threadId: "latest", createdAt: 3 };

describe("a bot's main thread", () => {
  it("is the oldest open conversation, wherever a person last wrote and whichever is selected", () => {
    const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];
    expect(mainThread(tasks)).toBe("first");
    const newest = { threadId: "newest", createdAt: 4, askedAt: 40 };
    expect(mainThread([...tasks, newest])).toBe("first");
  });

  it("is the thread the person chose while it is open, else the oldest open one", () => {
    const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];
    expect(mainThread(tasks, "later")).toBe("later");
    expect(mainThread([{ ...latest, archivedAt: 5 }, later, first], "latest")).toBe("first");
    expect(mainThread([{ ...latest, routineRunId: "run" }, later, first], "latest")).toBe("first");
    expect(mainThread(tasks, "deleted")).toBe("first");
  });

  it("moves to the next oldest open conversation only when it is archived or deleted", () => {
    expect(mainThread([latest, later, { ...first, archivedAt: 9 }])).toBe("later");
    expect(mainThread([latest, later])).toBe("later");
  });

  it("is never by default a thread a bot opened, while the person has an open one of their own", () => {
    const handed = { ...first, openedBy: { botId: "teammate", name: "Teammate" } };
    expect(mainThread([latest, later, handed])).toBe("later");
    expect(mainThread([latest, { ...later, archivedAt: 5 }, handed])).toBe("latest");
    expect(mainThread([{ ...latest, routineRunId: "run" }, { ...later, archivedAt: 5 }, handed])).toBe("first");
    expect(mainThread([latest, later, handed], "first")).toBe("first");
  });

  it("is never a routine run or an archived thread, however old", () => {
    expect(mainThread([latest, { ...later, archivedAt: 41 }, { ...first, routineRunId: "run" }])).toBe("latest");
  });

  it("is the oldest archived thread when every thread is archived, and nothing without threads", () => {
    expect(mainThread([{ ...latest, archivedAt: 9 }, { ...later, archivedAt: 8 }])).toBe("later");
    expect(mainThread([{ ...first, routineRunId: "run" }])).toBeUndefined();
    expect(mainThread([])).toBeUndefined();
  });
});

describe("the main thread a bot keeps", () => {
  const tasks = [{ ...latest, askedAt: 10 }, { ...later, askedAt: 30 }, { ...first, askedAt: 20 }];

  it("is, for a bot with none saved, the open thread a person last wrote in", () => {
    expect(mainThreadToKeep(tasks)).toBe("later");
    expect(mainThreadToKeep([latest, { ...later, askedAt: 30, archivedAt: 31 }, { ...first, askedAt: 20 }])).toBe("first");
    expect(mainThreadToKeep([latest, { ...later, askedAt: 30, routineRunId: "run" }, first])).toBe("first");
  });

  it("is, where nobody wrote, the open thread that was selected, as it was before a main thread was kept", () => {
    expect(mainThreadToKeep([latest, later, first], undefined, "later")).toBe("later");
    expect(mainThreadToKeep([latest, later, { ...first, openedBy: { botId: "teammate" } }], undefined, "first")).toBe("first");
    expect(mainThreadToKeep([latest, { ...later, askedAt: 30 }, first], undefined, "latest")).toBe("later");
    expect(mainThreadToKeep([latest, { ...later, archivedAt: 5 }, first], undefined, "later")).toBe("first");
    expect(mainThreadToKeep([latest, { ...later, routineRunId: "run" }, first], undefined, "later")).toBe("first");
    expect(mainThreadToKeep([latest, later, first], undefined, "deleted")).toBe("first");
  });

  it("is the oldest open thread when nobody wrote and none is selected, whoever opened it, and nothing when none is open", () => {
    expect(mainThreadToKeep([latest, later, { ...first, openedBy: { botId: "teammate" } }])).toBe("first");
    expect(mainThreadToKeep([latest, { ...first, routineRunId: "run" }])).toBe("latest");
    expect(mainThreadToKeep([{ ...first, archivedAt: 2 }], undefined, "first")).toBeUndefined();
  });

  it("changes nothing while the saved thread is open", () => {
    expect(mainThreadToKeep(tasks, "latest")).toBeUndefined();
  });

  it("is the oldest open conversation a person started once the saved thread is archived or deleted, wherever they last wrote", () => {
    expect(mainThreadToKeep([latest, { ...later, askedAt: 30 }, { ...first, archivedAt: 40 }], "first")).toBe("later");
    expect(mainThreadToKeep([{ ...latest, askedAt: 50 }, later], "first")).toBe("later");
    expect(mainThreadToKeep([latest, later, { ...first, archivedAt: 40 }], "first", "latest")).toBe("later");
    expect(mainThreadToKeep([latest, { ...later, openedBy: { botId: "teammate" } }], "first", "later")).toBe("latest");
  });

  it("is the oldest open thread a bot opened once the saved thread is archived or deleted and the person has no other open", () => {
    const handed = { ...later, openedBy: { botId: "teammate" } };
    expect(mainThreadToKeep([{ ...latest, openedBy: { botId: "teammate" } }, handed, { ...first, archivedAt: 40 }], "first")).toBe("later");
    expect(mainThreadToKeep([handed], "first")).toBe("later");
    expect(mainThreadToKeep([handed, first], "later")).toBeUndefined();
    expect(mainThreadToKeep([{ ...handed, archivedAt: 41 }, { ...first, archivedAt: 40 }], "first")).toBeUndefined();
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
    expect(wasOldestThread([latest, later, { ...first, archivedAt: 9 }], "first")).toBe(true);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, { ...first, archivedAt: 8 }], "later")).toBe(true);
    expect(wasOldestThread([latest, later, first], "later")).toBe(false);
    expect(wasOldestThread([latest, { ...later, archivedAt: 9 }, first], "later")).toBe(false);
    expect(wasOldestThread([latest, later, { ...first, routineRunId: "run" }], "later")).toBe(true);
    expect(wasOldestThread([latest, { ...later, routineRunId: "run" }], "later")).toBe(false);
    expect(wasOldestThread([latest, later], "deleted")).toBe(false);
  });
});
