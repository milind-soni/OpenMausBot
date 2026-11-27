import { describe, expect, it } from "vitest";

import { escapeCancelsReply, replyAuthor, replySnippet } from "./replies";
import { citationAttachment, createCitationTextSelector, serializeCitation } from "./citations";
import type { Message } from "@/state/store";

const base: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "hello" };

describe("reply display", () => {
  it("uses human labels and member attribution", () => {
    expect(replyAuthor({ ...base, role: "user" })).toBe("You");
    expect(replyAuthor({ ...base, from: { botId: "b", name: "Scout", color: "green" } })).toBe("Scout");
    expect(replyAuthor(base, "Mochi")).toBe("Mochi");
  });

  it("turns saved images into a readable bounded snippet", () => {
    expect(replySnippet('<attached-image path="/tmp/a.png" /> hi\nthere')).toBe("[image] hi there");
    expect(replySnippet('<attached-image path="/tmp/a.png" name="Beach.png" />')).toBe("[image]");
    expect(replySnippet('<attached-file path="/tmp/a.pdf" name="Plan.pdf" />')).toBe("[file]");
    expect(replySnippet("123456", 5)).toBe("1234…");
  });

  it("uses readable citation content without leaking metadata", () => {
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: "b1", threadId: "t1", messageId: "m1" },
      createCitationTextSelector("quoted text", 0, 11)!,
      "why?",
    );
    const snippet = replySnippet(serializeCitation(citation));
    expect(snippet).toContain("quoted text");
    expect(snippet).toContain("why?");
    expect(snippet).not.toContain("omb-citation");
  });
});

describe("escapeCancelsReply", () => {
  it("drops a reply target on Escape", () => {
    expect(escapeCancelsReply({ key: "Escape" }, { replying: true, recording: false })).toBe(true);
  });
  it("leaves other keys, no target, dictation and IME composition alone", () => {
    expect(escapeCancelsReply({ key: "Enter" }, { replying: true, recording: false })).toBe(false);
    expect(escapeCancelsReply({ key: "Escape" }, { replying: false, recording: false })).toBe(false);
    expect(escapeCancelsReply({ key: "Escape" }, { replying: true, recording: true })).toBe(false);
    expect(escapeCancelsReply({ key: "Escape", isComposing: true }, { replying: true, recording: false })).toBe(false);
  });
});

describe("replySnippet markup", () => {
  it("shows markdown emphasis, code, links and headings as plain text", () => {
    expect(replySnippet("## Plan\nOnly **reply** and `copy`, see [the PR](https://example.com/pr)")).toBe("Plan Only reply and copy, see the PR");
  });
  it("leaves a lone asterisk or underscore alone", () => {
    expect(replySnippet("2 * 3 = 6 and snake_case")).toBe("2 * 3 = 6 and snake_case");
  });
});
