// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePhoneBack } from "./use-phone-back";

let root: Root;
let container: HTMLElement;
let above = 0;
const back = vi.fn();

function Shell({ enabled, steps }: { enabled: boolean; steps: number }) {
  usePhoneBack(enabled, steps, back);
  return null;
}

/** Two open steps that close one at a time, as the app's panel and list do. */
function Stack() {
  const [steps, setSteps] = useState(2);
  usePhoneBack(true, steps, () => { back(); setSteps((open) => open - 1); });
  return h("output", null, steps);
}

const show = (enabled: boolean, steps: number) => act(async () => root.render(h(Shell, { enabled, steps })));
const pop = () => act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
/** The phone's back button: the browser leaves the top entry, then tells the page. */
const pressBack = async () => {
  above = Math.max(0, above - 1);
  await pop();
};

beforeEach(async () => {
  above = 0;
  back.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window.history, "pushState").mockImplementation(() => { above += 1; });
  vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
    above = Math.max(0, above + delta);
    queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate")));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps one entry per step on a phone, and a back press steps back once", async () => {
  await act(async () => root.render(h(Stack)));
  expect(above).toBe(2);
  await pressBack();
  expect(back).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("1");
  expect(above, "the press used its own entry").toBe(1);
  await pressBack();
  expect(container.textContent).toBe("0");
  expect(above).toBe(0);
  expect(window.history.go, "no entry left over to take away").not.toHaveBeenCalled();
});

it("adds nothing and handles no back press on a wide layout", async () => {
  await show(false, 2);
  expect(window.history.pushState).not.toHaveBeenCalled();
  await pop();
  expect(back).not.toHaveBeenCalled();
});

it("takes the entry away when the step is closed in the app, without stepping back again", async () => {
  await show(true, 1);
  expect(above).toBe(1);
  await show(true, 0);
  expect(window.history.go).toHaveBeenCalledWith(-1);
  expect(above, "back from here leaves the app at once").toBe(0);
  expect(back, "the entry it took away is not a back press").not.toHaveBeenCalled();
});

it("puts the entry back when a press leaves the steps as they were", async () => {
  await show(true, 1);
  await pressBack();
  expect(back).toHaveBeenCalledTimes(1);
  expect(above).toBe(1);
});

it("takes every entry away when the window grows past the phone layout", async () => {
  await show(true, 2);
  await show(false, 2);
  expect(window.history.go).toHaveBeenCalledWith(-2);
  expect(above).toBe(0);
  await pop();
  expect(back).not.toHaveBeenCalled();
});
