// The boundary between My Cloud's ids and this page's: only ids and file references move, never what anyone wrote.
import { describe, expect, it } from "vitest";
import { intoPlace, outOfPlace } from "./place-ids.ts";

describe("ids and files cross the boundary, words never do", () => {
  it("leaves a message whose text is exactly a file address as written, both ways", () => {
    const message = { id: "m1", threadId: "t1", text: "/api/attachments/aa11.png", kind: "text" };
    expect(intoPlace(message)).toEqual({ ...message, threadId: "cloud:t1" });
    expect(outOfPlace({ text: "/api/attachments/cloud--aa11.png", threadId: "cloud:t1" }, () => "/api/attachments/aa11.png")).toEqual({ text: "/api/attachments/cloud--aa11.png", threadId: "t1" });
    expect(outOfPlace({ text: "cloud:t1 is the thread" })).toEqual({ text: "cloud:t1 is the thread" });
  });

  it("leaves what a bot wrote alone, ids and all: a widget, an app, a tool call", () => {
    const written = { kind: "widget", threadId: "t1", widget: { botId: "scout", threadId: "t1", html: "<b>/api/attachments/x.png</b>" }, app: { botId: "scout" }, tool: { input: { threadId: "t1" } } };
    const placed = intoPlace(written) as typeof written;
    expect(placed.threadId).toBe("cloud:t1");
    expect(placed.widget).toEqual(written.widget);
    expect(placed.app).toEqual(written.app);
    expect(placed.tool).toEqual(written.tool);
    const sent = outOfPlace({ threadId: "cloud:t1", widget: { botId: "cloud:keep" } }) as { threadId: string; widget: { botId: string } };
    expect(sent).toEqual({ threadId: "t1", widget: { botId: "cloud:keep" } });
  });

  it("names a message's files and a bot's avatar under the page's names, and never shows where a file came from on My Cloud", () => {
    const kept = new Map<string, string>();
    const bot = { bot: { id: "scout", avatarUrl: "/api/attachments/face.png", messages: [{ id: "m1", attachments: [{ kind: "file", path: "/data/out/report.pdf", name: "report.pdf", source: "/Users/someone/report.pdf" }] }] } };
    const placed = intoPlace(bot, (name, path) => kept.set(name, path)) as { bot: { id: string; avatarUrl: string; messages: Array<{ attachments: Array<Record<string, unknown>> }> } };
    expect(placed.bot.id).toBe("cloud:scout");
    expect(placed.bot.avatarUrl).toBe("/api/attachments/cloud--face.png");
    expect(placed.bot.messages[0]!.attachments[0]).toEqual({ kind: "file", path: "cloud--report.pdf", name: "report.pdf" });
    // A file named back goes back as My Cloud gave it, wherever the request puts it.
    expect(outOfPlace({ path: "cloud--report.pdf" }, (name) => kept.get(name))).toEqual({ path: "/data/out/report.pdf" });
    expect(outOfPlace({ attachments: [{ path: "cloud--report.pdf" }] }, (name) => kept.get(name))).toEqual({ attachments: [{ path: "/data/out/report.pdf" }] });
  });

  it("puts a media link on the conversation's place route, and nothing else that looks like one", () => {
    expect(intoPlace({ url: "/api/threads/t1/messages/m1/file?media=abc" })).toEqual({ url: "/api/threads/cloud%3At1/messages/m1/file?media=abc" });
    expect(intoPlace({ message: { url: "/api/threads/t1/messages/m1/file?media=abc" } })).toEqual({ message: { url: "/api/threads/t1/messages/m1/file?media=abc" } });
  });

  it("leaves a card's own data alone: a routine run's, a data result's and a burst's", () => {
    const message = { threadId: "t1", routineRun: { data: { botId: "x", threadId: "y" } }, dataResult: { botId: "x", cardId: "c" }, burst: { extra: { fromThreadId: "z" } } };
    const placed = intoPlace(message) as typeof message;
    expect(placed.threadId).toBe("cloud:t1");
    expect(placed.routineRun).toEqual(message.routineRun);
    expect(placed.dataResult).toEqual(message.dataResult);
    expect(placed.burst).toEqual(message.burst);
    expect(outOfPlace({ dataResult: { botId: "cloud:x" } })).toEqual({ dataResult: { botId: "cloud:x" } });
  });
});
