// @vitest-environment happy-dom
import { StrictMode, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";

const fixture = { advanced: true };

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("./data/DataPanel", () => ({ DataPanel: () => createElement("div", { "data-testid": "data-panel" }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string) => {
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) return { surface: "cloud", backend: "box", configured: true, box: { boxId: "bx_23456789", state: "ready" } };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
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
const open = async (bot: Bot, strict = false) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const panel = createElement(ComputerPanel, { bot, key: bot.id });
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: strict ? createElement(StrictMode, null, panel) : panel })));
  await settle();
};
const runFrames = () => {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame.run(0);
};
const activeTab = () => document.querySelector<HTMLElement>('[data-testid="computer-tabs"] [role="tab"][aria-selected="true"]');
const tabByLabel = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="computer-tabs"] [role="tab"]')].find((candidate) => candidate.textContent?.trim() === label)!;
const panelClose = () => document.querySelector<HTMLElement>("[data-computer-panel-close]");
const panelGear = () => document.querySelector<HTMLElement>(`[title=${JSON.stringify(t("computer.botSettings"))}]`)!;
const chatButton = () => {
  const button = document.createElement("button");
  button.dataset.tour = "computer";
  button.textContent = "Computer";
  document.body.append(button);
  return button;
};

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
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
  fixture.advanced = true;
});
afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  setLocale("en");
});

describe("computer panel entry focus", () => {
  it("hands the keyboard's open to the active tab, one frame later", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    expect(document.activeElement).toBe(document.body);
    expect(frames).toHaveLength(1);

    runFrames();
    expect(document.activeElement).toBe(activeTab());
    expect(document.activeElement?.textContent?.trim()).toBe(t("computer.tab.computer"));
  });

  it("leaves a pointer open's focus alone", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: false });
    await open(makeBot());
    expect(frames).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus meant for another bot", async () => {
    rememberComputerPanelOpen({ botId: "pepper", opener: chatButton(), tabs: true });
    await open(makeBot());
    expect(frames).toHaveLength(0);
  });

  it("keeps the deferred focus when React runs the effect twice", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot(), true);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(document.activeElement).toBe(activeTab());
  });

  it("takes the entry focus once per open, not on every mount", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    root?.unmount();
    document.body.querySelectorAll("div").forEach((node) => node.remove());
    await open(makeBot());
    expect(frames).toHaveLength(0);
  });

  it("does not take focus again when the panel remounts for another bot", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    await open(makeBot({ id: "pepper" }));
    expect(frames).toHaveLength(0);
  });

  it("keeps the ring on the tab the panel itself moves to", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    // Auto resolves its surface, or a data result and a sign-in move the tab.
    flushSync(() => tabByLabel("Data").click());
    await settle();
    expect(document.activeElement).toBe(tabByLabel("Data"));
  });

  it("stops following the selection once focus leaves the tab row", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    const content = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
    flushSync(() => content.focus());

    flushSync(() => tabByLabel("Data").click());
    await settle();
    expect(document.activeElement).toBe(content);
  });
});

describe("computer panel close hand-off", () => {
  it("returns focus to the opener from the panel's own X", async () => {
    const opener = chatButton();
    opener.focus();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const close = panelClose()!;
    close.focus();

    flushSync(() => close.click());
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus before handing over to bot settings from the gear", async () => {
    const opener = chatButton();
    opener.focus();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const gear = panelGear();
    gear.focus();

    flushSync(() => gear.click());
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to the chat button when the opener was unmounted", async () => {
    const chat = chatButton();
    const opener = document.createElement("button");
    document.body.append(opener);
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    opener.remove();
    const close = panelClose()!;
    close.focus();

    flushSync(() => close.click());
    expect(document.activeElement).toBe(chat);
  });

  it("leaves focus where it was when the panel was not focused", async () => {
    const opener = chatButton();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    flushSync(() => panelClose()!.click());
    expect(document.activeElement).toBe(composer);
  });
});
