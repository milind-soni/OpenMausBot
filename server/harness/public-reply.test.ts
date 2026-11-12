import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { publicReplyEvent, savedReplyText } from "./public-reply.ts";

const words = (delta: string): RuntimeEvent =>
  ({ eventId: "e1", provider: "fake", threadId: "t", createdAt: "", turnId: "turn-1", itemId: "turn-1:m1", type: "content.delta", streamKind: "assistant_text", delta }) as RuntimeEvent;

describe("a reply as it goes out", () => {
  it("carries a finished reply's text as its saved message holds it, and the bus's own copy is untouched", () => {
    const text = "Done. <openmaus-goal>{\"status\":\"done\"}</openmaus-goal> Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const completed = { ...words(""), type: "item.completed", itemType: "assistant_text", text } as RuntimeEvent;
    const sent = publicReplyEvent(completed);
    expect(sent.type === "item.completed" && sent.itemType === "assistant_text" && sent.text).toBe(redactSecretsInText("Done.  Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
    expect(savedReplyText("plain words")).toBe("plain words");
    expect(completed.type === "item.completed" && completed.itemType === "assistant_text" && completed.text).toBe(text);
  });

  it("names a room reply's speaker on its words, and nothing on a direct chat's or on thinking", () => {
    const said = words("Hi ");
    expect(publicReplyEvent(said, "b2")).toMatchObject({ botId: "b2", delta: "Hi " });
    expect(publicReplyEvent(said)).toBe(said);
    const thinking = { ...said, streamKind: "reasoning_text" } as RuntimeEvent;
    expect(publicReplyEvent(thinking, "b2")).toBe(thinking);
  });
});
