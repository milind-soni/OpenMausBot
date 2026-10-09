import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { threadTitlePrompt, titleConversationExcerpt, TITLE_INPUT_MAX_CHARS } from "./thread-title.ts";
import { withDataContext } from "../shared/data-context.ts";

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
  it("uses the person's words rather than hidden SQL context for initial and regenerated titles", () => {
    const recipient = { botId: "bot-1", threadId: "thread-1" };
    const sent = withDataContext("Compare monthly sales", { ...recipient, cardId: "c_1", draftSql: "SELECT private_draft".repeat(200) }, recipient);
    expect(threadTitlePrompt(sent)).toBe(threadTitlePrompt("Compare monthly sales"));
    expect(titleConversationExcerpt([message("user", sent), message("bot", "Sales increased.")])).toBe("User: Compare monthly sales\nBot: Sales increased.");
    expect(sent).toContain("SELECT private_draft");
    const example = `\`\`\`xml\n${sent}\n\`\`\``;
    expect(threadTitlePrompt(example)).toContain("<data-context>");
  });

  it("asks for a short title from the first message, or from the conversation so far", () => {
    expect(threadTitlePrompt("fix the login", "first-message")).toContain("begins with the message below");
    const prompt = threadTitlePrompt(`User: fix the login\n${"x".repeat(5_000)}`, "conversation");
    expect(prompt).toContain("what it is about now");
    expect(prompt).toContain("Conversation:\nUser: fix the login");
    expect(prompt.length).toBeLessThan(TITLE_INPUT_MAX_CHARS + 300);
  });
});
