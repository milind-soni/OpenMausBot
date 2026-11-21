import { describe, expect, it } from "vitest";

import { grokChatMessages } from "./grok-history.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const at = (seq: number) => 1_754_000_000_000 + seq * 60_000;
const person = (seq: number, content: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "message", seq, id: `t${seq}u`, role: "user", content, richText: `<p>${content}</p>`, isStreaming: false, timestampMs: at(seq), ...extra });
const sent = (seq: number, message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ kind: "send-message", seq, id: `t${seq}s1`, message, timestampMs: at(seq), ...extra });
const shown = (entries: unknown[]) => grokChatMessages(entries).map(({ role, text }) => [role, text]);

describe("a Grok Bot chat as a MausBot conversation", () => {
  it("is one linear thread in Grok Bot's order, with Grok Bot's times, even when entries come shuffled or skip numbers", () => {
    const messages = grokChatMessages([
      sent(7, { type: "text", content: "Booked for Friday." }),
      person(1, "Find me a table for two"),
      sent(4, { type: "text", content: "Which night?" }),
      person(5, "Friday"),
    ]);
    expect(messages).toEqual([
      { id: "grok-1", kind: "text", role: "user", text: "Find me a table for two", at: at(1), parentId: null },
      { id: "grok-4", kind: "text", role: "bot", text: "Which night?", at: at(4), parentId: "grok-1" },
      { id: "grok-5", kind: "text", role: "user", text: "Friday", at: at(5), parentId: "grok-4" },
      { id: "grok-7", kind: "text", role: "bot", text: "Booked for Friday.", at: at(7), parentId: "grok-5" },
    ]);
  });

  it("turns each card into a line that says what it was", () => {
    expect(shown([
      sent(1, { type: "text", content: "Here are the two options.", images: [{ url: "a" }, { url: "b" }] }),
      sent(2, { type: "text", content: "", images: [{ url: "c" }] }),
      sent(3, { type: "widget", widget: { prompt: "Which plan?", options: [{ label: "Basic", value: "basic" }, { label: "Pro", value: "pro" }] } }, { respondedValue: "pro" }),
      sent(4, { type: "widget", widget: { prompt: "Pick days", options: [{ label: "Mon" }, { label: "Tue" }], allowCustom: true } }, { respondedValue: "Wed" }),
      sent(5, { type: "widget", widget: { prompt: "Want a reminder?", options: [{ label: "Yes", value: "y" }] } }, { widgetSkipped: true }),
      sent(6, { type: "bot-template-share", name: "Scout", body: "Finds leads", shareUrl: "https://x.ai/bot/abc123", published: true }),
      sent(7, { type: "connector", connector: "Google-calendar", serverId: "gcal", variant: "connect" }),
      { kind: "event", seq: 8, id: "e8", timestampMs: at(8), event: { type: "automation-changed", action: "created", automationId: "a1", automationName: "Morning brief" } },
    ])).toEqual([
      ["bot", "Here are the two options.\nSent 2 images"],
      ["bot", "Sent 1 image"],
      ["bot", "Which plan?\nChoices: Basic, Pro\nAnswer: Pro"],
      ["bot", "Pick days\nChoices: Mon, Tue\nAnswer: Wed"],
      ["bot", "Want a reminder?\nChoices: Yes\nSkipped"],
      ["bot", "Shared the Bot template \"Scout\": https://x.ai/bot/abc123"],
      ["bot", "Asked to connect Google-calendar"],
      ["bot", "Routine \"Morning brief\" created"],
    ]);
  });

  it("says which Bot wrote to it, or which Bot it wrote to", () => {
    expect(shown([
      person(1, "Can you check the invoice?", { fromAgent: { id: "b2", name: "Luna" } }),
      { kind: "message", seq: 2, id: "t2", role: "assistant", content: "Checked: it's paid.", toAgent: { id: "b2", name: "Luna", kind: "agent" }, timestampMs: at(2) },
    ])).toEqual([["user", "Luna:\nCan you check the invoice?"], ["bot", "To Luna:\nChecked: it's paid."]]);
  });

  it("leaves out what it doesn't know, what has no words, and an entry without its number or time", () => {
    expect(shown([
      person(1, "Kept"),
      { kind: "thinking", seq: 2, timestampMs: at(2), text: "hidden" },
      sent(3, { type: "voice-note", url: "x" }),
      { kind: "message", seq: 4, role: "system", content: "rules", timestampMs: at(4) },
      { kind: "event", seq: 5, timestampMs: at(5), event: { type: "session-started" } },
      person(6, "   "),
      sent(7, { type: "connector" }),
      { ...person(8, "no time"), timestampMs: undefined },
      { ...person(9, "no number"), seq: "9" },
      person(1, "A second copy of seq 1"),
      null, "text", 42,
    ])).toEqual([["user", "Kept"]]);
    expect(grokChatMessages([])).toEqual([]);
  });

  it("takes keys out of every line", () => {
    const text = shown([
      person(1, `My key is ${KEY}`),
      sent(2, { type: "widget", widget: { prompt: `Use ${KEY}?`, options: [{ label: KEY, value: "k" }] } }, { respondedValue: "k" }),
      sent(3, { type: "bot-template-share", name: "Keys", shareUrl: `https://x.ai/bot/a?token=${KEY}` }),
    ]).map(([, line]) => line).join("\n");
    expect(text).not.toContain(KEY);
    expect(text).toContain("My key is");
  });
});
