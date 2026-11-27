import { describe, expect, it } from "vitest";
import type { Bot, Message } from "@/state/store";
import { isStartFreshShortcut, startFreshRefusal } from "./start-fresh";

const chord = (init: Partial<Parameters<typeof isStartFreshShortcut>[0]> = {}) => ({
  key: "K", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  defaultPrevented: false, isComposing: false, ...init,
});

const message: Message = { id: "m1", role: "bot", kind: "text", text: "Hello", at: 1 };
const fresh: Message = {
  id: "m2", role: "bot", kind: "compaction", at: 2, parentId: "m1",
  compaction: { summary: "", firstKeptId: "", foldedThroughId: "m1", tokensBefore: 0, by: "person", fresh: true },
};
const bot = (messages: Message[], activeLeafId: string | null = messages.at(-1)?.id ?? null, busy = false): Pick<Bot, "busy" | "messages" | "activeLeafId"> => ({ busy, messages, activeLeafId });

describe("isStartFreshShortcut", () => {
  it("matches ⌘⇧K and Ctrl+Shift+K", () => {
    expect(isStartFreshShortcut(chord({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isStartFreshShortcut(chord({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isStartFreshShortcut(chord({ key: "k", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves plain K, ⌘K and other modifiers alone", () => {
    expect(isStartFreshShortcut(chord())).toBe(false);
    expect(isStartFreshShortcut(chord({ metaKey: true }))).toBe(false);
    expect(isStartFreshShortcut(chord({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isStartFreshShortcut(chord({ metaKey: true, shiftKey: true, defaultPrevented: true }))).toBe(false);
    expect(isStartFreshShortcut(chord({ metaKey: true, shiftKey: true, isComposing: true }))).toBe(false);
  });
});

describe("startFreshRefusal", () => {
  it("refuses a busy bot, an empty chat and a chat already at a fresh start", () => {
    expect(startFreshRefusal(bot([message], "m1", true))).toBe("busy");
    expect(startFreshRefusal(bot([]))).toBe("empty");
    expect(startFreshRefusal(bot([message, fresh]))).toBe("fresh");
  });

  it("allows a chat with messages whose last one is not a fresh start", () => {
    expect(startFreshRefusal(bot([message]))).toBeNull();
    expect(startFreshRefusal(bot([message, fresh], "m1"))).toBeNull();
  });
});
