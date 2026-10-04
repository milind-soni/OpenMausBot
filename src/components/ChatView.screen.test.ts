// A screenshot in a 1:1 chat loads from the image route, never from inline
// pixels: live frames carry none, and neither does the paged transcript the
// desktop hydrates from after a reload.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { initialState, reducer } = await import("@/state/store");
afterAll(() => vi.unstubAllGlobals());

const IMAGE = 'src="/api/threads/t1/messages/shot/image"';
const greeting: Message = { id: "hi", role: "bot", kind: "text", text: "Hello", at: 1 };
const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
});
const render = (b: Bot) => renderToStaticMarkup(createElement(ChatView, { bot: b }));

describe("ChatView screenshot", () => {
  it("loads a screenshot from a paged transcript through the image route", () => {
    const markup = render(bot([greeting,
      { id: "shot", role: "bot", kind: "screen", hasImage: true, mime: "image/png", at: 2, parentId: "hi" } as Message]));
    expect(markup).toContain(IMAGE);
  });

  it("loads a live screenshot frame through the image route", () => {
    const state: AppState = { ...initialState, bots: [bot([greeting])] };
    const next = reducer(state, { type: "messageAdded", threadId: "t1",
      message: { id: "shot", role: "bot", kind: "screen", hasImage: true, mime: "image/jpeg", at: 2, parentId: "hi" } as Message });
    const markup = render(next.bots[0]);
    expect(markup).toContain(IMAGE);
    expect(markup).not.toContain("data:image");
  });

  it("loads inline pixels through the image route too, so there is one way to show a screenshot", () => {
    const markup = render(bot([greeting,
      { id: "shot", role: "bot", kind: "screen", png: "PRIVATE_BASE64_PIXELS", mime: "image/png", at: 2, parentId: "hi" } as Message]));
    expect(markup).toContain(IMAGE);
    expect(markup).not.toContain("PRIVATE_BASE64_PIXELS");
  });

  it("shows nothing for a screen message that has no image", () => {
    const markup = render(bot([greeting, { id: "shot", role: "bot", kind: "screen", at: 2, parentId: "hi" } as Message]));
    expect(markup).not.toContain("/messages/shot/image");
  });
});
