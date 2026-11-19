import { describe, expect, it, vi } from "vitest";

import type { Message } from "../store.ts";
import { messagePages, pageMessage, TOOL_OUTPUT_PREVIEW } from "./message-pages.ts";

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

it("paginates chat rows across ordinary tool calls and keeps coordination", () => {
  const rows = [step("", { id: "a", kind: "text" }), step(""), step("", { id: "b", roomRequest: { id: "q", phase: "result" } })];
  const pages = messagePages({ activePath: vi.fn(), activePathIndex: () => ({
    messages: rows, positions: new Map(rows.map((row, index) => [row.id, index])), leafId: "b",
  }), activeLeaf: () => "b", messagesFor: vi.fn(), messagesBefore: vi.fn(), messagesTail: vi.fn() });
  expect(pages.messagePage("t", 1, true)).toMatchObject({ messages: [{ id: "b" }], hasMore: true });
  expect(pages.messagePageBefore("t", "b", 1, true)).toMatchObject({ messages: [{ id: "a" }], hasMore: false });
});

it("returns just the latest text preview for a metadata list", () => {
  const text = step("", { id: "said", kind: "text", text: "Saved", parentId: null });
  const tool = step("output", { parentId: text.id });
  const pages = messagePages({ activePath: vi.fn(), activePathIndex: vi.fn(), activeLeaf: vi.fn(), messagesFor: vi.fn(), messagesBefore: vi.fn(),
    messagesTail: () => ({ messages: [text, tool], activeLeafId: tool.id, hasMore: false }) });
  expect(pages.messagePage("t", 0, false, true)).toEqual({ messages: [], previewText: "Saved", activeLeafId: tool.id });
});

it("stops scanning a long active branch after finding a page and one more visible row", () => {
  const read = vi.fn();
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    ...step("", { id: String(i), kind: i % 2 === 0 ? "text" : "activity" }),
    get kind(): Message["kind"] {
      read(i);
      return i % 2 === 0 ? "text" : "activity";
    },
  }));
  const pages = messagePages({
    activePath: vi.fn(), activeLeaf: vi.fn(), messagesFor: vi.fn(), messagesBefore: vi.fn(), messagesTail: vi.fn(),
    activePathIndex: () => ({ messages: rows, positions: new Map([["8000", 8000]]), leafId: "9999" }),
  });
  expect(pages.messagePageBefore("t", "8000", 2, true)).toMatchObject({
    messages: [{ id: "7996" }, { id: "7998" }], hasMore: true, activeLeafId: "9999",
  });
  expect(read.mock.calls.every(([index]) => index >= 7994 && index < 8000)).toBe(true);
});

it("keeps terminal failures while filtering ordinary tool calls", () => {
  const failure = step("", { id: "failure", tool: { name: "error: Sign in again", ok: false } });
  const rows = [failure, step("")];
  const pages = messagePages({
    activePath: vi.fn(), activeLeaf: vi.fn(), messagesFor: vi.fn(), messagesBefore: vi.fn(), messagesTail: vi.fn(),
    activePathIndex: () => ({ messages: rows, positions: new Map(), leafId: "m1" }),
  });
  expect(pages.messagePage("t", 1, true)).toMatchObject({ messages: [failure], hasMore: false });
});
