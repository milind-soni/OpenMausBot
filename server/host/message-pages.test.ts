import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { pageMessage, TOOL_OUTPUT_PREVIEW } from "./message-pages.ts";

const step = (output: string | undefined, extra: Partial<Message> = {}): Message => ({
  id: "m1", role: "bot", kind: "activity", at: 1, text: "", turnId: "t1",
  tool: { name: "Read", ok: true, summary: "read notes.md", input: JSON.stringify({ path: "notes.md", text: "x".repeat(5_000) }), output },
  ...extra,
} as Message);

describe("pageMessage", () => {
  it("leaves a step whose output fits the preview exactly as stored", () => {
    for (const output of [undefined, "", "short", "y".repeat(TOOL_OUTPUT_PREVIEW)]) {
      const message = step(output);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("cuts a long output to its start, marks it clipped and keeps everything else", () => {
    const message = step("z".repeat(6_000));
    const paged = pageMessage(message) as Message;
    expect(paged.tool).toEqual({ ...message.tool, output: "z".repeat(TOOL_OUTPUT_PREVIEW), clipped: true });
    expect(paged.tool!.input).toBe(message.tool!.input);
    expect({ ...paged, tool: undefined }).toEqual({ ...message, tool: undefined });
    expect(message.tool!.output).toHaveLength(6_000);
    expect(message.tool).not.toHaveProperty("clipped");
  });

  it("never splits a surrogate pair at the cut", () => {
    const output = `${"a".repeat(TOOL_OUTPUT_PREVIEW - 1)}😀${"b".repeat(50)}`;
    const paged = pageMessage(step(output)) as Message;
    expect(paged.tool!.output).toBe("a".repeat(TOOL_OUTPUT_PREVIEW - 1));
    expect(paged.tool).toHaveProperty("clipped", true);
  });

  it("keeps whole the rows whose output is the reply itself", () => {
    const long = "r".repeat(6_000);
    const rows: Array<Partial<Message>> = [
      { relay: { kind: "told", email: "bob@example.com", name: "Bob" } },
      { roomRequest: { id: "q1", phase: "result" } },
      { comm: { groupId: "g1", withBotId: "b2", withName: "Ada", withColor: "blue" } },
      { threadRef: { botId: "b1", threadId: "th2", title: "Side job" } },
      { kind: "text" },
    ];
    for (const extra of rows) {
      const message = step(long, extra);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("still drops a screen's picture", () => {
    const screen = { id: "s1", role: "bot", kind: "screen", at: 1, text: "", png: "iVBOR" } as Message;
    expect(pageMessage(screen)).toEqual({ id: "s1", role: "bot", kind: "screen", at: 1, text: "", hasImage: true });
  });
});
