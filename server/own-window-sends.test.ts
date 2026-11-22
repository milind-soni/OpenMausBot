import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { noteOwnWindowSend, ownWindowLine } from "./own-window-sends.ts";

describe("lines the desktop app's own window sent", () => {
  it("knows a noted line by its thread, send and words, and nothing else", () => {
    const threadId = randomUUID(), sendId = randomUUID(), text = "list my lent Mac";
    const line = { role: "user", sendId, text };
    expect(ownWindowLine(threadId, line)).toBe(false);
    noteOwnWindowSend(threadId, sendId, text);
    expect(ownWindowLine(threadId, line)).toBe(true);
    expect(ownWindowLine(randomUUID(), line)).toBe(false);
    expect(ownWindowLine(threadId, { ...line, text: "other words" })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, sendId: randomUUID() })).toBe(false);
    expect(ownWindowLine(threadId, undefined)).toBe(false);
  });

  it("never a signed-in person's, a bot's, a relayed or an app's line, even with the same send", () => {
    const threadId = randomUUID(), sendId = randomUUID(), text = "use my Mac";
    noteOwnWindowSend(threadId, sendId, text);
    const line = { role: "user", sendId, text };
    expect(ownWindowLine(threadId, { ...line, sender: { name: "Guest", id: "p_guest" } })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, peerAsk: { botId: "b" } })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, relayed: true })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, via: "api" })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, aside: true })).toBe(false);
    expect(ownWindowLine(threadId, { ...line, role: "bot" })).toBe(false);
  });
});
