// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveConnectionStrip, RECONNECTING_AFTER_MS } from "./LiveConnectionStrip";
import { t } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
const draw = (connected: boolean, hydrated = true) => act(() => root.render(createElement(LiveConnectionStrip, { connected, hydrated })));

it("says the app is reconnecting once the live stream has been down for a moment, and goes when it is back", async () => {
  draw(false);
  expect(container.textContent).toBe("");
  await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS); });
  expect(container.textContent).toContain(t("liveConnection.reconnecting"));
  draw(true);
  expect(container.textContent).toBe("");
});

it("says the device is offline at once", () => {
  draw(true);
  act(() => { window.dispatchEvent(new Event("offline")); });
  expect(container.textContent).toContain(t("liveConnection.offline"));
  act(() => { window.dispatchEvent(new Event("online")); });
  expect(container.textContent).toBe("");
});
