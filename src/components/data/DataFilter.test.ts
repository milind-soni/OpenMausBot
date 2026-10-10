// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { DataFilter, type DataFilterValue } from "./DataFilter";

const columns = [{ name: "id", type: "BIGINT" }, { name: "display.name", type: "VARCHAR" }, { name: "created", type: "TIMESTAMP" }, { name: "active", type: "BOOLEAN" }];
const changed = vi.fn();
let host: HTMLDivElement;
let root: Root;
function Harness() {
  const [value, setValue] = useState<DataFilterValue>({ text: "" });
  return createElement(DataFilter, { columns, value, onChange: (next) => { changed(next); setValue(next); } });
}
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
const click = (name: string) => flushSync(() => button(name).click());
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const type = (label: string, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(label), text);
  flushSync(() => input(label).dispatchEvent(new Event("input", { bubbles: true })));
};
const key = (name: string) => flushSync(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
beforeEach(() => {
  setLocale("en");
  changed.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(Harness)));
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("Data filter popover", () => {
  it("starts with only a button and opens a searchable, typed column list", () => {
    expect(host.querySelector("input")).toBeNull();
    click("Filter");
    expect(document.activeElement).toBe(input("Search columns"));
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Filter rows");
    expect(button("id").querySelector(".lucide-hash")).not.toBeNull();
    expect(button("created").querySelector(".lucide-calendar-days")).not.toBeNull();
    expect(button("active").querySelector(".lucide-toggle-left")).not.toBeNull();
    type("Search columns", "DISPLAY");
    expect(button("display.name")).toBeDefined();
    expect(button("id")).toBeUndefined();
    expect(button("All columns")).toBeDefined();
    type("Search columns", "absent");
    expect(host.textContent).toContain("No matching columns");
  });

  it("selects a column, contains text, returns to all columns, and clears", () => {
    click("Filter"); click("display.name");
    expect(document.activeElement).toBe(input("Filter value"));
    expect(host.textContent).toContain("Contains");
    type("Filter value", "row");
    expect(changed).toHaveBeenLastCalledWith({ column: "display.name", text: "row" });
    expect(button("Filter").dataset.active).toBe("true");
    expect(button("Filter").textContent).toContain("display.name");
    click("Choose column"); click("All columns");
    expect(changed).toHaveBeenLastCalledWith({ text: "row", column: undefined });
    expect(input("Filter value").value).toBe("row");
    click("Clear filter");
    expect(changed).toHaveBeenLastCalledWith({ text: "" });
    expect(button("Filter").dataset.active).toBe("false");
    expect(document.activeElement).toBe(input("Search columns"));
  });

  it("navigates choices with arrows and returns focus on Escape", () => {
    click("Filter");
    key("ArrowDown"); expect(document.activeElement).toBe(button("All columns"));
    key("ArrowDown"); expect(document.activeElement).toBe(button("id"));
    key("ArrowUp"); expect(document.activeElement).toBe(button("All columns"));
    key("ArrowUp"); expect(document.activeElement).toBe(input("Search columns"));
    key("Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Filter"));
  });

  it("dismisses on an outside pointer without swallowing it", () => {
    click("Filter");
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    flushSync(() => document.body.dispatchEvent(event));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
