// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fx = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn(), flushBotPatches: () => Promise.resolve() }) };
});

const { SoulField } = await import("./SoulField");
const { BotEditorContext } = await import("./bot-settings/BotEditorContext");

let host: HTMLDivElement;
let root: Root;
const bot = (soul: string): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Scout", title: "Scout", description: "", notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "local", model: "test-model" }, messages: [], soul,
});
const render = (value: Bot, onPatch: (patch: { soul?: string }) => void) => flushSync(() => root.render(
  createElement(BotEditorContext.Provider, { value: { request: fx.request } }, createElement(SoulField, { bot: value, onPatch })),
));
const openLarge = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Open large");
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const type = (box: HTMLTextAreaElement, value: string) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  setLocale("en");
  fx.request.mockReset();
  fx.request.mockRejectedValue(new Error("offline"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the standing instructions editor opened large", () => {
  it("edits the same instructions with the byte count, and Escape returns to the settings", () => {
    const onPatch = vi.fn();
    render(bot("# Rules\nBe brief."), onPatch);
    expect(openLarge(), "the Soul editor offers a large view").toBeDefined();
    openLarge()!.focus();
    flushSync(() => openLarge()!.click());

    const panel = dialog()!;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const large = panel.querySelector("textarea")!;
    expect(large.value).toBe("# Rules\nBe brief.");
    expect(document.activeElement).toBe(large);
    expect(panel.textContent).toContain("17 / 24,000 bytes");

    type(large, "# Rules\nBe brief and kind.");
    expect(onPatch).toHaveBeenLastCalledWith({ soul: "# Rules\nBe brief and kind." });
    expect(panel.textContent).toContain("26 / 24,000 bytes");

    const settingsEscape = vi.fn();
    window.addEventListener("keydown", settingsEscape);
    flushSync(() => large.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    window.removeEventListener("keydown", settingsEscape);
    expect(dialog()).toBeNull();
    expect(settingsEscape, "the bot settings stay open").not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.value).toBe("# Rules\nBe brief and kind.");
    expect(document.activeElement).toBe(openLarge());
  });

  it("closes with Done", () => {
    render(bot(""), vi.fn());
    flushSync(() => openLarge()!.click());
    const done = [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
    flushSync(() => done.click());
    expect(dialog()).toBeNull();
  });
});
