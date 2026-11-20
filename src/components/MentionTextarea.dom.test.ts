// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MentionTextarea } from "./MentionTextarea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("draws its words in the field's own type and padding, so the caret stays at the end of the text", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  document.head.appendChild(document.createElement("style")).textContent =
    ".dock { font-size: 14px; line-height: 20px; padding: 4px 2px } .wide { font-size: 15px; line-height: 24px; padding: 4px }";
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const inputRef = createRef<HTMLTextAreaElement>();
  const show = (className: string) => act(async () => {
    root.render(createElement(MentionTextarea, { inputRef, peers: [], className, value: "asdasdasdasjashdjas", onChange: () => {} }));
  });
  const mirror = () => document.querySelector<HTMLElement>(".mention-editor-mirror")!.style;
  await show("dock");
  expect([mirror().fontSize, mirror().lineHeight, mirror().paddingLeft]).toEqual(["14px", "20px", "2px"]);
  await show("wide");
  expect([mirror().fontSize, mirror().lineHeight, mirror().paddingLeft], "and follows the field when its classes change").toEqual(["15px", "24px", "4px"]);
  act(() => root.unmount());
});

it("moves the caret and selection across a bot mention as a unit", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const inputRef = createRef<HTMLTextAreaElement>();
  act(() => root.render(createElement(MentionTextarea, {
    inputRef, value: "@Atlas hello", peers: [{ name: "Atlas", color: "purple" }], onChange: () => {},
  })));
  const input = inputRef.current!;
  input.setSelectionRange(0, 0);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  expect([input.selectionStart, input.selectionEnd]).toEqual([6, 6]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }));
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
  act(() => root.unmount());
});

it("opens only the bot under the pointer and preserves drag selection", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const inputRef = createRef<HTMLTextAreaElement>();
  const onOpenBot = vi.fn();
  act(() => root.render(createElement(MentionTextarea, {
    inputRef, value: "@Atlas hello", peers: [{ id: "atlas", name: "Atlas", color: "purple" }], onOpenBot, onChange: () => {},
  })));
  const mention = host.querySelector<HTMLElement>("[data-bot-mention]")!;
  vi.spyOn(mention, "getClientRects").mockReturnValue([new DOMRect(10, 10, 40, 20)] as unknown as DOMRectList);
  const move = (clientX: number) => inputRef.current!.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY: 20, bubbles: true }));
  move(30);
  expect(mention.hasAttribute("data-hovered")).toBe(true);
  move(55);
  expect(mention.hasAttribute("data-hovered")).toBe(false);
  const click = (clientX: number) => inputRef.current!.dispatchEvent(new MouseEvent("click", { clientX, clientY: 20, detail: 1, bubbles: true }));
  inputRef.current!.setSelectionRange(0, 6);
  click(30);
  expect(onOpenBot).not.toHaveBeenCalled();
  inputRef.current!.setSelectionRange(0, 0);
  click(55);
  expect(onOpenBot).not.toHaveBeenCalled();
  click(30);
  expect(onOpenBot).toHaveBeenCalledExactlyOnceWith("atlas");
  act(() => root.unmount());
});
