import { describe, expect, it } from "vitest";
import { newChatThreadId } from "@/state/new-chat";
import { mainTabThread, neighbourTab, threadTabsModel, type TabThread } from "./thread-tabs";

const thread = (threadId: string, createdAt: number, extra: Partial<TabThread> = {}): TabThread => ({ threadId, title: threadId, createdAt, ...extra });
const NONE = new Set<string>();

describe("thread tabs", () => {
  const tasks = [
    thread("main", 1),
    thread("service", 2),
    thread("nda", 3),
    thread("lease", 4, { archivedAt: 5 }),
    thread("weekly", 6, { routineRunId: "run-1" }),
    thread("handoff", 7, { openedBy: { botId: "other", name: "Pepper", at: 7 } }),
  ];

  it("shows nothing for a bot with one chat and nothing hidden", () => {
    const model = threadTabsModel({ threadId: "main", tasks: [thread("main", 1)] }, NONE);
    expect(model.shown).toBe(false);
    expect(model.tabs.map((tab) => tab.threadId)).toEqual(["main"]);
  });

  it("shows the row for one chat with a hidden thread, so the hidden one can come back", () => {
    expect(threadTabsModel({ threadId: "main", tasks: [thread("main", 1), thread("old", 2, { archivedAt: 3 })] }, NONE).shown).toBe(true);
  });

  it("puts Main first, then the person's open threads oldest first, and never the ones it started on its own", () => {
    const model = threadTabsModel({ threadId: "service", tasks }, NONE);
    expect(model.shown).toBe(true);
    expect(model.tabs.map((tab) => [tab.threadId, tab.main])).toEqual([["main", true], ["service", false], ["nda", false]]);
    expect(model.yours.map(({ task, open }) => [task.threadId, open])).toEqual([["main", true], ["service", true], ["nda", true], ["lease", false]]);
    expect(model.auto.map((task) => task.threadId)).toEqual(["handoff", "weekly"]);
  });

  it("keeps Main on the oldest thread the person started, whichever was written in last", () => {
    expect(mainTabThread([thread("weekly", 0, { routineRunId: "r" }), thread("b", 2), thread("a", 1)], "b")).toBe("a");
  });

  it("makes a started-on-its-own thread a tab once opened on this device, and shows the one on screen", () => {
    expect(threadTabsModel({ threadId: "main", tasks }, new Set(["weekly"])).tabs.map((tab) => tab.threadId)).toContain("weekly");
    const visiting = threadTabsModel({ threadId: "handoff", tasks }, NONE);
    expect(visiting.selected).toBe("handoff");
    expect(visiting.tabs.find((tab) => tab.threadId === "handoff")?.auto).toBe(true);
  });

  it("selects the thread being switched to, and draws the blank New thread tab last", () => {
    expect(threadTabsModel({ threadId: "main", switchingTo: "nda", tasks }, NONE).selected).toBe("nda");
    const blank = threadTabsModel({ threadId: newChatThreadId("bot"), tasks: [thread("main", 1)] }, NONE);
    expect(blank.shown).toBe(true);
    expect(blank.tabs.at(-1)).toMatchObject({ blank: true, threadId: newChatThreadId("bot") });
    expect(blank.selected).toBe(newChatThreadId("bot"));
    expect(blank.mainId).toBe("main");
  });

  it("lands on the tab before a hidden one, else the one after", () => {
    const { tabs } = threadTabsModel({ threadId: "main", tasks }, NONE);
    expect(neighbourTab(tabs, "nda")?.threadId).toBe("service");
    expect(neighbourTab(tabs, "main")?.threadId).toBe("service");
  });
});
