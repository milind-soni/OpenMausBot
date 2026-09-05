import { describe, expect, it, vi } from "vitest";

import { installChatHotkeys, type KeyTarget } from "./chat-hotkeys";

function fakeTarget() {
  const handlers: Array<(event: KeyboardEvent) => void> = [];
  const target: KeyTarget = {
    addEventListener: (_type, handler) => {
      handlers.push(handler);
    },
    removeEventListener: (_type, handler) => {
      const at = handlers.indexOf(handler);
      if (at >= 0) handlers.splice(at, 1);
    },
  };
  const press = (event: Partial<KeyboardEvent>) => {
    // copy: a handler may remove itself while we are dispatching
    const snapshot = handlers.slice();
    for (const handler of snapshot) handler(event as KeyboardEvent);
  };
  return { target, handlers, press };
}

const key = (over: Partial<KeyboardEvent>) =>
  ({ key: "a", metaKey: false, ctrlKey: false, preventDefault: () => {}, target: null, ...over }) as
    Partial<KeyboardEvent>;

describe("installChatHotkeys", () => {
  it("registers nothing at all when the chat is not active", () => {
    const { target, handlers } = fakeTarget();
    const onFind = vi.fn();
    const stop = installChatHotkeys(target, { active: false, onFind, onScrollAway: vi.fn() });
    expect(handlers).toHaveLength(0);
    stop();
    expect(onFind).not.toHaveBeenCalled();
  });

  it("opens find on the platform shortcut when active", () => {
    const { target, press } = fakeTarget();
    const onFind = vi.fn();
    installChatHotkeys(target, { active: true, onFind, onScrollAway: vi.fn() });
    press(key({ key: "f", metaKey: true }));
    press(key({ key: "F", ctrlKey: true }));
    expect(onFind).toHaveBeenCalledTimes(2);
  });

  it("does not open find without the modifier", () => {
    const { target, press } = fakeTarget();
    const onFind = vi.fn();
    installChatHotkeys(target, { active: true, onFind, onScrollAway: vi.fn() });
    press(key({ key: "f" }));
    expect(onFind).not.toHaveBeenCalled();
  });

  it("treats upward keys as a scroll gesture that breaks follow", () => {
    const { target, press } = fakeTarget();
    const onScrollAway = vi.fn();
    installChatHotkeys(target, { active: true, onFind: vi.fn(), onScrollAway });
    press(key({ key: "PageUp" }));
    press(key({ key: "Home" }));
    press(key({ key: "ArrowUp" }));
    expect(onScrollAway).toHaveBeenCalledTimes(3);
  });

  it("leaves ArrowUp alone while typing — there it edits, not scrolls", () => {
    const { target, press } = fakeTarget();
    const onScrollAway = vi.fn();
    installChatHotkeys(target, { active: true, onFind: vi.fn(), onScrollAway });
    press(key({ key: "ArrowUp", target: { tagName: "TEXTAREA" } as unknown as EventTarget }));
    press(key({ key: "ArrowUp", target: { tagName: "INPUT" } as unknown as EventTarget }));
    expect(onScrollAway).not.toHaveBeenCalled();
    // PageUp still counts: it is a scroll wherever the caret is
    press(key({ key: "PageUp", target: { tagName: "TEXTAREA" } as unknown as EventTarget }));
    expect(onScrollAway).toHaveBeenCalledTimes(1);
  });

  it("removes every handler it added on cleanup", () => {
    const { target, handlers, press } = fakeTarget();
    const onFind = vi.fn();
    const stop = installChatHotkeys(target, { active: true, onFind, onScrollAway: vi.fn() });
    expect(handlers.length).toBeGreaterThan(0);
    stop();
    expect(handlers).toHaveLength(0);
    press(key({ key: "f", metaKey: true }));
    expect(onFind).not.toHaveBeenCalled();
  });

  it("registers one handler per chat, so N cards mean N handlers and no more", () => {
    const { target, handlers } = fakeTarget();
    const stops = [0, 1, 2].map(() =>
      installChatHotkeys(target, { active: true, onFind: vi.fn(), onScrollAway: vi.fn() }),
    );
    expect(handlers).toHaveLength(3);
    for (const stop of stops) stop();
    expect(handlers).toHaveLength(0);
  });
});
