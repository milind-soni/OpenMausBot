// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { replaceUrl } from "@/lib/replace-url";
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
/** The browser's history: one state per entry, and where the page is now. */
let entries: unknown[] = [null];
const pop = () => act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: entries[above] ?? null })); });
/** The phone's back button: the browser leaves the top entry, then tells the page. */
const pressBack = async () => {
  above = Math.max(0, above - 1);
  await pop();
};
/** The browser's Forward: back onto the entry above, if there is one. */
const pressForward = async () => {
  above = Math.min(entries.length - 1, above + 1);
  await pop();
};

beforeEach(async () => {
  above = 0;
  entries = [null];
  back.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window.history, "state", "get").mockImplementation(() => entries[above] ?? null);
  vi.spyOn(window.history, "replaceState").mockImplementation((state: unknown) => { entries[above] = state; });
  vi.spyOn(window.history, "pushState").mockImplementation((state: unknown) => {
    above += 1;
    entries = [...entries.slice(0, above), state];
  });
  vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
    above = Math.max(0, above + delta);
    queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate", { state: entries[above] ?? null })));
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

it("does not count Forward onto an entry it stepped back from as a back press", async () => {
  await act(async () => root.render(h(Stack)));
  await pressBack();
  expect(container.textContent).toBe("1");
  await pressForward();
  expect(back, "Forward is not a step back").toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("1");
  expect(above, "the entry Forward reached is taken away again").toBe(1);
  await pressBack();
  expect(back).toHaveBeenCalledTimes(2);
  expect(container.textContent, "the next back press still steps back").toBe("0");
});

it("still steps back once onto an entry whose state the app replaced", async () => {
  await act(async () => root.render(h(Stack)));
  entries[1] = null;
  await pressBack();
  expect(back).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("1");
});

it("keeps its place when the app changes the address, so Forward after Back is still not a back press", async () => {
  await act(async () => root.render(h(Stack)));
  replaceUrl("/?lang=fr");
  await pressBack();
  expect(back).toHaveBeenCalledTimes(1);
  await pressForward();
  expect(back, "Forward onto the changed entry is not a step back").toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("1");
});

it("takes away the entries a reload kept when nothing is open after it", async () => {
  entries = [{ ombPhoneBack: 0 }, { ombPhoneBack: 1 }, { ombPhoneBack: 2 }];
  above = 2;
  await show(true, 0);
  expect(window.history.go).toHaveBeenCalledWith(-2);
  expect(above, "back from here leaves the app").toBe(0);
  expect(back).not.toHaveBeenCalled();
});

it("keeps the entries a reload kept when the same steps are open again", async () => {
  entries = [{ ombPhoneBack: 0 }, { ombPhoneBack: 1 }];
  above = 1;
  await show(true, 1);
  expect(window.history.pushState).not.toHaveBeenCalled();
  expect(window.history.go).not.toHaveBeenCalled();
});

it("leaves the entry its own step back lands on marked for the step opened again meanwhile", async () => {
  const settle: Array<() => void> = [];
  vi.mocked(window.history.go).mockImplementation((delta = 0) => {
    settle.push(() => {
      above = Math.max(0, above + delta);
      window.dispatchEvent(new PopStateEvent("popstate", { state: entries[above] ?? null }));
    });
  });
  await show(true, 1);
  await show(true, 0);
  await show(true, 1);
  await act(async () => { for (const step of settle.splice(0)) step(); });
  expect(entries[above], "the entry the page is on is the open step's").toEqual({ ombPhoneBack: 1 });
  await pressBack();
  expect(back).toHaveBeenCalledTimes(1);
});

it("adds the reopened step's entry again when its own step back lands below it", async () => {
  const settle: Array<() => void> = [];
  vi.mocked(window.history.go).mockImplementation((delta = 0) => {
    // The browser picks where the traversal lands when it starts, before the reopened step's entry is added.
    const target = Math.max(0, above + delta);
    settle.push(() => {
      above = target;
      window.dispatchEvent(new PopStateEvent("popstate", { state: entries[above] ?? null }));
    });
  });
  await show(true, 1);
  await show(true, 0);
  await show(true, 1);
  await act(async () => { for (const step of settle.splice(0)) step(); });
  expect(entries[above], "the page is on the open step's entry again").toEqual({ ombPhoneBack: 1 });
  await pressBack();
  expect(back, "back closes the open step instead of leaving the app").toHaveBeenCalledTimes(1);
});
