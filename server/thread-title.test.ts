import { describe, expect, it, vi } from "vitest";

import { createJobSlots } from "./job-slots.ts";
import type { Message } from "./store.ts";
import { callTitleExcerpt, threadTitlePrompt, titleConversationExcerpt, titleFromMessage, TITLE_INPUT_MAX_CHARS, UNTITLED_TASK, type ThreadTitleSource } from "./thread-title.ts";
import { AUTO_RETRY_LEAD } from "./incidents.ts";
import { AUTHORITY, botWho, fromNote, fromNoteWith, routineWho } from "./provenance-label.ts";
import { generateThreadTitle, THREAD_TITLE_TIMEOUT_MS } from "./thread-title-generate.ts";

describe("a generated title and the background slots", () => {
  it("answers null after 10 s, but keeps its slot until the engine call has really ended", async () => {
    vi.useFakeTimers();
    try {
      const slots = createJobSlots(1);
      let end!: (text: string) => void;
      let aborted = false;
      const provider = { generateText: (_prompt: string, options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener("abort", () => { aborted = true; });
        return new Promise<string>((resolve) => { end = resolve; });
      } };
      const title = generateThreadTitle(provider, "plan the trip", "first-message", slots);
      await vi.advanceTimersByTimeAsync(THREAD_TITLE_TIMEOUT_MS);
      expect(await title).toBeNull();
      expect(aborted).toBe(true);
      expect(slots.running).toBe(1);
      end("Trip plan");
      await vi.advanceTimersByTimeAsync(0);
      expect(slots.running).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits ahead of background upkeep for a free slot", async () => {
    const slots = createJobSlots(1);
    let free!: () => void;
    const busy = slots.run(() => new Promise<void>((resolve) => { free = resolve; }));
    const order: string[] = [];
    const upkeep = slots.run(async () => { order.push("upkeep"); });
    const title = generateThreadTitle({ generateText: async () => { order.push("title"); return "Trip plan"; } }, "plan the trip", "first-message", slots);
    await vi.waitFor(() => expect(free).toBeTypeOf("function"));
    free();
    await Promise.all([busy, upkeep]);
    expect(await title).toBe("Trip plan");
    expect(order).toEqual(["title", "upkeep"]);
  });
});

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
  it("names from the person's words as typed: the Data context is its own field, and nothing in the text is stripped", () => {
    const sent = message("user", "Compare monthly sales", { dataContext: { cardId: "c_1", draftSql: "SELECT private_draft".repeat(200) } });
    expect(titleConversationExcerpt([sent, message("bot", "Sales increased.")])).toBe("User: Compare monthly sales\nBot: Sales increased.");
    expect(threadTitlePrompt(sent.text!)).toBe(threadTitlePrompt("Compare monthly sales"));
    const typed = '<data-context>{"cardId":"c_1"}</data-context>\nCompare monthly sales';
    expect(threadTitlePrompt(typed)).toContain(typed);
    expect(titleConversationExcerpt([message("user", typed)])).toBe(`User: ${typed.replace("\n", " ")}`);
  });

  it("asks for a short title from the first message, or from the conversation so far", () => {
    expect(threadTitlePrompt("fix the login", "first-message")).toContain("begins with the message below");
    const prompt = threadTitlePrompt(`User: fix the login\n${"x".repeat(5_000)}`, "conversation");
    expect(prompt).toContain("what it is about now");
    expect(prompt).toContain("Conversation:\nUser: fix the login");
    expect(prompt.length).toBeLessThan(TITLE_INPUT_MAX_CHARS + 300);
  });

  it.each<[ThreadTitleSource, string]>([
    ["first-message", "为什么 OpenMausBot 返回 HTTP 403？"],
    ["call", "为什么 OpenMausBot 返回 HTTP 403？"],
    ["conversation", titleConversationExcerpt([
      message("user", "为什么 OpenMausBot 返回 HTTP 403？"),
      message("bot", "权限不足时接口返回 403。"),
    ])],
  ])("asks for the title in the same language as the user's request, from %s", (source, text) => {
    const prompt = threadTitlePrompt(text, source);
    expect(prompt).toContain("为什么 OpenMausBot 返回 HTTP 403？");
    const instruction = prompt.split("\n")[1]!;
    expect(instruction).toContain("same language as the user's request");
    expect(instruction).toContain("at most 48 characters");
    expect(instruction).not.toContain("3 to 6 words");
  });
});

describe("a Live call's title", () => {
  it("asks for it from the call's requests", () => {
    const prompt = threadTitlePrompt("what is the weather in Pune\nand tomorrow?", "call");
    expect(prompt.split("\n").slice(0, 3)).toEqual([
      "Name the voice call below by what was asked on it.",
      "Reply with only a short title in the same language as the user's request. Use a concise phrase of at most 48 characters, in plain text, with no quotes or trailing period.",
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

describe("titleFromMessage", () => {
  it("names a message that starts with pasted text by the pasted text, not its wrapper", () => {
    expect(titleFromMessage('<pasted-text index="1">\n\n  Stack trace from the build\nline two\n</pasted-text>')).toBe("Stack trace from the build");
    expect(titleFromMessage('<pasted-text index="1">\n</pasted-text>\n\n<pasted-text index="2">\nSecond paste\n</pasted-text>')).toBe("Second paste");
    expect(titleFromMessage('<pasted-text index="1">\n\n</pasted-text>')).toBe(UNTITLED_TASK);
    expect(titleFromMessage('<pasted-text index="1">\n\n</pasted-text>\n\n<attached-file path="/tmp/a.txt" name="a.txt" />')).toBe(UNTITLED_TASK);
    expect(titleFromMessage('<pasted-text index="1">\n</pasted-text>\n\n<attached-image path="/tmp/b.png" name="b.png" />\n\n<pasted-text index="3">\nThird\n</pasted-text>')).toBe("Third");
  });

  it("keeps typed text first, and a typed wrapper with no pasted block stays as typed", () => {
    expect(titleFromMessage('Fix this\n\n<pasted-text index="1">\nerror\n</pasted-text>')).toBe("Fix this");
    expect(titleFromMessage('<pasted-text index="1">\nnot closed')).toBe('<pasted-text index="1">');
  });
});

describe("titleFromMessage and OpenMausBot's sender note", () => {
  it("names a delivered line by its words, not by the note that opens it", () => {
    expect(titleFromMessage(`${fromNote(botWho("Sales"), "assignment", AUTHORITY.behalf)}\n\nFind last month's unpaid invoices`)).toBe("Find last month's unpaid invoices");
    expect(titleFromMessage(`${fromNoteWith(routineWho("Daily brief"), "run", AUTHORITY.behalf, "no one is present")}\nSummarise the inbox`)).toBe("Summarise the inbox");
  });

  it("gives no title for a line that is only a note, like the automatic retry", () => {
    expect(titleFromMessage(`${AUTO_RETRY_LEAD}, once, before telling Chief, your Chief of Staff, that this thread's last run failed. Continue the request above from where it stopped and finish it.]`)).toBe(UNTITLED_TASK);
  });

  it("keeps a typed line that only looks like a note", () => {
    expect(titleFromMessage("[From the docs] how do routines repeat?")).toBe("[From the docs] how do routines repeat?");
    expect(titleFromMessage("Plan the offsite\n[From @Sales (bot) · message · information only]")).toBe("Plan the offsite");
  });
});
