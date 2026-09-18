import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { buildRoomContext, ROOM_DELTA_UNTRUSTED_PREFIX } from "./room-context.ts";

function message(id: string, text: string, extra: Partial<Message> = {}): Message {
  return { id, at: 1, role: "user", kind: "text", text, ...extra };
}

describe("room context", () => {
  it("keeps full serialization compatible and renders provenance through the shared path", () => {
    const input = {
      messages: [
        message("u1", "first"),
        message("b1", "own reply", { role: "bot", from: { botId: "reader", name: "Reader", color: "blue" } }),
        message("p1", "own peer post", { role: "bot", peerPost: {}, from: { botId: "reader", name: "Reader", color: "blue" } }),
        message("p2", "peer reply", { role: "bot", peerPost: { unattended: true }, from: { botId: "peer", name: "Scout", color: "green" } }),
      ],
      userName: "Nirvaan",
      readerBotId: "reader",
      teammateReport: () => "report",
    };
    const context = buildRoomContext(input);
    expect(context.full).toContain("Nirvaan: first\nReader: own reply\nReader: own peer post");
    expect(context.full).toContain("Scout: peer reply");
    expect(context.full).toContain("Posted by @Scout");
  });

  it("sends unseen messages, omits same-bot native replies, and keeps same-bot peer posts", () => {
    const context = buildRoomContext({
      messages: [
        message("u1", "first"),
        message("b1", "own reply", { role: "bot", from: { botId: "reader", name: "Reader", color: "blue" } }),
        message("p1", "own peer post", { role: "bot", peerPost: {}, from: { botId: "reader", name: "Reader", color: "blue" } }),
        message("u2", "second"),
      ],
      userName: "Nirvaan",
      readerBotId: "reader",
      teammateReport: () => "report",
    });
    const delta = context.deltaFor("u1");
    expect(delta.anchorFound).toBe(true);
    expect(delta.eligibleMessages).toBe(3);
    expect(delta.sentMessages).toBe(2);
    expect(delta.text).toContain(ROOM_DELTA_UNTRUSTED_PREFIX);
    expect(delta.text).not.toContain("own reply");
    expect(delta.text).toContain("own peer post");
    expect(delta.text).toContain("Nirvaan: second");
  });

  it("requests a rebuild instead of guessing when the bounded anchor rotated away", () => {
    const context = buildRoomContext({
      messages: [message("u2", "new")],
      userName: "Nirvaan",
      teammateReport: () => "report",
    });
    expect(context.deltaFor("old")).toMatchObject({ anchorFound: false, eligibleMessages: 0, sentMessages: 0 });
  });
});
