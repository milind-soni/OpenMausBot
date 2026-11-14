// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionSelect } from "./DecisionSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const selected = vi.fn();
const options = [
  { value: "jev", label: "TypeSafe Jev" },
  { value: "gemini", label: "Gemini Decision 1" },
  { value: "openrouter", label: "OpenRouter", disabled: true },
];
type Props = Parameters<typeof DecisionSelect>[0];
function Harness(props: Partial<Props>) {
  const [value, setValue] = useState("gemini");
  return createElement(DecisionSelect, { value, options, onChange: (next) => { selected(next); setValue(next); }, "aria-label": "Decision provider", "data-testid": "provider", ...props });
}
const trigger = () => host.querySelector<HTMLButtonElement>("button")!;
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const rows = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const mount = (props: Partial<Props> = {}) => act(async () => root.render(createElement(Harness, props)));
const press = (element: Element, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  selected.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
});

describe("the themed decision dropdown", () => {
  it("opens a themed floating menu with the current selection checked", async () => {
    await mount();
    expect(host.querySelector("select")).toBeNull();
    expect(trigger().textContent).toBe("Gemini Decision 1");
    await act(async () => trigger().click());
    expect(menu()!.parentElement).toBe(document.body);
    expect(menu()!.style.position).toBe("fixed");
    expect(menu()!.className).toContain("bg-menu");
    expect(rows().map((row) => row.textContent)).toEqual(["TypeSafe Jev", "Gemini Decision 1", "OpenRouter"]);
    expect(rows()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(rows()[2]!.disabled).toBe(true);
    await act(async () => rows()[0]!.click());
    expect(selected).toHaveBeenCalledWith("jev");
    expect(menu()).toBeNull();
    expect(trigger().textContent).toBe("TypeSafe Jev");
    expect(document.activeElement).toBe(trigger());
  });

  it("supports arrows, skips unavailable choices and dismisses with Escape", async () => {
    await mount();
    trigger().focus();
    await press(trigger(), "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1]!, "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0]!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(selected).not.toHaveBeenCalled();
  });

  it("closes on an outside click and does not open while disabled", async () => {
    await mount();
    await act(async () => trigger().click());
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();
    await mount({ disabled: true });
    expect(trigger().matches(":disabled")).toBe(true);
    await act(async () => trigger().click());
    expect(menu()).toBeNull();
  });
});
