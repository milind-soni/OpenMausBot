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
