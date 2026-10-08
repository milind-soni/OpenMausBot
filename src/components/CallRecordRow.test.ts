import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { CallRecordRow } from "./CallRecordRow";

const at = 1_700_000_000_000;
const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at, ...fields }) as Message;
const row = (call: Partial<NonNullable<Message["call"]>> = {}) => msg("row", {
  kind: "call",
  text: "Call with Pepper · 1:42",
  call: { callId: "c1", botId: "bot", client: "ios", startedAt: at - 102_000, endedAt: at, seconds: 102, endReason: "hung-up", ...call },
});
const transcript: Message[] = [
  msg("m1", { role: "user", text: "what's the weather", via: "call", callId: "c1" }),
  msg("a1", { kind: "activity", requestMessageId: "m1", tool: { name: "WebSearch", spoken: "searching the web", ok: true, input: "weather pune secret-query" } }),
  msg("o1", {
    kind: "options",
    requestMessageId: "m1",
    card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", answered: "allow", answeredBy: { kind: "loopback", via: "call" } },
  }),
  msg("b1", { text: "Sunny.", requestMessageId: "m1" }),
  msg("m2", { role: "user", text: "thanks" }),
  msg("a2", { kind: "activity", requestMessageId: "m2", tool: { name: "Read", spoken: "reading a file", ok: true } }),
];
const draw = (message: Message, messages: Message[] = transcript) =>
  renderToStaticMarkup(createElement(CallRecordRow, { message, transcript: [...messages, message], botName: "Pepper" }));
/** What each line reads as: its markup's text. The glyphs carry none. */
const lineTexts = (markup: string) => [...markup.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map(([, inner]) => inner!.replace(/<[^>]+>/g, ""));

describe("CallRecordRow", () => {
  it("names the call, its length and what the bot did on it", () => {
    const markup = draw(row());
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("Call with Pepper");
    expect(markup).toContain("1:42");
    expect(markup).toContain("Searching the web");
    expect(markup).toContain("Allowed: run a command · by voice");
    // a typed message's work is not the call's
    expect(markup).not.toContain("Reading a file");
    // step names, never their arguments
    expect(markup).not.toContain("secret-query");
    expect(markup).not.toContain("rm -rf build");
  });

  it("shows the call's title when the bot's engine named it", () => {
    const markup = draw(row({ title: "Pune weather check" }));
    expect(markup).toContain("Pune weather check");
    expect(markup).not.toContain("Call with Pepper");
  });

  it("is only a title and a length for a call where nothing was asked", () => {
    const markup = draw(row(), []);
    expect(markup).toContain("Call with Pepper");
    expect(markup).toContain("1:42");
    expect(markup).not.toContain("<li");
  });

  it("tells a screen reader how each step went, which its glyph only shows", () => {
    const work: Message[] = [
      msg("m1", { role: "user", text: "check the build", via: "call", callId: "c1" }),
      msg("a1", { kind: "activity", requestMessageId: "m1", tool: { name: "WebSearch", spoken: "searching the web", ok: true } }),
      msg("a2", { kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running the tests", ok: false } }),
      msg("a3", { kind: "activity", requestMessageId: "m1", tool: { name: "Read", spoken: "reading a file" } }),
      msg("o1", { kind: "options", requestMessageId: "m1", card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", answered: "deny" } }),
    ];
    const markup = draw(row(), work);
    expect(lineTexts(markup)).toEqual([
      "Searching the web (Done)",
      "Running the tests (Failed)",
      "Reading a file (Running)",
      // an approval already says its outcome in words
      "Denied: run a command",
    ]);
    // read out, not drawn: the glyph stays the visible cue
    expect(markup).toContain('<span class="sr-only"> (Failed)</span>');
  });

  it("draws nothing for a row without its record", () => {
    expect(draw(msg("row", { kind: "call", text: "Call with Pepper · 1:42" }), [])).toBe("");
  });
});
