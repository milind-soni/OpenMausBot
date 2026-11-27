// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  focusComputerPanelEntry,
  releaseComputerPanelFocus,
  rememberComputerPanelOpen,
  takeComputerPanelTabFocus,
} from "./computer-panel-focus";

const rect = (patch: Partial<DOMRect>): DOMRect => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...patch }) as DOMRect;

function panel(html: string): HTMLElement {
  const root = document.createElement("aside");
  root.dataset.computerPanel = "true";
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const tabRow = (selected: string) =>
  `<div role="tablist">${["computer", "data"].map((view) => `<button role="tab" aria-selected="${String(view === selected)}" id="tab-${view}">${view}</button>`).join("")}</div>`;

const close = () => '<button data-computer-panel-close id="close">Close</button>';

const focusedId = () => document.activeElement?.id || document.activeElement?.tagName;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("computer panel entry focus", () => {
  it("takes the one-shot focus for the bot that opened it, and only once", () => {
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: true });
    expect(takeComputerPanelTabFocus("scout")).toBe(true);
    expect(takeComputerPanelTabFocus("scout")).toBe(false);
    expect(takeComputerPanelTabFocus("other")).toBe(false);
  });

  it("does not take focus for a pointer open", () => {
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: false });
    expect(takeComputerPanelTabFocus("scout")).toBe(false);
  });

  it("takes focus for a later bot after a mouse open cleared the intent", () => {
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: true });
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: false });
    expect(takeComputerPanelTabFocus("scout")).toBe(false);
  });

  it("focuses the panel's own active tab", () => {
    const root = panel(tabRow("data") + close());
    focusComputerPanelEntry(root);
    expect(focusedId()).toBe("tab-data");
  });

  it("ignores a nested tab row, such as the browser's tab strip", () => {
    const root = panel(`<div role="tabpanel">${tabRow("computer")}</div>` + close());
    focusComputerPanelEntry(root);
    expect(focusedId()).toBe("close");
  });

  it("falls back to the close button when the panel has no tab row", () => {
    const root = panel(close());
    focusComputerPanelEntry(root);
    expect(focusedId()).toBe("close");
  });
});

describe("computer panel close hand-off", () => {
  it("leaves focus alone when the close is not taken from inside the panel", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    const root = panel(close());
    const composer = document.createElement("textarea");
    composer.id = "composer";
    document.body.append(composer);
    composer.focus();

    releaseComputerPanelFocus(root, "scout");
    expect(focusedId()).toBe("composer");
  });

  it("returns focus to the opener that is still mounted", () => {
    const opener = document.createElement("button");
    opener.id = "chat-computer";
    document.body.append(opener);
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    const root = panel(close());
    root.querySelector<HTMLElement>("#close")!.focus();

    releaseComputerPanelFocus(root, "scout");
    expect(focusedId()).toBe("chat-computer");
  });

  it("falls back to the chat header when the opener was unmounted", () => {
    const chatButton = document.createElement("button");
    chatButton.dataset.tour = "computer";
    chatButton.id = "chat-computer";
    document.body.append(chatButton);
    const opener = document.createElement("button");
    document.body.append(opener);
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    opener.remove();
    const root = panel(close());
    root.querySelector<HTMLElement>("#close")!.focus();

    releaseComputerPanelFocus(root, "scout");
    expect(focusedId()).toBe("chat-computer");
  });

  it("keeps focus where it is when no fallback target exists", () => {
    const row = document.createElement("div");
    row.dataset.sidebarBotRow = "other";
    row.tabIndex = 0;
    document.body.append(row);
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: true });
    const root = panel(close());
    root.querySelector<HTMLElement>("#close")!.focus();

    releaseComputerPanelFocus(root, "scout");
    expect(document.activeElement).not.toBe(row);
  });

  it("falls back to the visible sidebar row, then to the composer", () => {
    const row = document.createElement("div");
    row.dataset.sidebarBotRow = "scout";
    row.tabIndex = 0;
    document.body.append(row);
    const composer = document.createElement("div");
    composer.dataset.tour = "composer";
    composer.innerHTML = '<textarea id="composer"></textarea>';
    document.body.append(composer);
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: true });
    const root = panel(close());
    root.querySelector<HTMLElement>("#close")!.focus();

    // A wide-screen row takes the focus.
    row.getBoundingClientRect = () => rect({ width: 200, height: 40, right: 200 });
    releaseComputerPanelFocus(root, "scout");
    expect(document.activeElement).toBe(row);

    // A row pushed off-canvas by the drawer must not: the composer is next.
    row.getBoundingClientRect = () => rect({ width: 200, height: 40, left: -240, right: -40 });
    root.querySelector<HTMLElement>("#close")!.focus();
    releaseComputerPanelFocus(root, "scout");
    expect(focusedId()).toBe("composer");
  });
});
