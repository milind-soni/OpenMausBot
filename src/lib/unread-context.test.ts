import { describe, expect, it } from "vitest";
import { serializeCitation, type CitationAttachment } from "./citations";
import { hasUnreadContextContent, isRowOffscreen, unreadContextCitations, unreadContextContent, unreadContextMessage } from "./unread-context";
import type { Message } from "@/state/store";

const line = (id: string, role: Message["role"], fields: Partial<Message> = {}): Message =>
  ({ id, role, kind: "text", text: id, at: Number(id.replace(/\D/g, "")) || 1, ...fields });

const citation = (id: string, quote: string, comment?: string): CitationAttachment => ({
  kind: "citation",
  version: 1,
  id,
  quote,
  ...(comment ? { comment } : {}),
  source: { ownerType: "bot", ownerId: "bot-1", threadId: "t1", messageId: "m1", start: 0, end: quote.length, prefix: "", suffix: "" },
  size: quote.length + (comment?.length ?? 0),
});

const attachmentImage = '\n\n<attached-image path="/tmp/shot.png" />';
const attachmentFile = '\n\n<attached-file path="/tmp/report.pdf" />';

const viewport = { top: 100, bottom: 900, height: 800 };

describe("unreadContextMessage", () => {
  it("takes the person's own text line just above the unread divider", () => {
    const rows = [
      line("u1", "user"),
      line("b2", "bot"),
      line("u3", "user"),
      line("b4", "bot"),
      line("b5", "bot", { kind: "activity" }),
      line("u6", "user", { text: "  " }),
    ];
    expect(unreadContextMessage(rows, "b5")?.id).toBe("u3");
  });

  it("skips another bot's line and non-text rows", () => {
    const peer = line("p4", "user", { peerAsk: { botId: "chief", name: "Chief" } });
    const legacyPeer = line("p5", "user", { text: "[Message from @Chief, another bot in this OpenMausBot workspace] hi" });
    const rows = [line("u1", "user"), line("b2", "bot"), peer, legacyPeer, line("a6", "user", { kind: "activity" }), line("b7", "bot")];
    expect(unreadContextMessage(rows, "b7")?.id).toBe("u1");
    expect(unreadContextMessage([line("b2", "bot"), line("u3", "user")], "b2")).toBeNull();
  });

  it("is null without unread, without a placed divider, or without a person's line before it", () => {
    const rows = [line("u1", "user"), line("b2", "bot")];
    expect(unreadContextMessage(rows, null)).toBeNull();
    expect(unreadContextMessage(rows, "gone")).toBeNull();
    expect(unreadContextMessage([line("b1", "bot"), line("b2", "bot")], "b2")).toBeNull();
  });

  it("never takes a line at or after the divider", () => {
    const rows = [line("b1", "bot"), line("b2", "bot"), line("u3", "user")];
    expect(unreadContextMessage(rows, "b2")).toBeNull();
  });
});

describe("unreadContextContent", () => {
  it("keeps the typed text and pulls citations out of the encoded marker", () => {
    const first = citation("c1", "被引用的原文", "我的评论");
    const text = `看看这个\n\n${serializeCitation(first)}`;
    const content = unreadContextContent({ text });
    expect(content.text).toBe("看看这个");
    expect(content.citations).toHaveLength(1);
    expect(content.citations[0]).toMatchObject({ quote: "被引用的原文", comment: "我的评论", source: { messageId: "m1" } });
    expect(content.attachment).toBeNull();
  });

  it("keeps every citation so the card can expand the first and badge the rest", () => {
    const text = `两条引用\n\n${serializeCitation(citation("c1", "第一段"))}\n${serializeCitation(citation("c2", "第二段", "说明"))}`;
    const content = unreadContextContent({ text });
    expect(content.text).toBe("两条引用");
    expect(content.citations.map((entry) => entry.id)).toEqual(["c1", "c2"]);
    expect(content.citations[1]?.comment).toBe("说明");
  });

  it("lays out the first three citations flat and counts the rest", () => {
    const citations = ["一", "二", "三", "四"].map((quote, index) => citation(`c${index + 1}`, quote));
    const { shown, hidden } = unreadContextCitations(citations);
    expect(shown.map((entry) => entry.quote)).toEqual(["一", "二", "三"]);
    expect(hidden).toBe(1);
    expect(unreadContextCitations(citations.slice(0, 3))).toEqual({ shown: citations.slice(0, 3), hidden: 0 });
    expect(unreadContextCitations([])).toEqual({ shown: [], hidden: 0 });
  });

  it("reports an image-only or file-only message instead of leaving the card blank", () => {
    const image = unreadContextContent({ text: attachmentImage });
    expect(image.text).toBe("");
    expect(image.attachment).toBe("images");
    expect(image.imageCount).toBe(1);
    expect(hasUnreadContextContent(image)).toBe(true);

    const file = unreadContextContent({ text: attachmentFile });
    expect(file.attachment).toBe("files");
    expect(file.fileCount).toBe(1);

    const both = unreadContextContent({ text: `${attachmentImage}${attachmentFile}` });
    expect(both.attachment).toBe("both");
    expect(both.imageCount).toBe(1);
    expect(both.fileCount).toBe(1);
  });

  it("keeps a message with text and attachments readable as text", () => {
    const content = unreadContextContent({ text: `带图片的说明${attachmentImage}` });
    expect(content.text).toBe("带图片的说明");
    expect(content.attachment).toBeNull();
    expect(content.imageCount).toBe(1);
  });

  it("has nothing to show for a message with no text, citation or attachment", () => {
    expect(hasUnreadContextContent(unreadContextContent({ text: "  " }))).toBe(false);
  });
});

describe("isRowOffscreen", () => {
  it("is true only when the row sits entirely above or below the first screen", () => {
    expect(isRowOffscreen({ top: 20, bottom: 80, height: 60 }, viewport)).toBe(true);
    expect(isRowOffscreen({ top: 920, bottom: 980, height: 60 }, viewport)).toBe(true);
    expect(isRowOffscreen({ top: 80, bottom: 140, height: 60 }, viewport)).toBe(false);
    expect(isRowOffscreen({ top: 200, bottom: 260, height: 60 }, viewport)).toBe(false);
    expect(isRowOffscreen({ top: 880, bottom: 940, height: 60 }, viewport)).toBe(false);
  });

  it("stays closed when layout is not measurable yet", () => {
    expect(isRowOffscreen(null, viewport)).toBe(false);
    expect(isRowOffscreen({ top: 0, bottom: 0, height: 0 }, viewport)).toBe(false);
    expect(isRowOffscreen({ top: 20, bottom: 80, height: 60 }, { top: 0, bottom: 0, height: 0 })).toBe(false);
  });
});
