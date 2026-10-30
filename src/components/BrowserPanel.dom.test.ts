// @vitest-environment happy-dom
// The Maximize button overlays the window and Escape restores the panel, whose press cannot also close
// a dialog beneath.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("@/lib/browser-pip", () => ({
  supportsBrowserPictureInPicture: () => false,
  useBrowserPictureInPicture: () => "",
}));
vi.mock("./browser/StreamSurface", () => ({ StreamSurface: (props: { label: string }) => createElement("div", { "data-stub-surface": props.label }) }));
vi.mock("./browser/BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("./browser/MoreMenu", () => ({ MoreMenu: () => null }));
vi.mock("./browser/PasskeyNotice", () => ({ PasskeyNotice: () => null }));

const { LiveBrowser } = await import("./BrowserPanel");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};

let host: HTMLDivElement;
let root: Root;
let dialogCloses: ReturnType<typeof vi.fn<() => void>>;
// What a dialog beneath the panel hears: un-prevented Escape closes it.
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape" && !event.defaultPrevented) dialogCloses();
};
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const pressEscape = () => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
};
// Passive effects and the renders they schedule.
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const panel = () => host.querySelector<HTMLElement>("[data-browser-transport]")!;
const maximizeButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Maximize"], [aria-label="Restore size"]');
const skyward = () => panel().className.split(" ").includes("inset-0");

beforeEach(() => {
  dialogCloses = vi.fn();
  window.addEventListener("keydown", onWindowKey);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(LiveBrowser, { bot })));
});
afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  flushSync(() => root.unmount());
  host.remove();
});

describe("the browser panel's Maximize", () => {
  it("overlays the window from the control, then Escape restores the panel without closing a dialog beneath", async () => {
    click(maximizeButton());
    expect(skyward()).toBe(true);
    expect(maximizeButton()?.getAttribute("aria-label")).toBe("Restore size");

    const event = pressEscape();
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(skyward()).toBe(false);
    expect(dialogCloses).not.toHaveBeenCalled();
  });

  it("leaves Escape to the app while the panel is its usual size", () => {
    pressEscape();
    expect(skyward()).toBe(false);
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });
});
