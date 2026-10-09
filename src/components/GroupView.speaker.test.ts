import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));
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

function markup(messages: Message[]) {
  return renderToStaticMarkup(createElement(Transcript, {
    group: { ...room, messages },
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
    // the person's side stays the skin bubble, with no name label
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
