// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: vi.fn(async () => ({ hits: [] })),
    useStore: () => ({ state: { ...original.initialState, bots: [bot], groups: [] }, dispatch: vi.fn() }),
  };
});

import { CommandPalette, openCommandPalette } from "./CommandPalette";

const bot: Bot = {
  id: "theme-bot", threadId: "theme-thread", name: "Juniper", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "",
  modelSelection: { instanceId: "claude", model: "fake" },
};

// The real skins set --code-color-scheme per skin; this stands in for the two the command moves between and one more.
const skinModes = document.createElement("style");
skinModes.textContent = ':root[data-skin="daylight"], :root[data-skin="linen"] { --code-color-scheme: light; } :root[data-skin="midnight"] { --code-color-scheme: dark; }';
document.head.append(skinModes);

const values = new Map<string, string>();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.skin;
});

function open(skin: string) {
  document.documentElement.dataset.skin = skin;
  flushSync(() => root.render(createElement(CommandPalette)));
  flushSync(() => openCommandPalette());
  return document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const command = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Toggle light/dark");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("lists the command under Commands and wears Daylight from Midnight, saving the choice Settings reads", async () => {
  open("midnight");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Commands");
  flushSync(() => command()!.click());
  await settle();
  expect(document.documentElement.dataset.skin).toBe("daylight");
  expect(values.get("omb-skin")).toBe("daylight");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("finds it by typing and takes another light skin to Midnight with Enter", async () => {
  const input = open("linen");
  type(input, "dark");
  expect(command()).toBeDefined();
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(values.get("omb-skin")).toBe("midnight");
});

it("pins Midnight or Daylight when the theme followed the system, as Appearance does", async () => {
  values.set("omb-skin", "system");
  open("midnight");
  flushSync(() => command()!.click());
  await settle();
  expect(values.get("omb-skin")).toBe("daylight");
});

it("leaves the command out when the search does not name it", () => {
  const input = open("midnight");
  type(input, "juniper");
  expect(command()).toBeUndefined();
});
