import { describe, expect, it } from "vitest";
import { collectBotLibrary, replyFileLinks } from "./bot-library.ts";
import { deleteThread, importThread } from "./message-db.ts";
import type { PublishedPageRecord } from "./pages/store.ts";
import type { Message } from "./store.ts";

const reply = (id: string, at: number, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, parentId: null, at, role: "bot", kind: "text", text, ...extra }) as Message;
const app = (id: string, at: number, title: string, doc = `doc-${id}`): Message =>
  ({ id, parentId: null, at, role: "bot", kind: "app", text: title, app: { v: 1, source: { kind: "html" }, title, doc, rev: 0 } }) as unknown as Message;
const record = (pageId: string, updatedAt: number, cards: Array<[string, string]>, over: Partial<PublishedPageRecord> = {}): PublishedPageRecord => ({
  pageId, url: `https://${pageId}.mausbot.page/`, title: `Page ${pageId}`, botId: "scout", source: `/work/${pageId}`,
  cards: cards.map(([threadId, messageId]) => ({ threadId, messageId })), createdAt: updatedAt, updatedAt, ...over,
});

describe("collectBotLibrary", () => {
  it("lists pages, apps and shared files from every conversation it is given, newest first", () => {
    importThread("lib-a", [app("a1", 100, "Budget"), reply("r1", 110, "Here: [plan](/work/plan.md) and [site](https://example.com)"), app("a2", 300, "Tracker")], "a2");
    importThread("lib-b", [app("b1", 200, "Quiz"), reply("r2", 210, "Attached.", { attachments: [{ path: "/work/out.csv", kind: "file", name: "out.csv", mime: "text/csv" }, { path: "/work/shot.png", kind: "image", mime: "image/png" }] })], "r2");
    importThread("lib-archived", [app("c1", 50, "Old app"), reply("r3", 55, "See [notes][n]\n\n[n]: ./notes.txt")], "r3");
    const pages = [
      record("aaaaaaaaaaaaaaaaaaaa", 400, [["lib-a", "pa"]]),
      record("bbbbbbbbbbbbbbbbbbbb", 500, [["lib-b", "pb"]]),
      record("cccccccccccccccccccc", 600, [["lib-gone", "pc"]]),
      record("dddddddddddddddddddd", 700, [["lib-a", "pd"]], { botId: "someone-else" }),
    ];
    const library = collectBotLibrary({ botId: "scout", threadIds: ["lib-a", "lib-b", "lib-archived"], pages });
    expect(library.pages.map((page) => [page.title, page.threadId])).toEqual([["Page bbbbbbbbbbbbbbbbbbbb", "lib-b"], ["Page aaaaaaaaaaaaaaaaaaaa", "lib-a"]]);
    expect(library.apps.map((each) => [each.title, each.threadId])).toEqual([["Tracker", "lib-a"], ["Quiz", "lib-b"], ["Budget", "lib-a"], ["Old app", "lib-archived"]]);
    expect(library.files).toEqual([
      { threadId: "lib-b", messageId: "r2", at: 210, attachments: [{ path: "/work/out.csv", kind: "file", name: "out.csv" }, { path: "/work/shot.png", kind: "image" }], links: [] },
      { threadId: "lib-a", messageId: "r1", at: 110, attachments: [], links: ["/work/plan.md"] },
      { threadId: "lib-archived", messageId: "r3", at: 55, attachments: [], links: ["./notes.txt"] },
    ]);
  });

  it("leaves out a deleted conversation's items and pages taken down, and names a page once in its newest conversation", () => {
    importThread("del-a", [app("x1", 10, "Kept")], "x1");
    importThread("del-b", [app("x2", 20, "Deleted with its conversation")], "x2");
    deleteThread("del-b");
    const pages = [record("eeeeeeeeeeeeeeeeeeee", 30, [["del-a", "p1"], ["del-b", "p2"], ["del-c", "p3"]])];
    const library = collectBotLibrary({ botId: "scout", threadIds: ["del-a", "del-c"], pages });
    expect(library.apps.map((each) => each.title)).toEqual(["Kept"]);
    expect(library.pages).toEqual([{ threadId: "del-c", messageId: "p3", at: 30, title: "Page eeeeeeeeeeeeeeeeeeee", url: "https://eeeeeeeeeeeeeeeeeeee.mausbot.page/" }]);
    expect(collectBotLibrary({ botId: "scout", threadIds: ["del-a"], pages: [] }).pages).toEqual([]);
  });

  it("counts a fork's copies once, as the original, and skips an app with nothing stored", () => {
    importThread("fork-src", [app("f1", 10, "Shared app"), reply("fr", 11, "[deck](/work/deck.key)")], "fr");
    importThread("fork-copy", [app("f1", 10, "Shared app"), reply("fr", 11, "[deck](/work/deck.key)"), app("f2", 12, "Blocked", "")], "f2");
    const library = collectBotLibrary({ botId: "scout", threadIds: ["fork-src", "fork-copy"], pages: [] });
    expect(library.apps.map((each) => [each.messageId, each.threadId])).toEqual([["f1", "fork-src"]]);
    expect(library.files.map((each) => [each.messageId, each.threadId])).toEqual([["fr", "fork-src"]]);
  });

  it("answers nothing for no conversations", () => {
    expect(collectBotLibrary({ botId: "scout", threadIds: [], pages: [record("ffffffffffffffffffff", 1, [["x", "y"]])] })).toEqual({ pages: [], apps: [], files: [] });
  });
});

describe("replyFileLinks", () => {
  it("keeps local links and reference links as authored, never web links, anchors or images", () => {
    const text = "[a](/Users/me/a.md) [b](<./b c.txt>) [web](https://x.dev/a.md) [top](#top) ![pic](/work/pic.png) [![badge](/work/b.png)](/work/b.html)"
      + " [w](C:\\work\\w.docx) [f](file:///tmp/f.txt) [r][ref]\n\n[ref]: ../r.pdf";
    expect(replyFileLinks(text).sort()).toEqual(["../r.pdf", "./b c.txt", "/Users/me/a.md", "C:\\work\\w.docx", "file:///tmp/f.txt"].sort());
  });
});
