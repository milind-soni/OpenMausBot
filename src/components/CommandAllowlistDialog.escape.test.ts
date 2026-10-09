// @vitest-environment happy-dom
// Escape has to close this dialog when focus never entered it. Static markup
// does not run the listener, so this mounts the dialog and presses the key.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: [] } }),
  api: () => new Promise(() => {}),
}));

import { CommandAllowlistDialog } from "./CommandAllowlistDialog";

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe("CommandAllowlistDialog Escape", () => {
  let root: Root | undefined;
  const added: HTMLElement[] = [];

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = undefined;
    for (const node of added) node.remove();
    added.length = 0;
  });

  function open(onClose: () => void) {
    const opener = document.createElement("button");
    opener.textContent = "Manage command allowlist";
    document.body.append(opener);
    added.push(opener);
    opener.focus();
    const container = document.createElement("div");
    document.body.append(container);
    added.push(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(createElement(CommandAllowlistDialog, { botId: "bot-1", botName: "Scout", onClose }));
    });
    opener.focus();
    return opener;
  }

  it("closes when focus is outside the dialog and does not pass Escape on", () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    const opener = open(onClose);
    expect(document.activeElement).toBe(opener);
    expect(document.body.textContent).toContain("Command allowlist");

    const event = press("Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();

    onClose.mockClear();
    flushSync(() => root!.unmount());
    root = undefined;
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    window.removeEventListener("keydown", behind);
  });

  it("leaves Escape alone while composing or once another layer has handled it", () => {
    const onClose = vi.fn();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    open(onClose);

    const composing = press("Escape", { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledOnce();
    press("Enter");
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);

    flushSync(() => root!.unmount());
    root = undefined;
    const claim = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", claim, true);
    open(onClose);
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener("keydown", claim, true);
  });
});
