// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), showThreads: true }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({
    state: {
      bots: [
        { id: "scout", name: "Scout", title: "Research", description: "", color: "blue", hidden: false,
          threadId: "older", mainThreadId: "latest", tasks: [{ threadId: "older" }, { threadId: "latest" }] },
        { id: "quill", name: "Quill", title: "", description: "Writes the newsletter\nand more", color: "pink", hidden: false },
        { id: "ghost", name: "Ghost", title: "", description: "", color: "green", hidden: true },
      ],
    },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { SidebarNewChatPanel, newChatPanelMaxHeight, newChatPanelPlacement, newChatSubtext } from "./SidebarNewChatPanel";

describe("newChatPanelMaxHeight", () => {
  it("caps the card at 480px and keeps it inside short windows", () => {
    expect(newChatPanelMaxHeight(900)).toBe(480);
    expect(newChatPanelMaxHeight(500)).toBe(428);
  });
});

describe("newChatPanelPlacement", () => {
  it("opens against the sidebar when the chat has room", () => {
    expect(newChatPanelPlacement({ left: 0, right: 320 }, 1280)).toEqual({ left: 328, width: 360, floating: true });
    expect(newChatPanelPlacement({ left: 0, right: 80 }, 420)).toEqual({ left: 88, width: 324, floating: true });
  });
  it("takes the whole width when the room beside the sidebar is too narrow", () => {
    expect(newChatPanelPlacement({ left: 0, right: 320 }, 600)).toEqual({ left: 0, width: 600, floating: false });
    expect(newChatPanelPlacement(null, 390)).toEqual({ left: 0, width: 390, floating: false });
  });
  it("opens to the sidebar's left in a right-to-left layout", () => {
    expect(newChatPanelPlacement({ left: 960, right: 1280 }, 1280, true)).toEqual({ left: 592, width: 360, floating: true });
    expect(newChatPanelPlacement({ left: 280, right: 600 }, 600, true)).toEqual({ left: 0, width: 600, floating: false });
  });
});

describe("newChatSubtext", () => {
  it("prefers the title, then the description's first line", () => {
    expect(newChatSubtext({ title: "Research", description: "x" })).toBe("Research");
    expect(newChatSubtext({ title: " ", description: "Writes\nmore" })).toBe("Writes");
    expect(newChatSubtext({ title: "", description: "" })).toBe("");
  });
});

describe("SidebarNewChatPanel", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = undefined;
    fixture.dispatch.mockReset();
    fixture.showThreads = true;
  });

  function open(makesBots = true) {
    const props = { anchor: null, onClose: vi.fn(), onNewBot: makesBots ? vi.fn() : undefined, onNewGroup: vi.fn() };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(SidebarNewChatPanel, props)));
    const input = container.querySelector("input")!;
    return { props, input };
  }
  const key = (target: Element, name: string) =>
    flushSync(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  const type = (input: HTMLInputElement, value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("lists visible bots under the create actions and focuses To:", () => {
    const { input } = open();
    expect(document.activeElement).toBe(input);
    const text = container!.textContent ?? "";
    expect(text).toContain("Create new bot");
    expect(text).toContain("Create group chat");
    expect(text).toContain("Scout");
    expect(text).not.toContain("Writes the newsletter");
    expect(container!.querySelector("[aria-label^='Quill, Writes the newsletter']")).not.toBeNull();
    expect(text).not.toContain("Ghost");
  });

  it("offers no new bot to someone who can't make one, and Enter still starts with the first bot", () => {
    const { input } = open(false);
    expect(container!.textContent).not.toContain("Create new bot");
    expect(container!.textContent).toContain("Create group chat");
    key(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "scout" });
  });

  it("starts a new thread with the first bot on Enter", () => {
    const { props, input } = open();
    key(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "scout" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("filters by name and arrows through the matches", () => {
    const { input } = open();
    type(input, "qu");
    expect(container!.textContent).not.toContain("Scout");
    key(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "quill" });
  });

  it("does nothing on Enter when no bot matches", () => {
    const { props, input } = open();
    type(input, "zzz");
    expect(container!.textContent).toContain("No bot matches");
    key(input, "Enter");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(props.onNewBot).not.toHaveBeenCalled();
    expect(props.onNewGroup).not.toHaveBeenCalled();
  });

  it("reaches the create actions with the arrow keys", () => {
    const { props, input } = open();
    key(input, "ArrowUp");
    key(input, "Enter");
    expect(props.onNewGroup).toHaveBeenCalledOnce();
  });

  it("opens the bot's one conversation, its main thread, in simple mode", () => {
    fixture.showThreads = false;
    const { input } = open();
    expect(container!.querySelector("[aria-label$='. Open']")).not.toBeNull();
    key(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "scout", threadId: "latest" });
  });

  it("has a close button for when it covers the whole window", () => {
    const { props } = open();
    const close = container!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    flushSync(() => close.click());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape and on a press outside, not inside", () => {
    const { props, input } = open();
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(props.onClose).not.toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(props.onClose).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("SidebarNewChatPanel with an input method", () => {
  const composing = [
    { name: "composition", init: { isComposing: true } },
    { name: "IME key code", init: { keyCode: 229 } },
  ];
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = undefined;
    fixture.dispatch.mockReset();
  });

  function open() {
    const props = { anchor: null, onClose: vi.fn(), onNewBot: vi.fn(), onNewGroup: vi.fn() };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(SidebarNewChatPanel, props)));
    return { props, input: container.querySelector("input")! };
  }
  const press = (target: Element, key: string, init: KeyboardEventInit) =>
    flushSync(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });

  it.each(composing)("does not start a chat or close on keys that belong to the $name", ({ init }) => {
    const { props, input } = open();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    try {
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "qu");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      press(input, "Enter", init);
      press(input, "Escape", init);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outside);
    }
  });
});
