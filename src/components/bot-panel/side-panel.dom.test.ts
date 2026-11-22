// @vitest-environment happy-dom
// A side panel's way out: the real panel goes at once (focus and keys with it), and an inert copy slides out after it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leaveSidePanel, sidePanelCls } from "./side-panel";

let row: HTMLDivElement;
let finish: () => void;
const animate = vi.fn(() => ({ finished: new Promise<void>((resolve) => { finish = resolve; }) }));

function panel(): HTMLElement {
  const aside = document.createElement("aside");
  aside.id = "bot-panel";
  aside.setAttribute("role", "dialog");
  aside.tabIndex = -1;
  aside.innerHTML = '<h2 id="bot-settings-title">Scout</h2><button type="button">Close</button>'
    + '<svg><defs><linearGradient id="mascot-grad"></linearGradient></defs></svg><iframe src="about:blank"></iframe>';
  aside.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
  row.append(document.createElement("main"), aside);
  return aside;
}
const copies = () => row.querySelectorAll<HTMLElement>("[data-side-panel-leaving]");

beforeEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  row = document.createElement("div");
  document.body.append(row);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
  animate.mockClear();
});
afterEach(() => {
  row.remove();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe("closing a side panel beside the chat", () => {
  it("leaves an inert, unnamed copy that slides out over its width and then goes", async () => {
    const aside = panel();
    leaveSidePanel(aside);
    aside.remove();
    await Promise.resolve();
    const [copy] = copies();
    expect(copy).toBeDefined();
    expect(copy!.getAttribute("aria-hidden")).toBe("true");
    expect(copy!.inert).toBe(true);
    expect(copy!.hasAttribute("role")).toBe(false);
    expect(copy!.hasAttribute("tabindex")).toBe(false);
    expect([...copy!.querySelectorAll("[id]")].map((node) => node.id)).toEqual(["mascot-grad"]);
    expect(copy!.querySelector("iframe")).toBeNull();
    expect(copy!.id).toBe("");
    expect(animate).toHaveBeenCalledWith(
      [{ marginInlineEnd: "0px", opacity: 1 }, { marginInlineEnd: "-320px", opacity: 0 }],
      expect.objectContaining({ duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }),
    );
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
  });

  it("leaves nothing with reduced motion, or when another bot's panel takes its place", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    const first = panel();
    leaveSidePanel(first);
    first.remove();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);

    delete document.documentElement.dataset.reducedMotion;
    const second = panel();
    leaveSidePanel(second);
    second.remove();
    row.append(document.createElement("aside"));
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
  });

  it("gives the room at once to a panel that arrives while the copy is still sliding out", async () => {
    const aside = panel();
    leaveSidePanel(aside);
    aside.remove();
    await Promise.resolve();
    expect(copies()).toHaveLength(1);
    row.append(document.createElement("aside"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copies()).toHaveLength(0);
  });
});

describe("the panel's way in", () => {
  it("slides in at its full width from md up, floating or beside the chat, and holds still with reduced motion", () => {
    for (const overlay of [false, true]) {
      const cls = sidePanelCls(overlay, true);
      expect(cls).toContain("md:animate-panel-beside-in");
      expect(cls).toContain("md:w-(--side-panel-w)");
      expect(cls).toContain("[--side-panel-w:320px]");
      expect(cls).toContain("motion-reduce:animate-none");
    }
    expect(sidePanelCls(false, false)).toContain("[--side-panel-w:min(420px,42vw)]");
  });
});
