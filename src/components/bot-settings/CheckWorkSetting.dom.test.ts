// @vitest-environment happy-dom
// Check before done in a bot's settings: one switch, off unless turned on, and who checks once it is on.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatched: [] as unknown[], bots: [] as Array<Partial<Bot>> }));
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: (action: unknown) => fixture.dispatched.push(action) }) };
});

const { CheckWorkSetting } = await import("./CheckWorkSetting");

let root: Root;
let host: HTMLElement;
const nib = (checkWork?: Bot["checkWork"]) => ({ id: "nib", name: "Nib", color: "blue", modelSelection: { instanceId: "claude", model: "opus" }, ...(checkWork !== undefined ? { checkWork } : {}) }) as unknown as Bot;
const render = (bot: Bot) => flushSync(() => root.render(createElement(CheckWorkSetting, { bot })));
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
const picker = () => host.querySelector<HTMLSelectElement>("select");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.dispatched = [];
  fixture.bots = [{ id: "nib", name: "Nib" }, { id: "vera", name: "Vera" }, { id: "old", name: "Old", hidden: true }];
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("Check before done", () => {
  it("is off with no picker until turned on, and says what it costs: up to 3 checks and 2 fixes per answer", () => {
    render(nib());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Check before done");
    expect(host.textContent).toContain("Another bot or AI checks each finished answer against your request before it counts as done: up to 3 checks and 2 fixes per answer, each a full AI turn.");
    expect(picker()).toBeNull();
    flushSync(() => toggle().click());
    expect(fixture.dispatched).toEqual([{ type: "updateBot", botId: "nib", patch: { checkWork: {} } }]);
  });

  it("offers every other visible bot, or a thread of its own on another AI, and turns off again", () => {
    render(nib({ checker: "vera" }));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect([...picker()!.options].map((option) => [option.value, option.text])).toEqual([["", "Its own thread on another AI"], ["vera", "Vera"]]);
    expect(picker()!.value).toBe("vera");
    picker()!.value = "";
    flushSync(() => picker()!.dispatchEvent(new Event("change", { bubbles: true })));
    flushSync(() => toggle().click());
    expect(fixture.dispatched).toEqual([
      { type: "updateBot", botId: "nib", patch: { checkWork: {} } },
      { type: "updateBot", botId: "nib", patch: { checkWork: null } },
    ]);
  });
});
