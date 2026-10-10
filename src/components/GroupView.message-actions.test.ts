// @vitest-environment happy-dom
// A room message uses the same tray, copy control, and error boundary as a
// 1:1 bubble. One throwing card or markdown node stays in that row.
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [] as Bot[] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Transcript } = await import("./GroupView");
const { MessageBoundary } = await import("./ChatView");

const lead = { id: "lead", name: "Lead", color: "blue", voice: "verse" } as Bot;
const room = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["lead"],
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "", unread: false,
  createdAt: 1, messages: [] as Message[],
} as Group;

const text = (id: string, role: "user" | "bot", body: string): Message => ({
  id, role, kind: "text", at: 1, text: body,
  ...(role === "bot" ? { from: { botId: "lead", name: "Lead", color: "blue" as const } } : {}),
});

const markup = (messages: Message[]) => {
  const group = { ...room, messages };
  return renderToStaticMarkup(createElement(Transcript, {
    group, members: [lead], locale: "en", messages, transcript: messages, onReply: () => {},
  }));
};

function Boom(): ReactNode {
  throw new Error("markdown failed");
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.dispatch.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("room message actions", () => {
  it("gives a bot reply the same tray as a 1:1 answer", () => {
    const html = markup([text("a", "bot", "The build is green")]);
    expect(html).toContain('data-testid="message-actions"');
    expect(html).toContain("Copy message");
    expect(html).toContain("Reply to message");
    expect(html).toContain('aria-haspopup="menu"');
    // the rest waits in the more menu, as in a 1:1 chat
    expect(html).not.toContain("Show raw markdown");
    expect(html).not.toContain("Pin message");
  });

  it("puts read aloud, raw markdown and pin in a room reply's more menu", () => {
    vi.unstubAllGlobals();
    const messages = [text("a", "bot", "The build is green")];
    flushSync(() => root.render(createElement(Transcript, {
      group: { ...room, messages }, members: [lead], locale: "en", messages, transcript: messages, onReply: () => {},
    })));
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    const items = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    expect(items.map((item) => item.textContent)).toEqual(expect.arrayContaining(["Read this aloud", "Show raw markdown", "Pin message", "Copy message ID"]));
    const speak = items.find((item) => item.textContent === "Read this aloud");
    expect(speak?.title).toBe("Add an ElevenLabs key in an agent profile to read messages aloud");
    expect(speak?.disabled).toBe(true);
  });

  it("copies a person's message and folds a long one", () => {
    const html = markup([text("u", "user", "word ".repeat(200))]);
    expect(html).toContain("Copy message");
    expect(html).toContain("Show full message");
    expect(html).not.toContain("Show raw markdown");
  });

  it("keeps delivered files beneath the reply alongside its quiet actions", () => {
    const reply: Message = {
      ...text("a", "bot", "See [notes.md](/work/notes.md). The report is attached."),
      attachments: [
        { kind: "file", path: "/store/notes.md", name: "notes.md", mime: "text/markdown" },
        { kind: "file", path: "/store/report.pdf", name: "report.pdf", mime: "application/pdf" },
      ],
    };
    const html = markup([reply]);
    // The inline delivery stays inline, and the other file keeps main's
    // compact beneath-reply gallery rather than a duplicate attachment card.
    expect(html.match(/title="Save a copy"/g)).toHaveLength(1);
    expect(html).toContain(">notes.md<");
    expect(html).not.toContain('aria-label="Save a copy of notes.md"');
    expect(html.match(/aria-label="Save a copy of report\.pdf"/g)).toHaveLength(1);
    expect(html).toMatch(/<section[^>]*class="mt-2\.5 /);
    expect(html).toContain('data-testid="message-actions"');
    expect(html).toContain("Reply to message");
    expect(html).toContain('aria-haspopup="menu"');
  });
});

describe("room message boundary", () => {
  it("keeps the rest of the transcript when one row throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    flushSync(() => root.render(createElement("div", null,
      createElement(MessageBoundary, { fallbackText: "plain words", children: createElement(Boom) }),
      createElement("p", null, "still here"),
    )));
    expect(host.textContent).toContain("plain words");
    expect(host.textContent).toContain("still here");
  });
});
