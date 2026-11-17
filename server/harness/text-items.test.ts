import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { TextItems } from "./text-items.ts";
import { publishedMessages } from "./text-items.testkit.ts";

let seq = 0;
const event = (fields: Partial<RuntimeEvent>, turnId = "turn-1"): RuntimeEvent =>
  ({ eventId: `e${++seq}`, provider: "fake", threadId: "t", createdAt: "", turnId, ...fields }) as RuntimeEvent;
const words = (delta: string, extra: Partial<RuntimeEvent> = {}, turnId?: string) =>
  event({ type: "content.delta", streamKind: "assistant_text", delta, ...extra } as Partial<RuntimeEvent>, turnId);
const done = (text: string, extra: Partial<RuntimeEvent> = {}, turnId?: string) =>
  event({ type: "item.completed", itemType: "assistant_text", text, ...extra } as Partial<RuntimeEvent>, turnId);
const tool = (itemId: string) => [
  event({ type: "item.started", itemType: "tool", itemId, title: "ls" } as Partial<RuntimeEvent>),
  event({ type: "item.completed", itemType: "tool", itemId, ok: true } as Partial<RuntimeEvent>),
];

describe("reply text ids", () => {
  it("gives an engine that names no message one id per message: text, tool, text, tool, text", () => {
    const messages = publishedMessages([
      event({ type: "turn.started" }),
      words("Looking "), words("first."), done("Looking first."),
      ...tool("c1"),
      words("Found "), words("three."), done("Found three."),
      ...tool("c2"),
      words("All "), words("done."), done("All done."),
      event({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>),
    ]);
    expect(messages.map(({ streamed, completed }) => ({ streamed, completed }))).toEqual([
      { streamed: "Looking first.", completed: "Looking first." },
      { streamed: "Found three.", completed: "Found three." },
      { streamed: "All done.", completed: "All done." },
    ]);
    expect(new Set(messages.map((message) => message.itemId)).size).toBe(3);
  });

  it("starts a new message after one completes, with no tool between", () => {
    const messages = publishedMessages([words("One. "), done("One."), words("Two."), done("Two.")]);
    expect(messages.map((message) => message.completed)).toEqual(["One.", "Two."]);
    expect(messages[0]!.itemId).not.toBe(messages[1]!.itemId);
  });

  it("closes a message a tool interrupts, so the words after it are a message of their own", () => {
    const messages = publishedMessages([words("Half a thought "), ...tool("c1"), words("Then this."), done("Then this.")]);
    expect(messages).toEqual([
      { itemId: expect.any(String), streamed: "Half a thought " },
      { itemId: expect.any(String), streamed: "Then this.", completed: "Then this." },
    ]);
    expect(messages[0]!.itemId).not.toBe(messages[1]!.itemId);
  });

  it("drops whitespace before a message's first word, and keeps it inside one", () => {
    const items = new TextItems();
    expect(items.stamp(words("\n\n"))).toBeNull();
    const first = items.stamp(words("Para one."))!;
    const gap = items.stamp(words("\n\n"))!;
    expect(gap.itemId).toBe(first.itemId);
  });

  it("gives a completion with no streamed words an id too", () => {
    expect(publishedMessages([done("Only at the end.")])).toEqual([{ itemId: expect.any(String), streamed: "", completed: "Only at the end." }]);
  });

  it("keeps an engine's own message ids, scoped to the turn so a reused id is a new message", () => {
    const messages = publishedMessages([
      words("Turn one.", { itemId: "m1" }), done("Turn one.", { itemId: "m1" }),
      words("Turn two.", { itemId: "m1" }, "turn-2"), done("Turn two.", { itemId: "m1" }, "turn-2"),
    ]);
    expect(messages.map((message) => message.itemId)).toEqual(["turn-1:m1", "turn-2:m1"]);
  });

  it("starts a new message when the turn changes, and forgets an open one at the turn's end", () => {
    const items = new TextItems();
    const a = items.stamp(words("Stopped mid "))!;
    items.stamp(event({ type: "turn.completed", ok: false } as Partial<RuntimeEvent>));
    const b = items.stamp(words("Fresh ", {}, "turn-2"))!;
    expect(b.itemId).not.toBe(a.itemId);
    const c = items.stamp(words("in another turn ", {}, "turn-3"))!;
    expect(c.itemId).not.toBe(b.itemId);
  });

  it("stamps an already stamped event the same way again", () => {
    const items = new TextItems();
    const once = items.stamp(words("Hello ", { itemId: "m1" }))!;
    expect(new TextItems().stamp(once)!.itemId).toBe(once.itemId);
    const minted = new TextItems().stamp(words("Hi "))!;
    expect(new TextItems().stamp(minted)!.itemId).toBe(minted.itemId);
  });

  it("keeps threads apart", () => {
    const items = new TextItems();
    const a = items.stamp(words("A "))!;
    const b = items.stamp({ ...words("B "), threadId: "u" })!;
    expect(a.itemId).not.toBe(b.itemId);
    expect(items.stamp(words("more A "))!.itemId).toBe(a.itemId);
  });

  it("leaves reasoning and every other event as it was", () => {
    const items = new TextItems();
    const thinking = event({ type: "content.delta", streamKind: "reasoning_text", delta: "hmm" } as Partial<RuntimeEvent>);
    expect(items.stamp(thinking)).toBe(thinking);
    const usage = event({ type: "thread.token-usage.updated", input: 1, output: 1 } as Partial<RuntimeEvent>);
    expect(items.stamp(usage)).toBe(usage);
  });
});
