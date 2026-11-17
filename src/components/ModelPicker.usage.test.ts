// @vitest-environment happy-dom
// The usage bars inside the model button, in both modes, in the narrow header and in the bot panel, and the same rows
// at the top of the open model menu, under a ring for every connected AI that reports usage.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineLimit } from "../../shared/limit-reset";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  advanced: false,
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: [claude], bots: [], modelVariantSessions: {}, config: {} },
    dispatch: vi.fn(),
    refreshInstances: () => Promise.resolve(),
    refreshModels: () => Promise.resolve(),
  }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const claude: InstanceInfo = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "2.1.300", authenticated: true },
  models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }] },
};
const scout: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
};
const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const RESET = new Date(2026, 9, 19, 15, 40, 0).getTime();
const usage = (used: number, blocked = false): EngineLimit => ({
  engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: used, resetsAt: RESET, blocked,
  windows: [{ window: "5-hour", usedPercent: used, resetsAt: RESET }, { window: "weekly", usedPercent: 12, resetsAt: RESET + 96 * 3_600_000 }],
});

const { ModelPicker } = await import("./ModelPicker");
const limits = await import("@/lib/limit-resets");

let root: Root;
let host: HTMLDivElement;
const render = (contained = false) => flushSync(() => root.render(createElement(ModelPicker, { bot: scout, threadId: scout.threadId, contained })));
const chip = () => host.querySelector<HTMLButtonElement>('[data-tour="model"]')!;
const remember = (engines: EngineLimit[]) => flushSync(() => {
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines }));
  limits.rememberLimits({ checkedAt: NOW, engines });
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fixture.advanced = false;
  remember([usage(38)]);
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the model button's usage bars", () => {
  for (const advanced of [false, true]) {
    it(`sit just after the model name and before the chevron, and name the usage for a screen reader (${advanced ? "Advanced" : "Simple"})`, () => {
      fixture.advanced = advanced;
      render();
      const parts = [...chip().querySelectorAll("[data-usage-bars], svg.lucide-chevron-down")];
      expect(parts.map((part) => part.hasAttribute("data-usage-bars") ? "bars" : "chevron")).toEqual(["bars", "chevron"]);
      expect(chip().textContent).toContain("Claude Sonnet 5");
      expect(chip().textContent?.indexOf("Claude Sonnet 5")).toBeLessThan(chip().textContent!.indexOf("Claude: 38% used, resets 3:40 PM"));
    });
  }

  for (const advanced of [false, true]) {
    it(`follow the bot's own engine when two engines report usage (${advanced ? "Advanced" : "Simple"})`, () => {
      fixture.advanced = advanced;
      const codex: EngineLimit = { ...usage(91), engine: "codex", name: "Codex", driver: "codex", windows: [{ window: "weekly", usedPercent: 91, resetsAt: RESET }] };
      remember([usage(38), codex]);
      flushSync(() => root.render(createElement(ModelPicker, { bot: { ...scout, modelSelection: { instanceId: "codex", model: "gpt-5" } }, threadId: scout.threadId })));
      expect(chip().querySelector("[data-usage-bars]")?.getAttribute("data-usage-bars")).toBe("near");
      expect(chip().textContent).toContain("Codex: 91% used");
      expect(chip().textContent).not.toContain("Claude: 38% used");
      render(true);
      expect(chip().querySelector("[data-usage-bars]")?.getAttribute("data-usage-bars")).toBe("fine");
      expect(chip().textContent).toContain("Claude: 38% used");
    });
  }

  it("draw nothing for an engine that reports no usage", () => {
    remember([{ ...usage(0), usedPercent: null, window: null, resetsAt: null, windows: [] }]);
    render();
    expect(chip().querySelector("[data-usage-bars]")).toBeNull();
    expect(chip().textContent).toBe("Claude Sonnet 5");
  });

  it("hide in the narrow header while there is room, and widen its square to warn", () => {
    fixture.advanced = true;
    render();
    expect(chip().className).toContain("@max-4xl/chathead:has-[[data-usage-warn]]:w-auto");
    expect(chip().querySelector("[data-usage-glyph]")?.getAttribute("class")).toContain("@max-4xl/chathead:hidden");
    remember([usage(95)]);
    expect(chip().querySelector("[data-usage-warn]")).not.toBeNull();
    expect(chip().querySelector("[data-usage-glyph]")?.getAttribute("class")).not.toContain("@max-4xl/chathead:hidden");
  });

  it("keep showing in the bot panel, which has no narrow header", () => {
    fixture.advanced = true;
    render(true);
    expect(chip().className).not.toContain("has-[[data-usage-warn]]");
    expect(chip().querySelector("[data-usage-glyph]")?.getAttribute("class")).not.toContain("@max-4xl/chathead:hidden");
  });

  for (const advanced of [false, true]) {
    it(`open as rows at the top of the model menu, for keyboard and touch (${advanced ? "Advanced" : "Simple"})`, async () => {
      fixture.advanced = advanced;
      render();
      flushSync(() => chip().click());
      await settle();
      const menu = document.querySelector<HTMLElement>("[data-model-picker-content]")!;
      expect(menu.firstElementChild?.hasAttribute("data-usage-menu")).toBe(true);
      expect([...menu.querySelectorAll("[data-usage-row]")].map((row) => row.getAttribute("data-usage-row"))).toEqual(["5-hour", "weekly"]);
      flushSync(() => chip().querySelector("[data-usage-bars]")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(document.querySelector("[data-usage-card]")).toBeNull();
    });
  }

  it("leave the menu without rows for an engine with no usage", async () => {
    remember([]);
    render();
    flushSync(() => chip().click());
    await settle();
    expect(document.querySelector("[data-usage-menu]")).toBeNull();
  });
});

describe("the model menu's usage rings", () => {
  const other = (engine: string, name: string, used: number, blocked = false): EngineLimit =>
    ({ ...usage(used, blocked), engine, name, driver: "codex", window: "weekly", windows: [{ window: "weekly", usedPercent: used, resetsAt: RESET }] });
  const openMenu = async () => {
    render();
    flushSync(() => chip().click());
    await settle();
    return document.querySelector<HTMLElement>("[data-model-picker-content]")!;
  };
  const rings = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>("[data-usage-engine]")];
  const shownRows = (menu: HTMLElement) => [...menu.querySelectorAll("[data-usage-row]")].map((row) => row.getAttribute("data-usage-row"));

  for (const advanced of [false, true]) {
    it(`show one ring for every AI that reports usage, coloured by how much is left (${advanced ? "Advanced" : "Simple"})`, async () => {
      fixture.advanced = advanced;
      remember([usage(38), other("codex", "Codex", 91), other("gemini", "Gemini", 100, true), { ...other("local", "Local", 0), usedPercent: null, windows: [] }]);
      const menu = await openMenu();
      expect(menu.firstElementChild?.hasAttribute("data-usage-menu")).toBe(true);
      expect(rings(menu).map((ring) => [ring.dataset.usageEngine, ring.textContent, ring.querySelector("[data-usage-ring]")?.getAttribute("data-usage-ring")]))
        .toEqual([["claude", "Claude", "fine"], ["codex", "Codex", "near"], ["gemini", "Gemini", "out"]]);
      expect(rings(menu).map((ring) => ring.querySelector("[data-usage-ring]")?.getAttribute("class")?.match(/text-\w+/)?.[0])).toEqual(["text-success", "text-warning", "text-danger"]);
      expect(rings(menu).map((ring) => ring.getAttribute("aria-label"))).toEqual(["Claude: 38% used, resets 3:40 PM", "Codex: 91% used, resets 3:40 PM", "Gemini: at its limit, resets 3:40 PM"]);
    });
  }

  it("start on the bot's own AI, and show another AI's rows when its ring is pressed", async () => {
    remember([usage(38), other("codex", "Codex", 91)]);
    const menu = await openMenu();
    expect(rings(menu).map((ring) => ring.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(shownRows(menu)).toEqual(["5-hour", "weekly"]);
    flushSync(() => rings(menu)[1]!.click());
    expect(rings(menu).map((ring) => ring.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(shownRows(menu)).toEqual(["weekly"]);
    expect(menu.querySelector("[data-usage-rows]")?.textContent).toContain("Codex usage");
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("go back to the bot's own AI when the pressed AI stops reporting usage", async () => {
    remember([usage(38), other("codex", "Codex", 91)]);
    const menu = await openMenu();
    flushSync(() => rings(menu)[1]!.click());
    expect(shownRows(menu)).toEqual(["weekly"]);
    remember([usage(38)]);
    expect(menu.querySelector("[data-usage-rings]")).toBeNull();
    expect(shownRows(menu)).toEqual(["5-hour", "weekly"]);
    remember([usage(38), other("gemini", "Gemini", 50)]);
    expect(rings(menu).map((ring) => ring.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(shownRows(menu)).toEqual(["5-hour", "weekly"]);
  });

  it("draw less of the ring as the usage runs down, and none at the limit", async () => {
    remember([usage(25), other("codex", "Codex", 75), other("gemini", "Gemini", 100, true)]);
    const menu = await openMenu();
    const arcs = rings(menu).map((ring) => ring.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")?.split(" ").map(Number));
    expect(arcs[0]![0]! / arcs[0]![1]!).toBeCloseTo(0.75);
    expect(arcs[1]![0]! / arcs[1]![1]!).toBeCloseTo(0.25);
    expect(arcs[2]).toBeUndefined();
    expect(rings(menu)[2]!.querySelector("path")).not.toBeNull();
  });

  it("stay away while the bot's own AI is the only one that reports usage", async () => {
    const menu = await openMenu();
    expect(menu.querySelector("[data-usage-rings]")).toBeNull();
    expect(shownRows(menu)).toEqual(["5-hour", "weekly"]);
  });

  it("show another AI's ring, with no rows until it is pressed, when the bot's own AI reports no usage", async () => {
    remember([other("codex", "Codex", 91)]);
    const menu = await openMenu();
    expect(rings(menu).map((ring) => ring.getAttribute("aria-pressed"))).toEqual(["false"]);
    expect(shownRows(menu)).toEqual([]);
    flushSync(() => rings(menu)[0]!.click());
    expect(shownRows(menu)).toEqual(["weekly"]);
  });
});
