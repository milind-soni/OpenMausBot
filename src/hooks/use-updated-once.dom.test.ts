// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
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

it("drops the version from a mounted card once the engine is on one without an update, as after a switch of runtime", async () => {
  let setUpdated!: (value: { version: string; at: number } | undefined) => void;
  function Card() {
    const [autoUpdated, set] = useState<{ version: string; at: number } | undefined>({ version: "1.5.8", at: 1 });
    setUpdated = set;
    return createElement("span", null, useUpdatedOnce({ driverKind: "antigravityAgent", autoUpdated }) ?? "plain");
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Card)));
  expect(container.textContent).toBe("1.5.8");
  await act(async () => setUpdated(undefined));
  expect(container.textContent).toBe("plain");
});

it("names each version once when one engine has two cards on two versions", async () => {
  async function cardsFor(): Promise<string> {
    function Cards() {
      return createElement("span", null,
        useUpdatedOnce({ driverKind: "antigravityAgent", autoUpdated: { version: "1.5.8", at: 1 } }) ?? "plain",
        " ",
        useUpdatedOnce({ driverKind: "antigravityAgent", autoUpdated: { version: "1.4.3", at: 1 } }) ?? "plain");
    }
    await act(async () => root?.unmount());
    container?.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(Cards)));
    return container.textContent ?? "";
  }
  expect(await cardsFor()).toBe("1.5.8 1.4.3");
  expect(await cardsFor()).toBe("plain plain");
});
