import { describe, expect, it } from "vitest";

import type { BotLibrary } from "../../../shared/bot-library";
import type { Bot, Message } from "@/state/store";
import { allLibraryItems, libraryItems, threadLabel } from "./library-items";

const bot = (messages: Message[], over: Partial<Bot> = {}) => ({
  id: "scout", threadId: "t1", messages,
  tasks: [{ threadId: "t1", title: "Launch", createdAt: 1 }, { threadId: "t2", title: "Pricing", createdAt: 2 }, { threadId: "t3", title: "Archived", createdAt: 3, archivedAt: 4 }],
  ...over,
}) as unknown as Bot;
const live = (id: string, at: number, url: string): Message => ({ id, role: "bot", kind: "text", text: "", at, publishedPage: { state: "live", title: id, url } }) as Message;
const reply = (id: string, at: number, text: string): Message => ({ id, role: "bot", kind: "text", text, at }) as Message;

describe("allLibraryItems", () => {
  it("puts the open conversation's loaded items with the other conversations', newest first, each thing once", () => {
    const open = bot([live("m1", 20, "https://one.mausbot.page/"), reply("m2", 30, "[plan](/work/plan.md)")]);
    const remote: BotLibrary = {
      pages: [
        { threadId: "t2", messageId: "p2", at: 50, title: "Two", url: "https://two.mausbot.page/" },
        // The same page shown again in an older conversation: listed once, newest first.
        { threadId: "t3", messageId: "p3", at: 5, title: "One again", url: "https://one.mausbot.page/" },
      ],
      apps: [
        { threadId: "t3", messageId: "a3", at: 1, title: "Archived app" },
        { threadId: "t2", messageId: "a2", at: 40, title: "Quote" },
        { threadId: "gone", messageId: "a9", at: 99, title: "Deleted conversation's app" },
      ],
      files: [
        { threadId: "t2", messageId: "f2", at: 60, attachments: [{ path: "/work/out.csv", kind: "file", name: "out.csv" }, { path: "/work/pic.png", kind: "image" }], links: ["/work/pic.png", "/work/plan.md"] },
        { threadId: "t3", messageId: "f3", at: 10, attachments: [], links: ["https://example.com/x.md", "./notes.txt"] },
      ],
    };
    const items = allLibraryItems(open, libraryItems(open), remote);
    expect(items.pages.map((page) => [page.title, page.threadId])).toEqual([["Two", "t2"], ["m1", "t1"]]);
    expect(items.apps.map((app) => app.title)).toEqual(["Quote", "Archived app"]);
    expect(items.shared.map((item) => [item.file.name, item.threadId])).toEqual([["out.csv", "t2"], ["plan.md", "t2"], ["notes.txt", "t3"]]);
  });

  it("trusts the open conversation's loaded messages over the server's answer about them, and has only them without one", () => {
    const open = bot([{ ...live("m1", 20, "https://one.mausbot.page/"), publishedPage: { state: "unpublished", title: "m1", url: "https://one.mausbot.page/" } } as Message]);
    const remote: BotLibrary = { pages: [{ threadId: "t1", messageId: "m1", at: 20, title: "m1", url: "https://one.mausbot.page/" }], apps: [], files: [] };
    expect(allLibraryItems(open, libraryItems(open), remote).pages).toEqual([]);
    const local = libraryItems(bot([live("m5", 5, "https://five.mausbot.page/")]));
    expect(allLibraryItems(bot([]), local, null)).toBe(local);
  });
});

describe("threadLabel", () => {
  it("names the conversation, with threads hidden the main one as such, and nothing while there is only one", () => {
    expect(threadLabel(bot([]), "t2", true)).toBe("Pricing");
    expect(threadLabel(bot([], { mainThreadId: "t1" }), "t1", false)).toBe("Main thread");
    expect(threadLabel(bot([], { mainThreadId: "t1" }), "t1", true)).toBe("Launch");
    expect(threadLabel(bot([], { mainThreadId: "t1" }), "t2", false)).toBe("Pricing");
    expect(threadLabel(bot([], { tasks: [{ threadId: "t1", title: "Launch", createdAt: 1 }] }), "t1", false)).toBeUndefined();
  });
});
