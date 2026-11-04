// @vitest-environment happy-dom
// The Usage page bars: a bot's bar is its models stacked in their own colours,
// and the model view repeats those colours as a swatch beside the name.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const scout: Bot = {
  id: "b1", threadId: "t1", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
};

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { bots: [scout], instances: [] }, dispatch: vi.fn() }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const { GroupBars } = await import("./UsageSection");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const group = (over: Record<string, unknown>) => ({
  key: "bot:b1", label: "Scout", turns: 3, input: 900, output: 300, cachedInput: 0, costUsd: 0.5, ...over,
});

const render = (groupBy: "bot" | "model", groups: ReturnType<typeof group>[]) => flushSync(() => {
  root.render(createElement(GroupBars, { groupBy, groups: groups as never }));
});

describe("Usage page bars", () => {
  it("stacks a bot's models into one bar, each slice in the model's own colour", () => {
    render("bot", [group({
      segments: [
        group({ key: "model:codex/gpt-6.1-sol", label: "gpt-6.1-sol", input: 900, output: 300 }),
        group({ key: "model:opencodeGo/opencode-go/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", input: 300, output: 100 }),
      ],
    })]);
    const slices = [...host.querySelectorAll<HTMLElement>("span[title]")];
    expect(slices).toHaveLength(2);
    expect(slices[0]!.style.width).toBe("75%");
    expect(slices[1]!.style.width).toBe("25%");
    expect(slices[0]!.style.backgroundColor).toBeTruthy();
    expect(slices[0]!.style.backgroundColor).not.toBe(slices[1]!.style.backgroundColor);
    expect(slices[0]!.title).toContain("gpt-6.1-sol");
    expect(slices[0]!.title).toContain("75%");
  });

  it("keeps one solid slice when a bot used a single model, and repeats its colour as the model swatch", () => {
    const segments = [group({ key: "model:codex/gpt-6.1-sol", label: "gpt-6.1-sol" })];
    render("bot", [group({ segments })]);
    expect(host.querySelectorAll("span[title]")).toHaveLength(1);

    render("model", segments);
    const swatch = host.querySelector<HTMLElement>('li span[style*="background-color"]')!;
    expect(swatch.style.backgroundColor).toBeTruthy();
    expect(host.textContent).toContain("gpt-6.1-sol");
  });
});
