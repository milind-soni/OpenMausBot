// @vitest-environment happy-dom
// The "…" handle. A click holds the tray out, the one hover already opened
// included, and marks the handle. A second click tucks it, and it stays in
// under the cursor until the pointer leaves. A tap opens it and a second tap
// tucks it. From the keyboard the handle flips what focus already shows. A
// held tray lets go on Escape or a press outside, so trays never pile up
// down the transcript.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MessageActions } from "./MessageActions";

let host: HTMLDivElement;
let root: Root;

const tray = () => host.querySelector<HTMLElement>('[data-testid="message-actions"]')!;
const handle = () => tray().querySelector<HTMLButtonElement>('button[aria-label="Message actions"]')!;
const expanded = () => handle().getAttribute("aria-expanded");
const held = () => tray().dataset.open === "true";
const marked = () => handle().className.includes("text-accent");
// hover and keyboard focus reveal the tray through these classes; a tucked
// tray drops them so it stays in while the pointer is still on the handle
const revealsOnHover = () => tray().children[1]!.className.includes("group-hover/actions:grid-cols-[1fr]");

const pointer = (type: string, target: Element, pointerType: string, relatedTarget: Element | null = null) =>
  act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget }));
  });
const enter = () => pointer("pointerover", handle(), "mouse");
const leave = () => pointer("pointerout", handle(), "mouse", document.body);
// a mouse or a tap clicks with detail 1, Enter or Space with detail 0
const press = (pointerType: string) =>
  act(async () => {
    handle().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }));
    handle().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

async function render(forceOpen = false) {
  await act(async () => {
    root.render(
      createElement(MessageActions, {
        side: "bot",
        forceOpen,
        children: createElement("button", { type: "button" }, "copy"),
      }),
    );
  });
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("MessageActions handle", () => {
  it("holds a hover-opened tray on the first click and tucks it on the second", async () => {
    await render();
    await enter();
    expect(expanded()).toBe("true");
    expect(marked()).toBe(false);

    await press("mouse");
    expect(held()).toBe(true);
    expect(marked()).toBe(true);
    expect(expanded()).toBe("true");

    await leave();
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");

    await enter();
    await press("mouse");
    expect(held()).toBe(false);
    expect(marked()).toBe(false);
    expect(expanded()).toBe("false");
    // still under the cursor, so hover must not bring it straight back
    expect(revealsOnHover()).toBe(false);
  });

  it("flips what keyboard focus shows on Enter", async () => {
    await render();
    await act(async () => {
      handle().focus();
    });
    // Enter or Space fires click with no pointerdown
    await act(async () => handle().click());
    expect(held()).toBe(false);
    expect(revealsOnHover()).toBe(false);
    await act(async () => handle().click());
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");
  });

  it("hovers open again once the pointer leaves a tucked tray", async () => {
    await render();
    await enter();
    await press("mouse");
    await press("mouse");
    expect(revealsOnHover()).toBe(false);
    await leave();
    expect(revealsOnHover()).toBe(true);
    await enter();
    expect(expanded()).toBe("true");
  });

  it("treats Enter after a press dragged off the handle as the keyboard", async () => {
    await render();
    await act(async () => {
      handle().focus();
    });
    // pointerdown with no click: the press ended off the handle
    await pointer("pointerdown", handle(), "mouse");
    await act(async () => {
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      handle().click();
    });
    expect(held()).toBe(false);
    expect(revealsOnHover()).toBe(false);
  });

  it("hovers open again after Escape closed a held tray from away", async () => {
    await render();
    await enter();
    await press("mouse");
    await leave();
    // the click left focus on the handle, so Escape reaches the tray itself
    await act(async () => {
      handle().focus();
    });
    await act(async () => {
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(held()).toBe(false);
    expect(revealsOnHover()).toBe(false);
    await enter();
    expect(revealsOnHover()).toBe(true);
    expect(expanded()).toBe("true");
  });

  it("opens on a tap and tucks on the next tap", async () => {
    await render();
    await press("touch");
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");
    await press("touch");
    expect(held()).toBe(false);
    expect(expanded()).toBe("false");
  });

  it("lets go of a held tray on a press outside or on Escape", async () => {
    await render();
    await press("touch");
    await pointer("pointerdown", document.body, "mouse");
    expect(held()).toBe(false);
    expect(expanded()).toBe("false");

    await press("touch");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(held()).toBe(false);
  });

  it("keeps a tray that must stay reachable out whatever the handle does", async () => {
    await render(true);
    await enter();
    await press("mouse");
    await press("mouse");
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");
    expect(marked()).toBe(false);
  });
});
