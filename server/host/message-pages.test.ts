import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { fitSnapshotPages, pageMessage, SNAPSHOT_MESSAGE_BYTES, TOOL_OUTPUT_PREVIEW } from "./message-pages.ts";

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

describe("fitSnapshotPages", () => {
  const owner = (name: string, count: number, size: number, hasMore = false) => ({
    name, hasMore,
    messages: Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}`, text: "x".repeat(size) })),
  });
  const bytes = (owners: Array<{ messages: unknown[] }>) =>
    owners.flatMap((one) => one.messages).reduce<number>((sum, message) => sum + JSON.stringify(message).length, 0);

  it("returns a snapshot that fits untouched", () => {
    const owners = [owner("a", 3, 10), owner("b", 2, 10)];
    expect(fitSnapshotPages(owners, 1_000)).toBe(owners);
  });

  it("drops only the oldest messages of an over-budget page and says there is more", () => {
    const [fitted] = fitSnapshotPages([owner("a", 10, 100)], 450);
    expect(fitted!.messages.map((message) => message.id)).toEqual(["a-7", "a-8", "a-9"]);
    expect(fitted!.hasMore).toBe(true);
  });

  it("gives what a short conversation leaves to the long ones", () => {
    const fitted = fitSnapshotPages([owner("long", 100, 100), owner("short", 1, 100), owner("other", 100, 100)], 3_000);
    expect(fitted[1]!.messages).toHaveLength(1);
    expect(fitted[1]!.hasMore).toBe(false);
    expect(fitted[0]!.messages.length).toBe(fitted[2]!.messages.length);
    expect(bytes(fitted)).toBeLessThanOrEqual(3_000);
    expect(bytes(fitted)).toBeGreaterThan(2_500);
  });

  it("keeps each conversation's newest message so older ones can still be asked for", () => {
    const fitted = fitSnapshotPages([owner("a", 5, 1_000), owner("b", 5, 1_000)], 10);
    expect(fitted.map((one) => one.messages.map((message) => message.id))).toEqual([["a-4"], ["b-4"]]);
    expect(fitted.every((one) => one.hasMore)).toBe(true);
  });

  it("leaves hasMore alone on a page it did not cut", () => {
    const fitted = fitSnapshotPages([owner("kept", 1, 10, true), owner("cut", 50, 100)], 1_000);
    expect(fitted[0]).toMatchObject({ hasMore: true });
    expect(fitted[0]!.messages).toHaveLength(1);
  });

  it("brings the reported 52 MiB, 25-bot snapshot under the proxy's 32 MiB", () => {
    const owners = Array.from({ length: 25 }, (_, index) => owner(`bot${index}`, 200, 11_000));
    expect(bytes(owners)).toBeGreaterThan(50 * 1024 * 1024);
    const fitted = fitSnapshotPages(owners);
    expect(bytes(fitted)).toBeLessThanOrEqual(SNAPSHOT_MESSAGE_BYTES);
    expect(SNAPSHOT_MESSAGE_BYTES).toBeLessThan(32 * 1024 * 1024);
    expect(fitted.every((one) => one.messages.length >= 80 && one.hasMore)).toBe(true);
  });
});
