// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginBots } from "../../shared/logins";
import type { Bot } from "@/state/store";
import { LoginBotPicker } from "./LoginForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const bots = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `b${index + 1}`, name: `Sample Bot ${String(index + 1).padStart(3, "0")}`, color: "coral" })) as unknown as Bot[];
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('[data-bot-picker] [role="checkbox"]')];
const names = () => rows().map((row) => row.getAttribute("aria-label"));

async function show(value: LoginBots, list: Bot[], onChange = vi.fn()) {
  await act(async () => root.render(createElement(LoginBotPicker, { value, onChange, bots: list })));
  return onChange;
}

describe("the login bot picker", () => {
  it("lists a few bots plainly, with no search", async () => {
    await show([], bots(3));
    expect(names()).toEqual(["Sample Bot 001", "Sample Bot 002", "Sample Bot 003"]);
    expect(host.querySelector('input[type="search"]')).toBeNull();
  });

  it("finds a bot by name among many, says how many are chosen, and keeps the choice while searching", async () => {
    const onChange = await show(["b2", "b40"], bots(100));
    expect(host.querySelector("[data-bot-picker-count]")!.textContent).toBe("2 of 100 chosen");
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "bot 04");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names()).toEqual(["Sample Bot 040", "Sample Bot 041", "Sample Bot 042", "Sample Bot 043", "Sample Bot 044", "Sample Bot 045", "Sample Bot 046", "Sample Bot 047", "Sample Bot 048", "Sample Bot 049"]);
    expect(rows()[0]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => rows()[1]!.click());
    expect(onChange).toHaveBeenLastCalledWith(["b2", "b40", "b41"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "nobody");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("[data-bot-picker]")!.textContent).toContain("No bot by that name.");
  });
});
