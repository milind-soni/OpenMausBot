// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { parseGithubUrl } from "@/lib/github-refs";
import { renderToStaticMarkup } from "react-dom/server";
import { HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, LinkHoverCard, LinkPreviewCard, LONG_PRESS_MS, placeCard } from "./LinkHoverCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (left: number, top: number, width = 60, height = 20) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe("placeCard", () => {
  const view = { width: 800, height: 600 };
  const card = { width: 320, height: 120 };
  it("sits above the link, centered on it", () => {
    expect(placeCard(box(300, 400), card, view)).toEqual({ left: 170, top: 272, side: "above" });
  });
  it("flips below when there is no room above", () => {
    expect(placeCard(box(300, 40), card, view)).toEqual({ left: 170, top: 68, side: "below" });
  });
  it("stays inside the window at either edge", () => {
    expect(placeCard(box(0, 400), card, view).left).toBe(8);
    expect(placeCard(box(780, 400, 20), card, view).left).toBe(800 - 320 - 8);
    expect(placeCard(box(10, 400), { width: 400, height: 120 }, { width: 380, height: 600 }).left).toBe(8);
  });
});

describe("LinkHoverCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  const href = "https://github.com/milind-soni/OpenMausBot/pull/2547";
  const link = () => host.querySelector("a")!;
  const card = () => document.querySelector<HTMLElement>("[data-link-preview]");
  const fire = (target: EventTarget, type: string, init: PointerEventInit = {}) =>
    act(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init })); });

  beforeEach(() => {
    vi.useFakeTimers();
    setLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(createElement(LinkHoverCard, { href, github: parseGithubUrl(href), children: (anchor) => createElement("a", { ...anchor, href }, "#2547") })));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("opens after a short rest and describes the link", () => {
    fire(link(), "pointerover");
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 50); });
    expect(card()).toBeNull();
    act(() => { vi.advanceTimersByTime(50); });
    expect(card()?.getAttribute("role")).toBe("tooltip");
    expect(card()?.textContent).toContain("Pull request #2547");
    expect(card()?.textContent).toContain("milind-soni/OpenMausBot");
    expect(card()?.textContent).toContain("github.com");
    expect(link().getAttribute("aria-describedby")).toBe(card()?.id);
  });

  it("stays open while the pointer moves into the card, and closes after leaving it", () => {
    fire(link(), "pointerover");
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS); });
    fire(link(), "pointerout", { relatedTarget: card() });
    fire(card()!, "pointerover", { relatedTarget: link() });
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS * 2); });
    expect(card()).not.toBeNull();
    fire(card()!, "pointerout", { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS); });
    expect(card()).toBeNull();
  });

  it("never opens for a pointer that only passes over", () => {
    fire(link(), "pointerover");
    fire(link(), "pointerout", { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS * 2); });
    expect(card()).toBeNull();
  });

  it("opens on a long press and keeps the link from opening", () => {
    fire(link(), "pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(card()).not.toBeNull();
    fire(link(), "pointerup", { pointerType: "touch" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link().dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
  });

  it("lets a quick tap open the link", () => {
    fire(link(), "pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    fire(link(), "pointerup", { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(card()).toBeNull();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link().dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
  });

  it("closes on Escape", () => {
    fire(link(), "pointerover");
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS); });
    act(() => { link().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(card()).toBeNull();
  });
});

describe("LinkPreviewCard", () => {
  it("names a plain link by its site and shows the readable path", () => {
    setLocale("en");
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { href: "https://www.example.com/docs/caf%C3%A9?x=1" }));
    expect(html).toContain(">example.com</div>");
    expect(html).toContain("/docs/café?x=1");
    expect(html).toContain("rounded-3xl bg-composer");
  });

  it("titles a commit by its short sha", () => {
    const href = "https://github.com/a/app/commit/68189cf0a1b2";
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { href, github: parseGithubUrl(href) }));
    expect(html).toContain("Commit 68189cf");
    expect(html).toContain("a/app");
  });
});
