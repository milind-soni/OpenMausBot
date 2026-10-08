// @vitest-environment happy-dom
// The "…" handle flips what is on screen. A mouse or a keyboard reaches it
// with the tray already out, so a click tucks it back and a second click
// holds it out after the pointer leaves. A tap opens it and a second tap
// tucks it. A held tray lets go on Escape or a press outside, so trays never
// pile up down the transcript.
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
// hover and keyboard focus reveal the tray through these classes; a tucked
// tray drops them so it stays in while the pointer is still on the handle
const revealsOnHover = () => tray().children[1]!.className.includes("group-hover/actions:grid-cols-[1fr]");

const pointer = (type: string, target: Element, pointerType: string, relatedTarget: Element | null = null) =>
  act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget }));
  });
const enter = () => pointer("pointerover", handle(), "mouse");
const leave = () => pointer("pointerout", handle(), "mouse", document.body);
const press = (pointerType: string) =>
  act(async () => {
    handle().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }));
    handle().click();
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
  it("tucks a hover-opened tray on click and holds it out on the next click", async () => {
    await render();
    await enter();
    expect(expanded()).toBe("true");

    await press("mouse");
    expect(expanded()).toBe("false");
    expect(revealsOnHover()).toBe(false);

    await press("mouse");
    expect(expanded()).toBe("true");
    expect(held()).toBe(true);

    await leave();
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");
  });

  it("hovers open again once the pointer leaves a tucked tray", async () => {
    await render();
    await enter();
    await press("mouse");
    await leave();
    expect(revealsOnHover()).toBe(true);
    await enter();
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
    expect(held()).toBe(true);
    expect(expanded()).toBe("true");
  });
});
