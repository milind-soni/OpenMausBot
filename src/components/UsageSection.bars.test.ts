// @vitest-environment happy-dom
// The Usage page bars: a group's bar is its models stacked in their own colours,
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

const render = (groupBy: "bot" | "model" | "day", groups: ReturnType<typeof group>[]) => flushSync(() => {
  root.render(createElement(GroupBars, { groupBy, groups: groups as never }));
});

const slices = () => [...host.querySelectorAll<HTMLElement>("span[data-model-color]")];

describe("Usage page bars", () => {
  it("stacks a bot's models into one bar, each slice in the model's own colour and share", () => {
    render("bot", [group({
      segments: [
        group({ key: "model:codex/gpt-6-astra", label: "gpt-6-astra", input: 21_341, output: 298 }),
        group({ key: "model:opencodeGo/opencode-go/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", input: 11_428, output: 846 }),
      ],
    })]);
    const painted = slices();
    expect(painted).toHaveLength(2);
    expect(Number.parseFloat(painted[0]!.style.width)).toBeCloseTo(63.8, 1);
    expect(Number.parseFloat(painted[1]!.style.width)).toBeCloseTo(36.2, 1);
    expect(painted[0]!.style.backgroundColor).toBeTruthy();
    expect(painted[0]!.style.backgroundColor).not.toBe(painted[1]!.style.backgroundColor);
    expect(painted[0]!.title).toContain("gpt-6-astra");
    expect(painted[0]!.title).toContain("21.6k");
    expect(painted[0]!.title).toContain("64%");
    expect(painted[1]!.title).toContain("deepseek-v4.1-flash");
    expect(painted[1]!.title).toContain("36%");
  });

  it("draws the server's additive bar total instead of a clamped aggregate", () => {
    render("bot", [group({ input: 600, cachedInput: 250, output: 60, barTokens: 460 })]);
    expect(host.textContent).toContain("460");
    expect(host.textContent).not.toContain("410");
  });

  it("keeps one solid slice when a bot used a single model, and repeats its colour as the model swatch", () => {
    const segments = [group({ key: "model:codex/gpt-6-astra", label: "gpt-6-astra" })];
    render("bot", [group({ segments })]);
    expect(slices()).toHaveLength(1);
    expect(slices()[0]!.style.width).toBe("100%");

    render("model", segments);
    const swatch = slices()[0]!;
    expect(swatch.style.backgroundColor).toBeTruthy();
    expect(host.textContent).toContain("gpt-6-astra");
  });

  it("stacks any grouping the bar shows, not only bots", () => {
    render("day", [group({
      key: "day:2026-11-06",
      label: "2026-11-06",
      segments: [
        group({ key: "model:codex/gpt-6-astra", label: "gpt-6-astra", input: 700, output: 100 }),
        group({ key: "model:opencodeGo/opencode-go/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", input: 300, output: 100 }),
      ],
    })]);
    expect(host.textContent).toContain("2026-11-06");
    expect(slices()).toHaveLength(2);
    expect(slices()[0]!.title).toContain("gpt-6-astra");
    expect(slices()[1]!.title).toContain("deepseek-v4.1-flash");
  });

  it("leaves a group without segments on the app's accent bar", () => {
    render("bot", [group({})]);
    expect(slices()).toHaveLength(0);
    expect(host.querySelector(".bg-accent\\/70")).not.toBeNull();
  });
});
