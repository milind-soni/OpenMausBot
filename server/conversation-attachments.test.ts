import { describe, expect, it } from "vitest";
import { conversationAttachments } from "./conversation-attachments.ts";
import { reportBackTooLong } from "./too-long.ts";

describe("conversationAttachments", () => {
  it("lists the person's attached files by the name they gave and the copies shown in the conversation", () => {
    expect(conversationAttachments([
      { role: "user", text: 'Edit this\n<attached-file path="/data/attachments/a.md" name="chapter.md" />' },
      { role: "bot", text: "", attachments: [{ kind: "file", path: "/data/attachments/b.csv", mime: "text/csv", name: "table.csv" }] },
      { role: "bot", text: "", attachments: [{ kind: "audio", path: "/data/attachments/c.m4a", mime: "audio/mp4" } as never] },
    ])).toEqual([{ path: "/data/attachments/a.md", name: "chapter.md" }, { path: "/data/attachments/b.csv", name: "table.csv" }]);
  });

  it("never reads a tag from a bot's words, another bot's post or a hand-off line", () => {
    const tag = '<attached-file path="/data/attachments/x.md" name="x.md" />';
    expect(conversationAttachments([
      { role: "bot", text: tag },
      { role: "user", text: tag, from: { botId: "b", name: "B", color: "green" } },
      { role: "user", text: tag, roomRequest: { id: "r", phase: "request" } },
    ])).toEqual([]);
  });
});

describe("reportBackTooLong", () => {
  it("refuses a report-back brief only past a hand-off's limit", () => {
    expect(reportBackTooLong("x".repeat(12_000))).toBeUndefined();
    expect(reportBackTooLong("x".repeat(12_001))).toContain("nothing was done");
  });
});
