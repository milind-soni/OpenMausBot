// Goal recitation (Phase 1 part 4): when it fires and what it says.
import { describe, expect, it } from "vitest";

import { progressNote, RECITE_EVERY, shouldRecite, turnIndex } from "./progress.ts";
import type { Message } from "./store.ts";

let n = 0;
const user = (text: string): Message => ({ id: `u${n += 1}`, at: n, role: "user", kind: "text", text });
const bot = (text: string): Message => ({ id: `b${n += 1}`, at: n, role: "bot", kind: "text", text });
const digest = (reply: string): Message => ({ id: `d${n += 1}`, at: n, role: "bot", kind: "digest", digest: { turnId: "t", botId: "b", threadId: "th", at: n, durationMs: 1, tools: [], memory: [], reply, hookCoverage: "none" } } as Message);

const thread = (turns: number): Message[] => {
  const out: Message[] = [];
  for (let i = 1; i <= turns; i += 1) out.push(user(i === 1 ? "For this whole conversation, start every reply with LANTERN. Then: what is 1 + 1?" : `and ${i} + ${i}?`), bot(`LANTERN ${i + i}`), digest(`LANTERN ${i + i}`));
  return out;
};

describe("goal recitation", () => {
  it("counts the person's turns", () => {
    expect(turnIndex(thread(3))).toBe(3);
    expect(turnIndex([])).toBe(0);
  });

  it("fires right after a compaction, and on every tenth turn from the tenth", () => {
    expect(shouldRecite({ messages: thread(2), botName: "Scout", afterCompaction: true })).toBe(true);
    expect(shouldRecite({ messages: thread(2), botName: "Scout", afterCompaction: false })).toBe(false);
    // the turn about to run is the tenth
    expect(shouldRecite({ messages: thread(RECITE_EVERY - 1), botName: "Scout", afterCompaction: false })).toBe(true);
    expect(shouldRecite({ messages: thread(RECITE_EVERY), botName: "Scout", afterCompaction: false })).toBe(false);
    expect(shouldRecite({ messages: thread(2 * RECITE_EVERY - 1), botName: "Scout", afterCompaction: false })).toBe(true);
  });

  it("restates the first request and the last step, clipped, and nothing on an empty thread", () => {
    const note = progressNote({ messages: thread(3), botName: "Scout", afterCompaction: true })!;
    expect(note).toContain("[Where this conversation stands, kept by OpenMausBot:");
    expect(note).toContain('It began with this request: "For this whole conversation, start every reply with LANTERN. Then: what is 1 + 1?"');
    expect(note).toContain("Any standing instruction in it still applies.");
    expect(note).toContain("Last step:");
    expect(note).toContain("LANTERN 6");
    expect(note.trimEnd().endsWith("]")).toBe(true);
    expect(progressNote({ messages: [], botName: "Scout", afterCompaction: true })).toBeNull();
    const long = progressNote({ messages: [user("x".repeat(1_000)), bot("y".repeat(1_000))], botName: "Scout", afterCompaction: true })!;
    expect(long).toContain("x".repeat(300) + "…");
    expect(long).toMatch(/you replied: y+…/);
    expect(long.split("\n").find((line) => line.includes("you replied"))!.length).toBeLessThan(230);
  });
});
