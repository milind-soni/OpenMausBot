import { describe, expect, it } from "vitest";

import { modelWords, outsideRoomNote, sentRow } from "./handoff-sent.ts";

const sender = { id: "chief", name: "Chief", color: "blue" };
const recipient = { id: "buyer", name: "Buyer Research", color: "green" };
const sales = { id: "sales", name: "Sales", here: true };

describe("sentRow", () => {
  it("names the model the work runs on and its reasoning level after the row's words, and none on a thread of its own", () => {
    const levels = ["low", "medium", "high"];
    expect(modelWords("en", { instanceId: "claude", model: "claude-opus-5", effort: "high" }, { label: "Opus 5", levels })).toBe("Opus 5 · High reasoning");
    expect(modelWords("en", { instanceId: "claude", model: "claude-opus-5" }, { label: "Opus 5", levels })).toBe("Opus 5 · Default reasoning");
    expect(modelWords("en", { instanceId: "kimi", model: "kimi-k2" }, { label: "Kimi K2" })).toBe("Kimi K2");
    expect(modelWords("en", { instanceId: "pi", model: "m", effort: "high" }, { label: "M", levels, variants: true })).toBe("M");
    const row = sentRow({ sender, recipient, threadId: "buyer-work", via: "direct", model: "Opus 5 · High reasoning" });
    expect(row.tool).toMatchObject({ name: "Sent to Buyer Research", assignedModel: "Opus 5 · High reasoning" });
    expect(row.tool).not.toHaveProperty("summary");
    expect(sentRow({ sender, recipient: sender, threadId: "own", title: "Review", via: "direct", model: "Opus 5 · High reasoning" }).tool).not.toHaveProperty("assignedModel");
  });


  it("carries the files passed with the hand-off, for the line's chips", () => {
    const report = { kind: "file" as const, path: "/data/attachments/1f0c.pdf", mime: "application/pdf", name: "report.pdf" };
    expect(sentRow({ sender, recipient, threadId: "buyer-work", via: "direct", attachments: [report] }).attachments).toEqual([report]);
    expect(sentRow({ sender, recipient, threadId: "buyer-work", via: "direct", attachments: [] })).not.toHaveProperty("attachments");
    expect(sentRow({ sender, recipient, threadId: "buyer-work", via: "direct" })).not.toHaveProperty("attachments");
  });

  it("says a bot outside the addressed room got the work directly, and links to its thread", () => {
    const row = sentRow({ sender, recipient, threadId: "buyer-work", title: "@Chief · work", room: sales, via: "direct" });
    expect(row).toMatchObject({
      tool: { name: "Sent to Buyer Research directly: it isn't in this room.", ok: true },
      sentDirectly: { name: "Buyer Research" },
      threadRef: { botId: "buyer", threadId: "buyer-work", title: "@Chief · work" },
    });
    expect(row.comm).toBeUndefined();
    const elsewhere = sentRow({ sender, recipient, threadId: "buyer-work", room: { ...sales, here: false }, via: "direct" });
    expect(elsewhere.tool?.name).toBe("Sent to Buyer Research directly: it isn't in Sales.");
    expect(elsewhere.sentDirectly).toEqual({ name: "Buyer Research", room: "Sales" });
  });

  it("keeps the room chip, the lane link and a plain direct hand-off as they were", () => {
    expect(sentRow({ sender, recipient, threadId: "sales-thread", room: { ...sales, here: false }, via: "room", reason: "why" })).toMatchObject({
      tool: { name: "Sent to Buyer Research · Sales", ok: true, output: "why" },
      comm: { groupId: "sales", threadId: "sales-thread", withBotId: "buyer" },
    });
    const lane = sentRow({ sender, recipient, threadId: "lane", title: "Sales · job", room: sales, via: "lane" });
    expect([lane.tool?.name, lane.threadRef?.threadId, lane.sentDirectly]).toEqual(["Sent to Buyer Research", "lane", undefined]);
    const direct = sentRow({ sender, recipient, threadId: "buyer-work", via: "direct" });
    expect([direct.tool?.name, direct.threadRef?.title, direct.sentDirectly]).toEqual(["Sent to Buyer Research", "Teammate work", undefined]);
  });

  it("names a bot's own new thread by its title, linked like a teammate's", () => {
    const own = sentRow({ sender, recipient: sender, threadId: "chief-review", title: "Review: GPT", via: "direct", doneWhen: "every finding has a line" });
    expect(own).toMatchObject({ tool: { name: "Opened thread #Review: GPT", ok: true }, doneWhen: "every finding has a line",
      threadRef: { botId: "chief", threadId: "chief-review", title: "Review: GPT" } });
  });
});

describe("outsideRoomNote", () => {
  it("leads a receipt only when the bot isn't in the room the work was addressed to", () => {
    expect(outsideRoomNote(sales, "direct")).toBe("it isn't in this room, so it got this directly: ");
    expect(outsideRoomNote({ ...sales, here: false }, "direct")).toBe("it isn't in Sales, so it got this directly: ");
    expect(outsideRoomNote(sales, "room")).toBe("");
    expect(outsideRoomNote(undefined, "direct")).toBe("");
  });
});
