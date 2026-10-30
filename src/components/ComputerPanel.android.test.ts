// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AndroidDeviceStatus, AndroidUsbDevice } from "@/types/ogb";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./AndroidDevicePanel", async (importOriginal) => ({
  ...await importOriginal<typeof import("./AndroidDevicePanel")>(),
  AndroidDevicePanel: () => null,
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("./data/DataPanel", () => ({ DataPanel: () => createElement("div", { "data-testid": "data-panel" }) }));
const panelViewStore = vi.hoisted(() => ({ current: "computer" }));
vi.mock("@/lib/computer-panel-view", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/computer-panel-view")>(),
  readComputerPanelView: () => panelViewStore.current,
  writeComputerPanelView: (_botId: string, view: string) => {
    panelViewStore.current = view;
  },
}));
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

const PHONE: AndroidUsbDevice = { serial: "p1", state: "device", connection: "usb", model: "Pixel" };

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
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine("claude"), engine("codex")], config: { box: { configured: true } } as AppState["config"] } as AppState,
  dispatch: vi.fn(),
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot }) })));
  await settle();
};
/** Drops the panel, so the next case starts from a fresh mount. */
const close = () => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
};
const selectedTab = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="computer-tabs"] button')]
  .find((candidate) => candidate.getAttribute("aria-selected") === "true" || candidate.getAttribute("aria-pressed") === "true")?.textContent?.trim();

/** An adb check that never answers, leaving discovery unfinished. */
const pendingCheck = () => new Promise<AndroidDeviceStatus>(() => {});
/** Points the native bridge at an answer and re-renders, restarting the poll. */
async function check(bot: Bot, status: () => Promise<AndroidDeviceStatus>) {
  vi.stubGlobal("ogb", {
    androidDevice: {
      status,
      frame: async () => ({ serial: "", dataUrl: "" }),
      input: async () => {},
    },
  });
  await open(bot);
}

afterEach(() => {
  close();
  vi.unstubAllGlobals();
  panelViewStore.current = "computer";
});

describe("Computer panel Android tab", () => {
  it("keeps a stored Android view until device discovery completes", async () => {
    panelViewStore.current = "android";
    await check(makeBot(), pendingCheck);
    // Discovery pending: the render falls back, but nothing persists.
    expect(selectedTab()).toBe("Screen");
    expect(panelViewStore.current).toBe("android");

    // Discovery completed with no device: the fallback persists.
    await check(makeBot(), async () => ({ available: true, devices: [] }));
    expect(panelViewStore.current).toBe("computer");
  });

  it("does not persist the fallback from a failed or unavailable adb check", async () => {
    for (const reasonCode of ["adb-failed", "adb-unavailable"] as const) {
      panelViewStore.current = "android";
      await check(makeBot(), reasonCode === "adb-failed"
        ? async () => { throw new Error("adb exited 1"); }
        : async () => ({ available: false, reasonCode, devices: [] }));
      // An adb failure or a missing adb also yields an empty list, but
      // proves nothing: the stored "android" view survives.
      expect(panelViewStore.current).toBe("android");

      // A later successful poll really answers: the no-device result persists.
      await check(makeBot(), async () => ({ available: true, devices: [] }));
      expect(panelViewStore.current).toBe("computer");

      close();
    }
  });

  it("keeps the stored view through a failure after a successful device check", async () => {
    panelViewStore.current = "android";
    await check(makeBot(), async () => ({ available: true, devices: [PHONE] }));
    // Connected: nothing to fall back to, nothing persists.
    expect(selectedTab()).toBe("Android");
    expect(panelViewStore.current).toBe("android");

    // A transient adb failure is not a disconnect, even after a success.
    await check(makeBot(), async () => { throw new Error("adb exited 1"); });
    expect(panelViewStore.current).toBe("android");

    // The unplug is confirmed once a check succeeds with an empty list.
    await check(makeBot(), async () => ({ available: true, devices: [] }));
    expect(panelViewStore.current).toBe("computer");
  });

  it("keeps the view a focus effect persisted when the check finishes in the same commit", async () => {
    panelViewStore.current = "android";
    let resolveScan: (status: AndroidDeviceStatus) => void = () => {};
    vi.stubGlobal("ogb", {
      androidDevice: {
        status: () => new Promise<AndroidDeviceStatus>((resolve) => { resolveScan = resolve; }),
        frame: async () => ({ serial: "", dataUrl: "" }),
        input: async () => {},
      },
    });
    const bot = makeBot();
    await open(bot);
    // The check is still unanswered, so nothing may persist yet.
    expect(panelViewStore.current).toBe("android");

    // The focus and the finished check land in one commit: the fallback must
    // read the newer persisted view, not the one this render was built with.
    await act(async () => {
      const focused = value();
      focused.state = { ...focused.state, dataResultFocus: { botId: bot.id, id: "card", requestId: 1, consumed: false } };
      root!.render(createElement(BotEditorStore, { value: focused, children: createElement(ComputerPanel, { bot }) }));
      resolveScan({ available: true, devices: [] });
    });
    expect(panelViewStore.current).toBe("data");
    expect(selectedTab()).toBe("Data");
  });
});
