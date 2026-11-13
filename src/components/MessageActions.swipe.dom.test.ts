// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_ROW, MessageActions } from "./MessageActions";

let host: HTMLDivElement, root: Root;
const reply = vi.fn();
const body = () => host.querySelector("p")!;
const row = () => host.querySelector<HTMLElement>(`[${MESSAGE_ROW}]`)!;

function draw(side: "user" | "bot" = "bot", onReply = reply) {
  flushSync(() => root.render(createElement("div", { [MESSAGE_ROW]: "" },
    createElement("p", null, "A message to quote"),
    createElement("a", { href: "#example" }, "A link"),
    createElement("pre", null, "Code that scrolls horizontally"),
    createElement(MessageActions, {
      side, onReply,
      menu: [{ key: "reply", icon: null, label: "Reply", onSelect: onReply }],
      children: createElement("button", { type: "button" }, "Copy"),
    }),
  )));
}

function touch(type: string, x: number, y: number, target: Element = body(), count = type === "touchend" || type === "touchcancel" ? 0 : 1, cancelable = true) {
  const point = { identifier: 1, clientX: x, clientY: y, target };
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperties(event, {
    touches: { value: Array.from({ length: count }, (_, index) => ({ ...point, identifier: index + 1 })) },
    changedTouches: { value: [point] },
  });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  reply.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("swiping a message to reply", () => {
  it.each(["user", "bot"] as const)("quotes a %s message once on release, with a visible drag hint", side => {
    draw(side);
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 110, 104).defaultPrevented).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    expect(host.querySelector("[data-swipe-reply]")).not.toBeNull();
    touch("touchend", 110, 104);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(row().style.translate).toBe("0px");
    touch("touchend", 110, 104);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("leaves vertical scrolling, left swipes and short movements alone", () => {
    draw();
    for (const [x, y] of [[32, 190], [-60, 100], [35, 102]]) {
      touch("touchstart", 30, 100);
      expect(touch("touchmove", x!, y!).defaultPrevented).toBe(false);
      touch("touchend", x!, y!);
    }
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not claim links, controls or horizontal code scrolling", () => {
    draw();
    for (const target of [host.querySelector("a")!, host.querySelector("button")!, host.querySelector("pre")!]) {
      touch("touchstart", 30, 100, target);
      expect(touch("touchmove", 120, 100, target).defaultPrevented).toBe(false);
      touch("touchend", 120, 100, target);
    }
    expect(reply).not.toHaveBeenCalled();
  });

  it("cancels an in-progress swipe and gives multi-touch back to the browser", () => {
    draw();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    touch("touchcancel", 120, 100);
    touch("touchend", 120, 100);
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 120, 100, body(), 2).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps a long press available instead of turning it into a late swipe", () => {
    vi.useFakeTimers();
    draw();
    flushSync(() => body().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 30, clientY: 100 })));
    touch("touchstart", 30, 100);
    flushSync(() => vi.advanceTimersByTime(500));
    expect(host.querySelector('[data-testid="message-actions"]')?.getAttribute("data-shown")).toBe("true");
    expect(touch("touchmove", 120, 100).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not turn an existing text selection into a reply", () => {
    draw();
    const range = document.createRange();
    range.selectNodeContents(body());
    window.getSelection()?.addRange(range);
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 120, 100).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
  });

  it("uses the current reply target when the message rerenders during the gesture", () => {
    const nextReply = vi.fn();
    draw();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    draw("bot", nextReply);
    touch("touchend", 120, 100);
    expect(nextReply).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("lets the person back out after passing the reply threshold", () => {
    draw();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    touch("touchmove", 60, 100);
    touch("touchend", 60, 100);
    expect(reply).not.toHaveBeenCalled();
    expect(row().style.translate).toBe("0px");
  });

  it("does not reinterpret a vertical scroll as a reply when it later moves right", () => {
    draw();
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 34, 140).defaultPrevented).toBe(false);
    expect(touch("touchmove", 120, 145).defaultPrevented).toBe(false);
    touch("touchend", 120, 145);
    expect(reply).not.toHaveBeenCalled();
  });

  it("cancels when the browser has already taken the gesture", () => {
    draw();
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 120, 100, body(), 1, false).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
  });

  it("abandons a claimed drag when another finger joins it", () => {
    draw();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    expect(touch("touchmove", 120, 100, body(), 2).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
    expect(row().style.translate).toBe("0px");
  });

  it("preserves a nested horizontal scroller without special markup", () => {
    draw();
    const scroller = document.createElement("div"), content = document.createElement("span");
    scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, { clientWidth: { value: 100 }, scrollWidth: { value: 300 } });
    scroller.append(content);
    row().append(scroller);
    touch("touchstart", 30, 100, content);
    expect(touch("touchmove", 120, 100, content).defaultPrevented).toBe(false);
    touch("touchend", 120, 100, content);
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(["", "plaintext-only"])("leaves contenteditable=%s to the editor", value => {
    draw();
    const editor = document.createElement("div"), content = document.createElement("span");
    editor.setAttribute("contenteditable", value);
    editor.append(content);
    row().append(editor);
    touch("touchstart", 30, 100, content);
    expect(touch("touchmove", 120, 100, content).defaultPrevented).toBe(false);
    touch("touchend", 120, 100, content);
    expect(reply).not.toHaveBeenCalled();
  });

  it("leaves a mouse or pen drag to its normal selection behavior", () => {
    draw();
    for (const pointerType of ["mouse", "pen"]) {
      for (const [type, clientX] of [["pointerdown", 30], ["pointermove", 120], ["pointerup", 120]] as const) {
        flushSync(() => body().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, clientX, clientY: 100 })));
      }
    }
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not start a swipe behind an open message menu", () => {
    draw();
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    touch("touchstart", 30, 100);
    expect(touch("touchmove", 120, 100).defaultPrevented).toBe(false);
    touch("touchend", 120, 100);
    expect(reply).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("does not animate the return when reduced motion is preferred", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    Object.defineProperty(media, "matches", { value: true });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    draw();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    touch("touchend", 120, 100);
    expect(reply).toHaveBeenCalledOnce();
    expect(row().style.transition).toBe("none");
  });

  it("restores the row's styles if it unmounts mid-gesture", () => {
    draw();
    const current = row();
    touch("touchstart", 30, 100);
    touch("touchmove", 120, 100);
    flushSync(() => root.render(null));
    expect(current.style.translate).toBe("");
    expect(current.style.transition).toBe("");
    expect(current.style.position).toBe("");
    expect(current.style.willChange).toBe("");
    expect(reply).not.toHaveBeenCalled();
  });
});
