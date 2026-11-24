// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTabsFrameOnRoot } from "./use-tabs-frame-on-root";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  container.remove();
  delete document.documentElement.dataset.chatTabsFrame;
  vi.unstubAllGlobals();
});

function Header({ look }: { look: "simple" | "advanced" | undefined }) {
  useTabsFrameOnRoot(look);
  return null;
}
const show = (look: "simple" | "advanced" | undefined) => act(async () => root.render(createElement(Header, { look })));

it("names the header's tab band on the root while it shows, and clears it when it goes", async () => {
  await show("simple");
  expect(document.documentElement.dataset.chatTabsFrame).toBe("simple");
  await show("advanced");
  expect(document.documentElement.dataset.chatTabsFrame).toBe("advanced");
  await show(undefined);
  expect(document.documentElement.dataset.chatTabsFrame).toBeUndefined();
  await show("simple");
  await act(async () => root.unmount());
  expect(document.documentElement.dataset.chatTabsFrame).toBeUndefined();
});
