// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store";
import { SidebarPageTile } from "./SidebarTiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const dispatch = vi.fn<(action: Action) => void>();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  dispatch.mockReset();
});

describe("a pinned page's tile without a favicon", () => {
  it("falls back to the web icon when its site has no favicon, and opens its page from the keyboard", async () => {
    await act(async () => {
      root.render(createElement(SidebarPageTile, { panel: { id: "board", name: "Fleet board", url: "http://127.0.0.1:7841/" }, open: false, dispatch }));
    });
    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("http://127.0.0.1:7841/favicon.ico");
    await act(async () => { image.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg.lucide-globe")?.getAttribute("width")).toBe("24");
    const tile = host.querySelector<HTMLButtonElement>("[data-sidebar-page=board]")!;
    expect(tile.tagName).toBe("BUTTON");
    await act(async () => { tile.click(); });
    expect(dispatch).toHaveBeenCalledWith({ type: "showWebPanel", id: "board" });
  });
});
