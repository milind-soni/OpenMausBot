// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: (() => {}) as (...args: unknown[]) => void, instances: [] as unknown[], advanced: true,
  refreshInstances: (() => Promise.resolve()) as () => Promise<void>, refreshModels: ((_id: string) => Promise.resolve()) as (id: string) => Promise<void> }));
const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api, ApiError: Error }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
// The store's refresh callbacks keep one identity across renders, as the real store's do.
const refresh = { instances: () => fixture.refreshInstances(), models: (id: string) => fixture.refreshModels(id) };
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [], modelVariantSessions: {}, config: {} },
    dispatch: fixture.dispatch,
    refreshInstances: refresh.instances,
    refreshModels: refresh.models,
  }),
}));

const { ModelPicker } = await import("./ModelPicker");
const { resetAiSwitch, requestAiSwitch } = await import("@/lib/ai-switch");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const available = { state: "available", version: "1.0.0", authenticated: true } as const;
const opencode = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", access: "subscription", snapshot: available,
  models: { default: "free", options: [{ id: "free", label: "Free model" }] },
} as unknown as InstanceInfo;
const codex = {
  instanceId: "codex", driverKind: "codex", displayName: "Codex", access: "subscription", snapshot: available,
  models: { default: "gpt-5.6", options: [{ id: "gpt-5.6", label: "GPT-5.6" }] },
} as unknown as InstanceInfo;
const busyBot = {
  id: "maus", threadId: "thread-1", name: "Maus", title: "", description: "", notifications: true, color: "green", unread: false,
  busy: true, modelSelection: { instanceId: "opencodeGo", model: "free" }, messages: [],
} as unknown as Bot;

let host: HTMLDivElement;
let root: Root;
const trigger = () => host.querySelector<HTMLButtonElement>('[data-tour="model"]')!;
const buttonNamed = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  .find((button) => button.getAttribute("aria-label") === name || button.textContent?.includes(name));

beforeEach(() => {
  fixture.advanced = true;
  api.mockReset();
  api.mockResolvedValue({ ok: true });
  fixture.dispatch = vi.fn();
  fixture.instances = [opencode, codex];
  fixture.refreshInstances = () => Promise.resolve();
  fixture.refreshModels = () => Promise.resolve();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(ModelPicker, { bot: busyBot, threadId: "thread-1" })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetAiSwitch();
});

describe("the header model chip and Switch AI", () => {
  it("stays shut while the bot works, until Switch AI asks for it", () => {
    expect(trigger().disabled).toBe(true);
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }));
    expect(trigger().disabled).toBe(false);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("stops that turn, not the store's model, when another AI is picked", () => {
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }));
    // Codex sits on the rail as its sign-in family, OpenAI.
    act(() => buttonNamed("OpenAI")!.click());
    act(() => buttonNamed("GPT-5.6")!.click());
    expect(api).toHaveBeenCalledWith("/api/bots/maus/interrupt", { method: "POST", body: JSON.stringify({ threadId: "thread-1", turnId: "turn-1" }) });
    expect(vi.mocked(fixture.dispatch).mock.calls.filter(([action]) => (action as { type: string }).type === "setModel")).toEqual([]);
  });

  it("opens the bot panel's picker for Switch AI in Simple mode, where the panel's own Thinking row is the only effort control", () => {
    fixture.advanced = false;
    fixture.instances = [{ ...opencode, capabilities: { effortLevels: ["low", "high"] } }, codex];
    act(() => root.render(createElement(ModelPicker, { bot: busyBot, threadId: "thread-1", contained: true })));
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "panel" }));
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    expect(document.querySelector("[data-simple-effort]")).toBeNull();
  });

  it("shows no thinking-level buttons in the chat's menu while the turn runs: the server refuses them until it ends", () => {
    fixture.advanced = false;
    fixture.instances = [{ ...opencode, capabilities: { effortLevels: ["low", "high"] } }, codex];
    const show = (bot: Bot) => act(() => root.render(createElement(ModelPicker, { bot, threadId: "thread-1" })));
    show(busyBot);
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }));
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    expect(document.querySelector("[data-simple-effort]")).toBeNull();
    show({ ...busyBot, busy: false });
    expect(document.querySelector("[data-simple-effort]")).not.toBeNull();
  });

  it("ignores an intent for another place", () => {
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "panel" }));
    expect(trigger().disabled).toBe(true);
  });
});

describe("a picker that opens before its engine has listed its models", () => {
  // Engines read their model lists lazily, so a fresh start can hand the picker an engine with none listed yet.
  const sonnet = { id: "claude-sonnet-5", label: "Claude Sonnet 5" };
  const claude = (options: Array<{ id: string; label: string; custom?: boolean }>) => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
    snapshot: { state: "available", version: "2.1.300", authenticated: true }, models: { default: "claude-sonnet-5", options },
  }) as unknown as InstanceInfo;
  const onClaude = { ...busyBot, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } as Bot;
  const text = () => document.querySelector("[data-model-picker-content]")?.textContent ?? "";
  let arrive: () => void;
  const readList = (listed: Array<{ id: string; label: string; custom?: boolean }>) => {
    const read = new Promise<void>((resolve) => { arrive = () => { fixture.instances = [claude(listed), codex]; resolve(); }; });
    fixture.refreshInstances = vi.fn(() => read);
    fixture.refreshModels = vi.fn(() => read);
  };

  it.each([
    ["Switch AI", () => act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }))],
    ["the model chip", () => {
      act(() => root.render(createElement(ModelPicker, { bot: { ...onClaude, busy: false }, threadId: "thread-1" })));
      act(() => trigger().click());
    }],
  ])("opened by %s, says it is loading, then lands on the engine's own models when they arrive", async (_by, openPicker) => {
    fixture.instances = [claude([]), codex];
    readList([sonnet]);
    act(() => root.render(createElement(ModelPicker, { bot: onClaude, threadId: "thread-1" })));
    openPicker();
    expect(text()).toContain("Loading Claude models");
    expect(text()).not.toContain("No local models found");
    await act(async () => arrive());
    expect(text()).toContain("Claude Sonnet 5");
    expect(text()).not.toContain("Loading Claude models");
    expect(text()).not.toContain("No local models found");
    expect(text()).not.toContain("Back to Claude models");
  });

  it("offers local models once the read finds none of the engine's own", async () => {
    fixture.instances = [claude([]), codex];
    readList([]);
    act(() => root.render(createElement(ModelPicker, { bot: onClaude, threadId: "thread-1" })));
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }));
    await act(async () => arrive());
    expect(text()).toContain("No local models found");
    expect(text()).not.toContain("Loading Claude models");
  });

  it("opens Switch AI on the bot's own engine, not the one the picker was last left on", () => {
    fixture.instances = [claude([sonnet]), codex];
    act(() => root.render(createElement(ModelPicker, { bot: { ...onClaude, busy: false }, threadId: "thread-1" })));
    act(() => trigger().click());
    act(() => buttonNamed("OpenAI")!.click());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    act(() => root.render(createElement(ModelPicker, { bot: onClaude, threadId: "thread-1" })));
    act(() => requestAiSwitch({ botId: "maus", threadId: "thread-1", turnId: "turn-1", place: "header" }));
    expect(text()).toContain("Claude Sonnet 5");
    expect(text()).not.toContain("GPT-5.6");
  });
});
