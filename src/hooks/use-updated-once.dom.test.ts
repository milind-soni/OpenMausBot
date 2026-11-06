// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdatedOnce } from "./use-updated-once";

let root: Root | null = null;
let container: HTMLElement | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
});

async function shownFor(autoUpdated?: { version: string; at: number }): Promise<string> {
  function Card() {
    return createElement("span", null, useUpdatedOnce({ driverKind: "opencodeGo", autoUpdated }) ?? "plain");
  }
  await act(async () => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Card)));
  return container.textContent ?? "";
}

it("names the version the app updated an engine to the first time its card shows, then no more", async () => {
  expect(await shownFor()).toBe("plain");
  expect(await shownFor({ version: "2.2.5", at: 1 })).toBe("2.2.5");
  expect(await shownFor({ version: "2.2.5", at: 1 })).toBe("plain");
  expect(await shownFor({ version: "2.3.0", at: 2 })).toBe("2.3.0");
});
