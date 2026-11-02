// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  panels: [] as Array<{ id: string; name: string; url: string }>,
  state: { webPanelId: "panel-1" } as { webPanelId?: string },
  dispatch: vi.fn(),
  api: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ framing: "allowed" })),
}));
vi.mock("@/lib/web-panel-preferences", () => ({ useWebPanels: () => fixture.panels }));
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
});
