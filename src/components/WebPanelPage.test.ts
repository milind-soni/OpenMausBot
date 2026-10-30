// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  panels: [] as Array<{ id: string; name: string; url: string }>,
  state: { webPanelId: "panel-1" } as { webPanelId?: string },
  dispatch: vi.fn(),
}));
vi.mock("@/lib/web-panel-preferences", () => ({ useWebPanels: () => fixture.panels }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));

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

  it("goes back to the chat when its panel was removed", () => {
    fixture.panels = [];
    act(() => root.render(createElement(WebPanelPage)));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });
});
