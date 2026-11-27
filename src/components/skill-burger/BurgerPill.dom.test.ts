// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Sheen, WithCount } from "./BurgerPill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("draws the sheen's copy of a counting label over the label itself, not beside or below it", async () => {
  await act(async () => root.render(createElement(Sheen, { text: "Cooking… 12", children: createElement(WithCount, { template: "Cooking… {count}", count: 12 }) })));
  const box = host.querySelector<HTMLElement>(".thinking-shimmer")!;
  const copy = box.querySelector<HTMLElement>(".thinking-sheen [data-text]")!;
  const count = box.querySelector<HTMLElement>(".burger-tick")!;
  expect(copy.dataset.text).toBe(box.firstChild!.textContent! + count.textContent);
  // The copy is drawn from its own box's top with the same line height, so the box must be a block, not an inline span
  // whose box is shorter than its line.
  expect(box.classList).toContain("block");
  // The count's digits are fixed width; the copy inherits its digits from the box, so it must use the same ones.
  expect(count.classList).toContain("tabular-nums");
  expect(box.classList).toContain("tabular-nums");
});
