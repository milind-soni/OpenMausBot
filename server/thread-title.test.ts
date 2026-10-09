import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { callTitleExcerpt, threadTitlePrompt, titleConversationExcerpt, TITLE_INPUT_MAX_CHARS } from "./thread-title.ts";

let next = 0;
const message = (role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++next}`, role, kind: "text", text, at: next, ...extra,
});

describe("titleConversationExcerpt", () => {
  it("keeps user and bot text lines in order and leaves tool output, cards and asides out", () => {
    const excerpt = titleConversationExcerpt([
      message("user", "every login hangs after the session expires"),
      message("bot", "Running the auth tests", { kind: "activity", tool: { name: "Bash", input: "pnpm test auth", output: "12 passed" } }),
      message("bot", "Approve?", { kind: "options" }),
      message("user", "a peer note", { aside: true }),
      message("user", "still waiting", { queued: true }),
      message("bot", "The refresh token outlives the session cookie.\n\nI moved the refresh earlier."),
    ]);
    expect(excerpt).toBe([
      "User: every login hangs after the session expires",
      "Bot: The refresh token outlives the session cookie. I moved the refresh earlier.",
    ].join("\n"));
    expect(excerpt).not.toContain("pnpm test");
    expect(excerpt).not.toContain("12 passed");
  });

  it("prefers the newest lines and stays under the input cap", () => {
    const long = (n: number) => `${n} ${"word ".repeat(200)}`;
    const messages = Array.from({ length: 30 }, (_, index) => message(index % 2 ? "bot" : "user", long(index)));
    const excerpt = titleConversationExcerpt(messages);
    const lines = excerpt.split("\n");
    expect(excerpt.length).toBeLessThanOrEqual(TITLE_INPUT_MAX_CHARS);
    // each line is clipped, and the last line is the newest message
    expect(lines.every((line) => line.length <= 306)).toBe(true);
    expect(lines.at(-1)).toMatch(/^Bot: 29 /);
    expect(excerpt).not.toContain("User: 0 ");
  });

  it("drops attachment markup and secrets before the text leaves the machine", () => {
    const excerpt = titleConversationExcerpt([
      message("user", 'here is the log <attached-image path="/tmp/a.png" name="a.png" /> and my key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'),
    ]);
    expect(excerpt).toMatch(/^User: here is the log and my key /);
    expect(excerpt).not.toContain("attached-image");
    expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("is empty when there is nothing to name the thread from", () => {
    expect(titleConversationExcerpt([])).toBe("");
    expect(titleConversationExcerpt([message("bot", "   "), message("bot", "frame", { kind: "screen" })])).toBe("");
  });
});

describe("threadTitlePrompt", () => {
  it("asks for a short title from the first message, or from the conversation so far", () => {
    expect(threadTitlePrompt("fix the login", "first-message")).toContain("begins with the message below");
    const prompt = threadTitlePrompt(`User: fix the login\n${"x".repeat(5_000)}`, "conversation");
    expect(prompt).toContain("what it is about now");
    expect(prompt).toContain("Conversation:\nUser: fix the login");
    expect(prompt.length).toBeLessThan(TITLE_INPUT_MAX_CHARS + 300);
  });
});

describe("a Live call's title", () => {
  it("asks for it from the call's requests", () => {
    const prompt = threadTitlePrompt("what is the weather in Pune\nand tomorrow?", "call");
    expect(prompt.split("\n").slice(0, 3)).toEqual([
      "Name the voice call below by what was asked on it.",
      "Reply with only a short title: 3 to 6 words, plain text, no quotes, no trailing period.",
      "Requests:",
    ]);
    expect(prompt.endsWith("Requests:\nwhat is the weather in Pune\nand tomorrow?")).toBe(true);
  });

  it("takes only this call's spoken requests, oldest first", () => {
    const excerpt = callTitleExcerpt([
      message("user", "words from an earlier call", { via: "call", callId: "call-0" }),
      message("user", "what is the weather in Pune", { via: "call", callId: "call-1" }),
      message("bot", "Sunny, 31 degrees.", { requestMessageId: "m1" }),
      message("user", "typed during the call"),
      message("user", "and tomorrow?", { via: "call", callId: "call-1" }),
    ], "call-1");
    expect(excerpt).toBe("what is the weather in Pune\nand tomorrow?");
  });

  it("scrubs secrets and attachment markup, and stays under the input cap", () => {
    const key = "sk-ant-" + "d".repeat(90);
    const long = (n: number) => `${n} ${"word ".repeat(200)}`;
    const excerpt = callTitleExcerpt([
      message("user", `use ${key} <attached-image path="/tmp/a.png" />`, { via: "call", callId: "c" }),
      ...Array.from({ length: 10 }, (_, i) => message("user", long(i), { via: "call", callId: "c" })),
    ], "c");
    expect(excerpt.startsWith("use ")).toBe(true);
    expect(excerpt).not.toContain(key);
    expect(excerpt).not.toContain("attached-image");
    expect(excerpt.length).toBeLessThanOrEqual(TITLE_INPUT_MAX_CHARS);
  });

  it("is empty when nothing was asked on the call", () => {
    expect(callTitleExcerpt([message("user", "typed")], "c")).toBe("");
  });
});
