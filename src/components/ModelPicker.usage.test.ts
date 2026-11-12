// @vitest-environment happy-dom
// The usage bars inside the model button, in both modes, in the narrow header and in the bot panel, and the same rows
// at the top of the open model menu.
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
