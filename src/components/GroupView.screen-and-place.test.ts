import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { state: null as Partial<AppState> | null, dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }),
    useStreaming: () => ({ streaming: {} }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");

afterEach(() => {
  fixture.state = null;
  vi.clearAllMocks();
});

const bot = (patch: Partial<Bot> = {}): Bot => ({
  id: "aleta", threadId: "t-aleta", name: "Aleta", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  ...patch,
});

const group = (patch: Partial<Group> = {}): Group => ({
  id: "room", threadId: "room-thread", name: "Job search", memberIds: ["aleta"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1,
  messages: [],
  ...patch,
});

const render = (members: Bot[], g: Group) => {
  fixture.state = { bots: members };
  return renderToStaticMarkup(createElement(GroupView, { group: g }));
};

describe("GroupView: computer/browser session visibility", () => {
  it("renders a live screenshot message inline, matching the 1:1 ChatView", () => {
    const markup = render([bot()], group({
      messages: [{ id: "shot", role: "bot", kind: "screen", png: "PRIVATE_BASE64_PIXELS", mime: "image/png", at: 1, from: { botId: "aleta", name: "Aleta", color: "green" } }] as Message[],
    }));
    expect(markup).toContain("data:image/png;base64,PRIVATE_BASE64_PIXELS");
  });

  it("drops a screen message with no image, same as ChatView", () => {
    const markup = render([bot()], group({
      messages: [{ id: "shot", role: "bot", kind: "screen", at: 1, from: { botId: "aleta", name: "Aleta", color: "green" } }] as Message[],
    }));
    expect(markup).not.toContain("data:image");
  });

  it("marks a busy member working a concrete place (e.g. browser) with that place's icon", () => {
    const markup = render([bot({ busy: true, computer: "browser" })], group({ busyBotId: "aleta" }));
    expect(markup).toMatch(/width="9"[^>]*height="9"/);
  });

  it("gives the place badge an accessible label naming the place", () => {
    const markup = render([bot({ busy: true, computer: "browser" })], group({ busyBotId: "aleta" }));
    expect(markup).toContain('aria-label="Where this conversation works: Browser"');
  });

  it("falls back to the plain working dot when the busy member's place is Auto", () => {
    const markup = render([bot({ busy: true })], group({ busyBotId: "aleta" }));
    expect(markup).not.toMatch(/width="9"[^>]*height="9"/);
  });

  it("shows no place badge at all for an idle member", () => {
    const markup = render([bot({ computer: "browser" })], group({ busyBotId: null }));
    expect(markup).not.toMatch(/width="9"[^>]*height="9"/);
  });
});
