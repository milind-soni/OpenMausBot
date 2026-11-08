// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  panels: [] as Array<{ id: string; name: string; url?: string; page?: { botId: string; threadId: string; messageId: string } }>,
  setWebPanels: vi.fn(),
  fetchAppDocument: vi.fn(async (_threadId: string, _messageId: string, _signal?: AbortSignal): Promise<unknown> => ({ srcdoc: "<p>hi</p>", can: {} })),
  state: { webPanelId: "panel-1" } as { webPanelId?: string; bots?: unknown[] },
  dispatch: vi.fn(),
  /** Each document an AppFrame was shown with, in order: a frame shown twice with the same page appears twice. */
  framed: [] as string[],
  api: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ framing: "allowed" })),
}));
vi.mock("@/lib/web-panel-preferences", () => ({ useWebPanels: () => fixture.panels, setWebPanels: fixture.setWebPanels }));
vi.mock("./app/app-api", () => ({
  AppDocumentError: class AppDocumentError extends Error {
    failure: unknown;
    constructor(failure: { offline: boolean; error?: string }) { super(failure.error ?? "offline"); this.failure = failure; }
  },
  fetchAppDocument: fixture.fetchAppDocument,
}));
vi.mock("./app/AppFrame", async () => {
  const { createElement: h, useEffect } = await import("react");
  return {
    AppFrame: (props: { doc: { srcdoc: string }; botId: string; threadId: string; fill?: boolean }) => {
      useEffect(() => { fixture.framed.push(props.doc.srcdoc); }, [props.doc]);
      return h("div", { "data-frame": `${props.botId}/${props.threadId}`, "data-fill": String(Boolean(props.fill)) });
    },
  };
});
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/state/api", () => ({ api: fixture.api }));

const { WebPanelPage } = await import("./WebPanelPage");

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("a pinned web panel's page", () => {
  it("frames another site's page", () => {
    fixture.panels = [{ id: "panel-1", name: "Fleet board", url: "http://127.0.0.1:7841/" }];
    act(() => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("http://127.0.0.1:7841/");
  });

  it("never frames a page on the app's own origin, and offers the browser instead", () => {
    fixture.panels = [{ id: "panel-1", name: "Me", url: `${window.location.origin}/` }];
    act(() => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Open in browser");
  });

  it("says a site that refuses to be framed refuses it, and offers the browser instead", async () => {
    fixture.panels = [{ id: "panel-1", name: "Globo", url: "https://www.globo.com/" }];
    fixture.api.mockResolvedValueOnce({ framing: "blocked" });
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.api).toHaveBeenCalledWith(
      `/api/web-panels/framing?url=${encodeURIComponent("https://www.globo.com/")}&origin=${encodeURIComponent(window.location.origin)}`,
      expect.objectContaining({ background: true }),
    );
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("www.globo.com doesn't allow other apps to show it");
    expect([...host.querySelectorAll("button")].filter((button) => button.textContent === "Open in browser")).toHaveLength(2);
  });

  it("frames the page at once, and keeps it when the check can't tell or fails", async () => {
    fixture.panels = [{ id: "panel-1", name: "Board", url: "https://board.example.com/" }];
    let answer: (value: unknown) => void = () => undefined;
    fixture.api.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    act(() => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://board.example.com/");
    await act(async () => answer({ framing: "unknown" }));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://board.example.com/");

    fixture.panels = [{ id: "panel-1", name: "Board", url: "https://other.example.com/" }];
    fixture.api.mockRejectedValueOnce(new Error("forbidden"));
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://other.example.com/");
  });

  it("never shows a refused panel's message on the next panel", async () => {
    fixture.panels = [{ id: "panel-1", name: "Globo", url: "https://www.globo.com/" }];
    fixture.api.mockResolvedValueOnce({ framing: "blocked" });
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")).toBeNull();

    fixture.panels = [{ id: "panel-1", name: "Board", url: "https://board.example.com/" }];
    fixture.api.mockReturnValueOnce(new Promise(() => {}));
    act(() => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://board.example.com/");
  });

  it("goes back to the chat when its panel was removed", () => {
    fixture.panels = [];
    act(() => root.render(createElement(WebPanelPage)));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });

  it("shows a pinned chat page from the server, framed like the chat frames it", async () => {
    fixture.panels = [{ id: "panel-1", name: "Sales", page: { botId: "b1", threadId: "t1", messageId: "m1" } }];
    fixture.api.mockClear();
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.fetchAppDocument).toHaveBeenCalledWith("t1", "m1", expect.any(AbortSignal));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.querySelector("[data-frame]")?.getAttribute("data-frame")).toBe("b1/t1");
    expect(host.querySelector("[data-frame]")?.getAttribute("data-fill")).toBe("true");
    expect(host.querySelector("h1")?.textContent).toBe("Sales");
  });

  it("says when a pinned chat page is gone, and unpins it", async () => {
    const { AppDocumentError } = await import("./app/app-api");
    fixture.panels = [
      { id: "panel-1", name: "Sales", page: { botId: "b1", threadId: "t1", messageId: "m1" } },
      { id: "panel-2", name: "CI", url: "https://ci.example/" },
    ];
    fixture.fetchAppDocument.mockRejectedValueOnce(new AppDocumentError({ offline: false, status: 404, error: "No such page." }));
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("[data-frame]")).toBeNull();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("No such page.");
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Unpin")!.click());
    expect(fixture.setWebPanels).toHaveBeenCalledWith([{ id: "panel-2", name: "CI", url: "https://ci.example/" }]);
  });

  it("fetches a pinned chat page again when the bot replaces it in a loaded chat", async () => {
    fixture.panels = [{ id: "panel-1", name: "Sales", page: { botId: "b1", threadId: "t1", messageId: "m1" } }];
    const withRev = (rev: number) => [{ id: "b1", threadId: "t1", messages: [{ id: "m1", kind: "app", app: { title: "Sales", source: "html", doc: "d1", rev } }] }];
    fixture.state = { webPanelId: "panel-1", bots: withRev(1) };
    fixture.fetchAppDocument.mockClear();
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.fetchAppDocument).toHaveBeenCalledTimes(1);
    fixture.state = { webPanelId: "panel-1", bots: withRev(2) };
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.fetchAppDocument).toHaveBeenCalledTimes(2);
    fixture.state = { webPanelId: "panel-1" };
  });

  it("keeps the frame when its chat is unloaded by a thread switch, and never shows the old page again", async () => {
    fixture.panels = [{ id: "panel-1", name: "Sales", page: { botId: "b1", threadId: "t1", messageId: "m1" } }];
    const withRev = (threadId: string, rev: number) => [{ id: "b1", threadId, messages: [{ id: "m1", kind: "app", app: { title: "Sales", source: "html", doc: "d1", rev } }] }];
    fixture.state = { webPanelId: "panel-1", bots: withRev("t1", 1) };
    fixture.fetchAppDocument.mockClear();
    fixture.fetchAppDocument.mockResolvedValueOnce({ srcdoc: "rev 1", can: {} }).mockResolvedValueOnce({ srcdoc: "rev 2", can: {} });
    fixture.framed = [];
    await act(async () => root.render(createElement(WebPanelPage)));
    fixture.state = { webPanelId: "panel-1", bots: withRev("t2", 1) };
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.fetchAppDocument).toHaveBeenCalledTimes(1);
    fixture.state = { webPanelId: "panel-1", bots: withRev("t1", 2) };
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(fixture.fetchAppDocument).toHaveBeenCalledTimes(2);
    expect(fixture.framed).toEqual(["rev 1", "rev 2"]);
    fixture.state = { webPanelId: "panel-1" };
  });

  it("shows the page is loading while it is fetched", async () => {
    fixture.panels = [{ id: "panel-1", name: "Sales", page: { botId: "b1", threadId: "t1", messageId: "m1" } }];
    fixture.fetchAppDocument.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => root.render(createElement(WebPanelPage)));
    expect(host.querySelector("[data-frame]")).toBeNull();
    expect(host.querySelector("[data-app-placeholder]")).not.toBeNull();
  });
});
