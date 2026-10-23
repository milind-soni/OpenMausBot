// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const dispatch = vi.fn();
const api = vi.fn(async (_path: string, _init?: RequestInit) => ({ ok: true }));
vi.mock("@/state/store", async () => {
  const { createContext } = await import("react");
  return { StoreContext: createContext(null), useStore: () => ({ state: {}, dispatch }), api: (path: string, init?: RequestInit) => api(path, init) };
});
const openExternalLink = vi.fn(async (_url: string) => {});
vi.mock("@/lib/app-links", () => ({ openExternalLink: (url: string) => openExternalLink(url) }));
import { StoreContext } from "@/state/store";
import { usePanelPage, type PanelPage } from "@/lib/page-open";
import { PublishedPageCard } from "./PublishedPageCard";

const URL = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
const page = (card: Message["publishedPage"]): Message => ({ id: "m1", at: 1, role: "bot", kind: "text", text: "fallback", publishedPage: card });
const live = page({ state: "live", title: "Bake sale", pageId: "abcdefghijklmnopqrstuvwxyz", url: URL, usage: { pages: 3, limit: 5 } });
/** The app's state with Pepper's chat open; Pepper's browser is on and installed. */
const app = (over: Record<string, unknown> = {}) => ({
  selectedId: "pepper", bots: [{ id: "pepper" }], groups: [{ id: "room" }],
  config: { features: { browser: true }, browserEngine: { kind: "engine" } }, ...over,
});

function render(message: Message, state = app()) {
  const container = document.createElement("div"), root = createRoot(container);
  const panel: PanelPage[] = [];
  function Panel() { usePanelPage("pepper", (asked) => panel.push(asked)); return null; }
  flushSync(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch } as never },
    createElement(PublishedPageCard, { message }), createElement(Panel))));
  return { container, root, panel };
}
const desktop = (bridge: Record<string, unknown> = {}) => { (window as { ogb?: unknown }).ogb = { platform: "darwin", ...bridge }; };
const buttons = (container: HTMLElement) => [...container.querySelectorAll("button")];

afterEach(() => { vi.clearAllMocks(); delete (window as { ogb?: unknown }).ogb; });

describe("a published page's card", () => {
  it("shows the title, the link and the usage; on the web Open and the link open a new tab; and it unpublishes the page", async () => {
    const { container, root, panel } = render(live);
    try {
      expect(container.textContent).toContain("Bake sale");
      expect(container.textContent).toContain(URL);
      expect(container.textContent).toContain("3 of 5 pages");
      expect(buttons(container).map((button) => button.textContent)).toEqual(["Copy link", "Open", "Unpublish"]);
      buttons(container)[1]!.click();
      container.querySelector("a")!.click();
      expect(openExternalLink.mock.calls).toEqual([[URL], [URL]]);
      expect(panel).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
      buttons(container)[2]!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/published-pages/abcdefghijklmnopqrstuvwxyz/unpublish", { method: "POST", body: "{}" }));
    } finally { root.unmount(); }
  });

  it("in the desktop app, Open and the link show the page in the bot's browser panel, and never send anything", () => {
    desktop();
    const { container, root, panel } = render(live);
    try {
      buttons(container)[1]!.click();
      container.querySelector("a")!.click();
      expect(panel.map(({ botId, url }) => [botId, url])).toEqual([["pepper", URL], ["pepper", URL]]);
      expect(dispatch.mock.calls).toEqual([[{ type: "toggleComputer", open: true }], [{ type: "toggleComputer", open: true }]]);
      expect(openExternalLink).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
    } finally { root.unmount(); }
  });

  it("in the desktop app without a browser panel to show it, opens the system browser", () => {
    for (const [state, bridge] of [
      [app({ selectedId: "room" }), {}],
      [app({ bots: [{ id: "pepper", browser: false }] }), {}],
      [app({ config: { features: { browser: true }, browserEngine: { kind: "unavailable", installable: true } } }), {}],
      [app(), { remoteClient: { active: true } }],
    ] as const) {
      desktop(bridge);
      const { container, root, panel } = render(live, state);
      try {
        buttons(container)[1]!.click();
        expect(openExternalLink).toHaveBeenCalledWith(URL);
        expect(panel).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
      } finally { root.unmount(); vi.clearAllMocks(); }
    }
  });

  it("says when the page was unpublished, with no buttons", () => {
    const { container, root } = render(page({ state: "unpublished", title: "Bake sale", pageId: "abcdefghijklmnopqrstuvwxyz", url: URL, usage: { pages: 2, limit: 5 } }));
    try {
      expect(container.textContent).toContain("Unpublished. The link no longer opens.");
      expect(container.textContent).toContain("2 of 5 pages");
      expect(container.querySelectorAll("button")).toHaveLength(0);
    } finally { root.unmount(); }
  });

  it("at the free limit, says so in the person's words and opens the app's Get Cloud flow", () => {
    desktop({ cloudAccount: {} });
    const { container, root } = render(page({ state: "limit", title: "Bake sale", plan: "free", upgrade: true, usage: { pages: 5, limit: 5 }, message: "server words" }));
    try {
      expect(container.textContent).toContain("You’ve used your 5 free pages. MausBot Cloud gives you more, and pages without the badge.");
      expect(container.textContent).toContain("5 of 5 pages");
      container.querySelector("button")!.click();
      expect(dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_pages" });
    } finally { root.unmount(); }
  });

  it("names the plan at a paid plan's limit, and offers no button without the desktop app's Cloud sign-in", () => {
    const { container, root } = render(page({ state: "limit", title: "Bake sale", plan: "personal", upgrade: true, usage: { pages: 25, limit: 25 } }));
    try {
      expect(container.textContent).toContain("You’ve used all 25 pages on your Personal plan. Unpublish a page to make room.");
      expect(container.querySelectorAll("button")).toHaveLength(0);
    } finally { root.unmount(); }
  });
});
