// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => false }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./RoutinesPage", () => ({ RoutineEditor: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async () => ({}),
}));

const { RemoteDesktopPanel } = await import("./remote-desktop-panel");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = (instanceId: string) => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
}) as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, computer: "cloud", messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
let nextFrame = 1;

const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine("claude")], config: { box: { configured: true } } as AppState["config"] } as AppState,
  dispatch: vi.fn(),
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(RemoteDesktopPanel, { bot, key: bot.id }) })));
  await settle();
};
const runFrames = () => {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame.run(0);
};
const panelClose = () => document.querySelector<HTMLElement>("[data-computer-panel-close]")!;

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
beforeEach(() => {
  frames = [];
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.push({ id, run: callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
});
afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("remote desktop panel entry focus", () => {
  it("opens onto its close button, the only entry a panel without tabs has", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.activeElement).toBe(panelClose());
  });

  it("leaves a pointer open's focus alone", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: null, tabs: false });
    await open(makeBot());
    expect(frames).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  it("returns focus to the opener from its X", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const close = panelClose();
    close.focus();

    flushSync(() => close.click());
    expect(document.activeElement).toBe(opener);
  });
});
