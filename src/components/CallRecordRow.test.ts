import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CallRecordRow } from "./CallRecordRow";

const at = 1_700_000_000_000;
const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at, ...fields }) as Message;
/** A tool the provider ran: the only kind of chip a record lists as a step. */
const step = (id: string, request: string, tool: NonNullable<Message["tool"]>) =>
  msg(id, { kind: "activity", requestMessageId: request, tool: { ...tool, itemId: `item-${id}` } });
const row = (call: Partial<NonNullable<Message["call"]>> = {}) => msg("row", {
  kind: "call",
  text: "Call with Pepper · 1:42",
  call: { callId: "c1", botId: "bot", client: "ios", startedAt: at - 102_000, endedAt: at, seconds: 102, endReason: "hung-up", ...call },
});
const transcript: Message[] = [
  msg("m1", { role: "user", text: "what's the weather", via: "call", callId: "c1" }),
  step("a1", "m1", { name: "WebSearch", spoken: "searching the web", ok: true, input: "weather pune secret-query" }),
  msg("o1", {
    kind: "options",
    requestMessageId: "m1",
    card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", answered: "allow", answeredBy: { kind: "loopback", via: "call" } },
  }),
  msg("b1", { text: "Sunny.", requestMessageId: "m1" }),
  msg("m2", { role: "user", text: "thanks" }),
  step("a2", "m2", { name: "Read", spoken: "reading a file", ok: true }),
];
const draw = (message: Message, messages: Message[] = transcript, { busy = false, hasMore = false } = {}) =>
  renderToStaticMarkup(createElement(CallRecordRow, { message, transcript: [...messages, message], botName: "Pepper", busy, hasMore }));
/** What each line reads as: its markup's text. The glyphs carry none. */
const lineTexts = (markup: string) => [...markup.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map(([, inner]) => inner!.replace(/<[^>]+>/g, ""));

afterEach(() => {
  setLocale("en");
});

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
      step("a1", "m1", { name: "WebSearch", spoken: "searching the web", ok: true }),
      step("a2", "m1", { name: "Bash", spoken: "running the tests", ok: false }),
      step("a3", "m1", { name: "Read", spoken: "reading a file" }),
      msg("o1", { kind: "options", requestMessageId: "m1", card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", answered: "deny" } }),
    ];
    const markup = draw(row(), work, { busy: true });
    expect(lineTexts(markup)).toEqual([
      "Searching the web (Completed)",
      "Running the tests (Failed)",
      "Reading a file (Running)",
      // an approval already says its outcome in words
      "Denied: run a command",
    ]);
    // read out, not drawn: the glyph stays the visible cue
    expect(markup).toContain('<span class="sr-only"> (Failed)</span>');
  });

  it("says how a step went in the app's language, the words the tool chip uses", () => {
    const work: Message[] = [
      msg("m1", { role: "user", text: "check the build", via: "call", callId: "c1" }),
      step("a1", "m1", { name: "WebSearch", spoken: "searching the web", ok: true }),
      step("a2", "m1", { name: "Bash", spoken: "running the tests", ok: false }),
      step("a3", "m1", { name: "Read", spoken: "reading a file" }),
    ];
    setLocale("zh");
    expect(lineTexts(draw(row(), work, { busy: true }))).toEqual([
      "Searching the web (已完成)",
      "Running the tests (失败)",
      "Reading a file (运行中)",
    ]);
  });

  it("is a labelled group rather than a landmark, with its lines kept inside the pill", () => {
    const markup = draw(row());
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Live call: Call with Pepper, 1:42"');
    expect(markup).not.toContain("<section");
    // a line wider than the pill truncates instead of spilling past its border
    expect(markup).toMatch(/<ul class="[^"]*\bmax-w-full\b/);
  });

  it("says only that an approval expired, not what to do about it", () => {
    const work: Message[] = [
      msg("m1", { role: "user", text: "clean the build", via: "call", callId: "c1" }),
      msg("o1", { kind: "options", requestMessageId: "m1", card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", expired: true } }),
    ];
    expect(lineTexts(draw(row(), work))).toEqual(["Expired: run a command"]);
  });

  describe("a call that began before the messages loaded so far", () => {
    // the transcript's oldest message is `at`, the call began 102 s before it
    const hint = "Some of this call may be in earlier messages";

    it("says its lines may be incomplete, and how to see them, when older messages remain", () => {
      const markup = draw(row(), transcript, { hasMore: true });
      expect(markup).toContain(hint);
      expect(markup).toContain("Load earlier messages");
      // the lines it does have are still drawn
      expect(markup).toContain("Searching the web");
    });

    it("says nothing once everything is loaded", () => {
      expect(draw(row(), transcript, { hasMore: false })).not.toContain(hint);
    });

    it("says nothing when the loaded messages reach back to before the call, though older ones remain", () => {
      const reachingBack = [msg("m0", { role: "user", text: "typed long before", at: at - 200_000 }), ...transcript];
      expect(draw(row(), reachingBack, { hasMore: true })).not.toContain(hint);
    });
  });

  describe("a step that never reported how it went", () => {
    // a turn that was stopped, killed or lost leaves its running step like this
    const work: Message[] = [
      msg("m1", { role: "user", text: "read the log", via: "call", callId: "c1" }),
      step("a1", "m1", { name: "Read", spoken: "reading a file" }),
    ];

    it("reads as running, with the working dots, while its chat is busy", () => {
      const markup = draw(row(), work, { busy: true });
      expect(lineTexts(markup)).toEqual(["Reading a file (Running)"]);
      expect(markup).toContain("animate-status-pulse");
    });

    it("is neutral once its chat is not: no dots and no announcement of running, a dash instead", () => {
      const markup = draw(row(), work, { busy: false });
      expect(lineTexts(markup)).toEqual(["Reading a file"]);
      expect(markup).not.toContain("animate-status-pulse");
      expect(markup).not.toContain("Running");
      expect(markup).toContain("lucide-minus");
    });

    it("leaves a step that did report alone, busy or not", () => {
      const settled: Message[] = [
        msg("m1", { role: "user", text: "check the build", via: "call", callId: "c1" }),
        step("a1", "m1", { name: "WebSearch", spoken: "searching the web", ok: true }),
        step("a2", "m1", { name: "Bash", spoken: "running the tests", ok: false }),
      ];
      for (const busy of [true, false]) {
        expect(lineTexts(draw(row(), settled, { busy }))).toEqual(["Searching the web (Completed)", "Running the tests (Failed)"]);
      }
    });
  });

  it("draws nothing for a row without its record", () => {
    expect(draw(msg("row", { kind: "call", text: "Call with Pepper · 1:42" }), [])).toBe("");
  });
});
