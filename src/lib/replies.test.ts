import { describe, expect, it } from "vitest";

import { replyAuthor, replySnippet } from "./replies";
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
