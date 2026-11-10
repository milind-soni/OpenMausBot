// @vitest-environment happy-dom
// The word about the new look: no switch, closed for good by Done, ×, Escape or a click outside.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { NEW_LOOK_KEY, newLookDue } from "@/lib/new-look";

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
vi.mock("@/lib/brand", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/brand")>(), productName: () => "MausBot" }));
const { NewLookNotice } = await import("./NewLookNotice");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, opener: HTMLButtonElement;
const onClose = vi.fn();
const dialog = () => host.querySelector<HTMLElement>("[data-new-look-notice]");
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label)!;
const show = async () => { await act(async () => { root.render(createElement(NewLookNotice, { onClose })); }); };
const key = async (name: string, shiftKey = false) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })); });
};
const events = () => analytics.track.mock.calls.filter(([event]) => event === "new_look_notice").map(([, props]) => props);

beforeEach(() => {
  setLocale("en");
  const values = new Map<string, string>([[NEW_LOOK_KEY, "due"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)),
    removeItem: (k: string) => void values.delete(k) });
  analytics.track.mockReset();
  onClose.mockReset();
  opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  opener.remove();
  vi.unstubAllGlobals();
});

describe("the new look notice", () => {
  it("says where the rarer settings went, with no switch back, and starts focus on its title", async () => {
    await show();
    expect(dialog()?.getAttribute("role")).toBe("dialog");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("h2")?.textContent).toBe("MausBot has a simpler look");
    expect(host.textContent).toContain("Everything you need is still here; rarer settings are under Settings → More settings.");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).not.toContain("Advanced");
    expect(document.activeElement).toBe(host.querySelector("h2"));
  });

  it.each(["Done", "Close", "Escape", "outside"])("closes for good with %s", async (how) => {
    await show();
    if (how === "Escape") await key("Escape");
    else if (how === "outside") await act(async () => { dialog()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    else await act(async () => { button(how).click(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(newLookDue()).toBe(false);
    expect(localStorage.getItem(NEW_LOOK_KEY)).toBe("seen");
    expect(events()).toEqual([{ action: "closed" }]);
  });

  it("keeps the keyboard inside while it is open, and gives focus back when it closes", async () => {
    await show();
    await key("Tab");
    expect(document.activeElement).toBe(button("Done"));
    await key("Tab");
    expect(document.activeElement).toBe(button("Close"));
    await key("Tab");
    expect(document.activeElement, "round to the first again").toBe(button("Done"));
    await key("Tab", true);
    expect(document.activeElement).toBe(button("Close"));
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(document.activeElement).toBe(opener);
  });
});
