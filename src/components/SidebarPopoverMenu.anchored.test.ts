// @vitest-environment happy-dom
// The profile menu is one fixed-width sheet anchored to its trigger: above
// it, on its start edge, inside the window, the same whether the sidebar is
// wide, narrow or collapsed. Its keyboard: Enter or an arrow opens it on the
// first item, arrows Home and End move, the inline end arrow opens a
// submenu and the start arrow or Escape closes just that, Escape and an
// outside press close the menu and give focus back to the trigger.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANCHORED_MENU_WIDTH,
  SidebarPopoverMenu,
  anchoredMenuPosition,
  nextMenuIndex,
  submenuPosition,
  type SidebarMenuItem,
} from "./SidebarPopoverMenu";

const viewport = { width: 1280, height: 800 };
const menu = { width: ANCHORED_MENU_WIDTH, height: 300 };
// the profile row of a 300px sidebar, at the bottom of the window
const wideRow = { left: 12, right: 288, top: 740, bottom: 784 };
// the avatar of a sidebar collapsed to icons
const avatar = { left: 14, right: 58, top: 740, bottom: 784 };

describe("anchoredMenuPosition", () => {
  it("opens above the trigger on its start edge, the same for a row and a lone avatar", () => {
    expect(anchoredMenuPosition(wideRow, menu, viewport)).toEqual({ left: 12, top: 740 - 6 - 300 });
    expect(anchoredMenuPosition(avatar, menu, viewport)).toEqual({ left: 14, top: 434 });
  });

  it("anchors to the trigger's right edge in RTL, and stays inside the window", () => {
    const rtlRow = { left: 980, right: 1268, top: 740, bottom: 784 };
    expect(anchoredMenuPosition(rtlRow, menu, viewport, true)).toEqual({ left: 1268 - 280, top: 434 });
    // a collapsed RTL rail's avatar near the left edge would push it out
    expect(anchoredMenuPosition({ left: 0, right: 44, top: 740, bottom: 784 }, menu, viewport, true).left).toBe(8);
  });

  it("never runs off the inline end of a narrow window", () => {
    expect(anchoredMenuPosition({ left: 200, right: 260, top: 500, bottom: 540 }, menu, { width: 320, height: 600 }).left).toBe(320 - 280 - 8);
  });

  it("drops below the trigger when there is no room above, and clamps to a short window", () => {
    expect(anchoredMenuPosition({ left: 12, right: 60, top: 40, bottom: 80 }, menu, viewport).top).toBe(86);
    expect(anchoredMenuPosition({ left: 12, right: 60, top: 100, bottom: 140 }, menu, { width: 800, height: 320 }).top).toBe(12);
  });
});

describe("submenuPosition", () => {
  const sheet = { left: 12, right: 292, top: 434, bottom: 734 };
  const row = { left: 18, right: 286, top: 520, bottom: 560 };
  const sub = { width: 240, height: 180 };

  it("sits beside the menu on the inline end side, level with its row", () => {
    expect(submenuPosition(sheet, row, sub, viewport)).toEqual({ left: 296, top: 514 });
    expect(submenuPosition({ left: 988, right: 1268, top: 434, bottom: 734 }, row, sub, viewport, true)).toEqual({ left: 988 - 4 - 240, top: 514 });
  });

  it("flips to the other side when the window has no room", () => {
    const right = { left: 900, right: 1180, top: 434, bottom: 734 };
    expect(submenuPosition(right, row, sub, viewport).left).toBe(900 - 4 - 240);
  });
});

it("moves through the items with arrows, Home and End, wrapping", () => {
  expect(nextMenuIndex("ArrowDown", -1, 4)).toBe(0);
  expect(nextMenuIndex("ArrowDown", 3, 4)).toBe(0);
  expect(nextMenuIndex("ArrowUp", 0, 4)).toBe(3);
  expect(nextMenuIndex("Home", 2, 4)).toBe(0);
  expect(nextMenuIndex("End", 0, 4)).toBe(3);
  expect(nextMenuIndex("a", 0, 4)).toBeNull();
});

describe("the anchored menu in a document", () => {
  let host: HTMLDivElement;
  let root: Root;
  const picked: string[] = [];
  const item = (key: string, extra: Partial<SidebarMenuItem> = {}): SidebarMenuItem => ({ key, label: key, onSelect: () => picked.push(key), ...extra });
  const items: SidebarMenuItem[] = [
    item("Usage"),
    item("Help and support", { submenu: [item("Help Center"), item("About")] }),
    item("Settings"),
    item("Account", { separatorBefore: true, value: "Pro" }),
  ];
  const sheet = () => document.querySelector<HTMLElement>("[data-sidebar-popover-menu]");
  const submenu = () => document.querySelector<HTMLElement>("[data-sidebar-popover-submenu]");
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const key = async (target: Element, keyName: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, cancelable: true }));
    });
  };
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.dataset.reducedMotion = "true";
    picked.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(SidebarPopoverMenu, { items, ariaLabel: "You", renderTrigger: () => "You" }));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("portals one 280px sheet to the body, with the group divider and the trailing value and chevron", async () => {
    await act(async () => trigger().click());
    const menu = sheet()!;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.width).toBe(`${ANCHORED_MENU_WIDTH}px`);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu.textContent).toContain("Pro");
    const support = [...menu.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.includes("Help and support"))!;
    expect(support.getAttribute("aria-haspopup")).toBe("menu");
    expect(support.querySelector("svg")).not.toBeNull();
    expect(menu.querySelector('[role="menuitem"]')!.className).toContain("text-[15px]");
  });

  it("opens from the keyboard on the first item and walks the items", async () => {
    await key(trigger(), "ArrowUp");
    await flush();
    const rows = [...sheet()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(rows[0]);
    await key(rows[0]!, "End");
    expect(document.activeElement).toBe(rows[3]);
    await key(rows[3]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("opens the submenu with the inline end arrow and closes only it with Escape", async () => {
    await act(async () => trigger().click());
    const support = [...sheet()!.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!;
    support.focus();
    await key(support, "ArrowRight");
    await flush();
    expect(submenu()).not.toBeNull();
    expect(support.getAttribute("aria-expanded")).toBe("true");
    const first = submenu()!.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(submenu()).toBeNull();
    expect(sheet()).not.toBeNull();
    expect(document.activeElement).toBe(support);
  });

  it("runs a submenu item and closes everything", async () => {
    await act(async () => trigger().click());
    const support = [...sheet()!.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!;
    await act(async () => support.click());
    await act(async () => [...submenu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!.click());
    expect(picked).toEqual(["About"]);
    expect(sheet()).toBeNull();
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    await act(async () => trigger().click());
    await key(sheet()!, "Escape");
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a press outside, but not on a press inside the portalled sheet", async () => {
    await act(async () => trigger().click());
    await act(async () => sheet()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(sheet()).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(sheet()).toBeNull();
  });
});
