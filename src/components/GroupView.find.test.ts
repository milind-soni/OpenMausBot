// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [] as Bot[] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");
const { requestChatFind } = await import("@/lib/chat-find");

const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: [], defaultResponder: { kind: "mentions" },
  bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // The room's own loaders fetch from the app; this test needs none of them.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a room's find bar", () => {
  it("opens and closes for a request naming the room's thread, from a menu outside the room", () => {
    flushSync(() => root.render(createElement(GroupView, { group: room })));
    const bar = () => host.querySelector('input[aria-label="Find in this conversation"]');
    expect(bar()).toBeNull();
    flushSync(() => requestChatFind("another-thread"));
    expect(bar()).toBeNull();
    flushSync(() => requestChatFind("room-thread"));
    expect(bar()).not.toBeNull();
    flushSync(() => requestChatFind("room-thread"));
    expect(bar()).toBeNull();
  });
});
