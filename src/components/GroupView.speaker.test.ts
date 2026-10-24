import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, focusMessage: { threadId: "room-thread", messageId: "run-a", nonce: 1, consumed: false } }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/feature-flags", () => ({ showToolCallsEnabled: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Transcript } = await import("./GroupView");

const ada = { id: "ada", name: "Ada", color: "blue" } as Bot;
const kai = { id: "kai", name: "Kai", color: "orange" } as Bot;
const room = {
  id: "room", threadId: "room-thread", name: "Planning", memberIds: ["ada", "kai"],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [],
} as Group;

const at = 1_700_000_000_000;
const line = (id: string, role: "user" | "bot", body: string, from?: { botId: string; name: string; color: "blue" | "orange" }): Message => ({
  id, role, kind: "text", at, text: body, ...(from ? { from } : {}),
});

function markup(messages: Message[], context: Partial<Group> = {}) {
  return renderToStaticMarkup(createElement(Transcript, {
    group: { ...room, ...context, messages },
    members: [ada, kai],
    locale: "en",
    messages,
    transcript: messages,
    onReply: () => {},
  }));
}

beforeEach(() => {
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("room speaker names", () => {
  it("colors each bot's name and leaves the person's bubble neutral", () => {
    const html = markup([
      line("u1", "user", "please take a look"),
      line("a", "bot", "on it", { botId: "ada", name: "Ada", color: "blue" }),
      line("a2", "bot", "still me", { botId: "ada", name: "Ada", color: "blue" }),
      line("u2", "user", "and the other one"),
      line("k", "bot", "here", { botId: "kai", name: "Kai", color: "orange" }),
    ]);
    expect(html.match(/data-bot-color="blue"/g)).toHaveLength(1);
    expect(html.match(/data-bot-color="orange"/g)).toHaveLength(1);
    expect(html).toContain('class="text-[11px] font-medium bot-identity" data-bot-color="blue"');
    expect(html).toContain(">Ada<");
    expect(html).toContain(">Kai<");
    expect(html).toContain("var(--identity-blue)");
    expect(html).toContain("var(--identity-orange)");
    expect(html).not.toContain('data-bot-color="blue">still me');
    expect(html).toContain("bg-bubble-user");
    expect(html).not.toContain("user-bubble-colored");
    const userBubble = html.indexOf("please take a look");
    const adaName = html.indexOf('data-bot-color="blue"');
    expect(userBubble).toBeLessThan(adaName);
  });

  it("names the reply after the person even when a digest is in between", () => {
    const digest: Message = { id: "d", role: "bot", kind: "digest", at, text: "notes", from: { botId: "ada", name: "Ada", color: "blue" } };
    const html = markup([
      line("u", "user", "go ahead"),
      digest,
      line("a", "bot", "the notes are in", { botId: "ada", name: "Ada", color: "blue" }),
    ]);
    expect(html).toContain('data-bot-color="blue"');
    expect(html).toContain("the notes are in");
  });
});


describe("room tool liveness", () => {
  const step = (id: string, at: number, patch: Partial<Message> = {}): Message => ({
    id, role: "bot", kind: "activity", at,
    tool: { name: "Read", input: "raw input" }, ...patch,
  });
  const active: Partial<Group> = {
    working: true, busyBotId: "ada", turnStartedAt: 100,
    tasks: [{ threadId: room.threadId, title: "Selected", createdAt: 1, working: true, busyBotId: "ada" }],
  };

  it("keeps historical missing receipts static while a selected-thread tool runs", () => {
    const html = markup([step("historical", 50), step("live", 101)], active);
    const historical = html.slice(html.indexOf('data-mid="historical"'), html.indexOf('data-mid="live"'));
    const live = html.slice(html.indexOf('data-mid="live"'));
    expect(historical).toContain("Result/status unrecorded and unverified.");
    expect(historical).toContain("No terminal result was recorded.");
    expect(historical).not.toContain("Waiting for the tool to finish");
    expect(historical).not.toContain("animate-status-pulse");
    expect(live).toContain("Read · Running · Tool details");
    expect(live).toContain("Waiting for the tool to finish");
    expect(live).toContain("animate-status-pulse");
    expect(historical).toContain("raw input");
    expect(live).toContain("raw input");
  });

  it("does not borrow another thread's working state or an absent turn boundary", () => {
    const messages = [step("pending", 101)];
    const inactive = markup(messages, { ...active, tasks: [
      { threadId: room.threadId, title: "Selected", createdAt: 1, working: false, busyBotId: null },
      { threadId: "elsewhere", title: "Other", createdAt: 1, working: true, busyBotId: "ada" },
    ] });
    expect(inactive).toContain("Result/status unrecorded and unverified.");
    expect(inactive).not.toContain("Waiting for the tool to finish");
    for (const context of [{ ...active, turnStartedAt: undefined }, { working: false, turnStartedAt: 100 }]) {
      expect(markup(messages, context)).not.toContain("Waiting for the tool to finish");
    }
  });

  it("respects terminal turn evidence and keeps completed activity runs completed", () => {
    const messages = [
      step("run-a", 101, { tool: { name: "Read", ok: true, output: "first receipt" } }),
      step("run-b", 102, { tool: { name: "Read", ok: true, output: "second receipt" } }),
      step("ended", 103, { turnId: "ended-turn" }),
      { id: "terminal", role: "bot", kind: "text", at: 104, text: "Finished", turnId: "ended-turn", turnTerminal: true } as Message,
    ];
    const html = markup(messages, active);
    expect(html).toContain('data-mid="run-a"');
    expect(html).toContain('data-mid="run-b"');
    expect(html.match(/Read · Completed · Tool details/g)).toHaveLength(2);
    expect(html).toContain("first receipt");
    expect(html).toContain("second receipt");
    expect(html).toContain("Result/status unrecorded and unverified.");
    expect(html).not.toContain("Waiting for the tool to finish");
  });
});
