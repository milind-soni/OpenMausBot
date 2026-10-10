// @vitest-environment happy-dom
// Reply and copy show only while the pointer is over the message or keyboard
// focus is inside it, and on touch after a tap or long press on the message.
// The more button opens a menu of the moved actions that closes on Escape,
// a press outside or a pick.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MESSAGE_ROW, MessageActions } from "./MessageActions";

let host: HTMLDivElement;
let root: Root;

const row = () => host.querySelector<HTMLElement>(`[${MESSAGE_ROW}]`)!;
const body = () => host.querySelector<HTMLElement>("p")!;
const tray = () => host.querySelector<HTMLElement>('[data-testid="message-actions"]')!;
const shown = () => tray().dataset.shown === "true";
const more = () => tray().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];

const pointer = (type: string, target: Element, pointerType: string) =>
  act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", pointerType }));
  });

let picked: string[] = [];

async function render(forceOpen = false) {
  await act(async () => {
    root.render(
      createElement("div", { [MESSAGE_ROW]: "" },
        createElement("p", null, "an answer"),
        createElement(MessageActions, {
          side: "bot",
          forceOpen,
          menu: [
            { key: "pin", icon: null, label: "Pin message", onSelect: () => picked.push("pin") },
            { key: "raw", icon: null, label: "Show raw markdown", onSelect: () => picked.push("raw") },
          ],
          children: createElement("button", { type: "button" }, "copy"),
        }),
      ),
    );
  });
}

beforeEach(() => {
  setLocale("en");
  picked = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("message actions row", () => {
  it("shows while the pointer is over the message and hides when it leaves", async () => {
    await render();
    expect(shown()).toBe(false);
    await pointer("pointerenter", row(), "mouse");
    expect(shown()).toBe(true);
    await pointer("pointerleave", row(), "mouse");
    expect(shown()).toBe(false);
  });

  it("does not treat a touch passing over as a hover", async () => {
    await render();
    await pointer("pointerenter", row(), "touch");
    expect(shown()).toBe(false);
  });

  it("shows on a tap of the message and hides on the next", async () => {
    await render();
    await pointer("pointerdown", body(), "touch");
    await pointer("pointerup", body(), "touch");
    expect(shown()).toBe(true);
    await pointer("pointerdown", body(), "touch");
    await pointer("pointerup", body(), "touch");
    expect(shown()).toBe(false);
  });

  it("shows on a long press of the message", async () => {
    vi.useFakeTimers();
    await render();
    await pointer("pointerdown", body(), "touch");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(shown()).toBe(true);
  });

  it("does not reveal actions after a canceled touch at the same position", async () => {
    vi.useFakeTimers();
    await render();
    await pointer("pointerdown", body(), "touch");
    await pointer("pointercancel", body(), "touch");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(shown()).toBe(false);
    await pointer("pointerup", body(), "touch");
    expect(shown()).toBe(false);
  });

  it("opens the more menu with the moved actions and closes it on a pick", async () => {
    await render();
    await pointer("pointerenter", row(), "mouse");
    expect(items()).toHaveLength(0);
    await act(async () => more().click());
    expect(more().getAttribute("aria-expanded")).toBe("true");
    expect(items().map((item) => item.textContent)).toEqual(["Pin message", "Show raw markdown"]);
    // the row stays out while its menu is open, even with the pointer gone
    await pointer("pointerleave", row(), "mouse");
    expect(shown()).toBe(true);
    await act(async () => items()[0]!.click());
    expect(picked).toEqual(["pin"]);
    expect(items()).toHaveLength(0);
  });

  it("closes the menu on Escape", async () => {
    await render();
    await act(async () => more().click());
    expect(items()).toHaveLength(2);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(items()).toHaveLength(0);
  });

  it("keeps a row that must stay reachable out", async () => {
    await render(true);
    expect(shown()).toBe(true);
    await pointer("pointerleave", row(), "mouse");
    expect(shown()).toBe(true);
  });
});
