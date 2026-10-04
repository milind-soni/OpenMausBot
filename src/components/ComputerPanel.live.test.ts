// @vitest-environment happy-dom
// A working bot's Cloud computer streams its screen over the app's one live
// stream. The Computer panel takes those frames straight from it, shows them,
// and does not capture its own screenshots while they keep arriving; when
// they stop, its own capture takes over again.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const captured = vi.hoisted(() => ({ posts: 0 }));
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
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: () => {} }));
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: ({ src }: { src: string | null }) => createElement("img", { "data-preview": "", src: src ?? "" }),
}));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots/bot/computer/screenshot")) {
      if (init?.method === "POST") captured.posts++;
      return { png: "POLLED", format: "png" };
    }
    if (path.startsWith("/api/bots/bot/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/bot/computer?")) return { configured: true, box: { state: "ready" } };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");
const { publishLiveFrame } = await import("@/lib/live-events");

const bot = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, computer: "cloud", messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;

let root: Root;
let value: Parameters<typeof BotEditorStore>[0]["value"];
const render = (shown: Bot) => {
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ComputerPanel, { bot: shown }) })));
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await tick();
  }
};
const preview = () => document.querySelector("img[data-preview]")?.getAttribute("src");
const screen = (fields: { botId?: string; threadId?: string; png: string; mime?: string }) => {
  publishLiveFrame({ kind: "screen", botId: "bot", threadId: "thread", ...fields });
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const state: AppState = {
    ...initialState,
    bots: [bot],
    selectedId: bot.id,
    instances: [engine],
    config: { box: { configured: true } } as AppState["config"],
  };
  value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render(bot);
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.useRealTimers();
});

describe("Computer panel live frames", () => {
  it("starts from its own capture", () => {
    expect(captured.posts).toBe(1);
    expect(preview()).toBe("data:image/png;base64,POLLED");
  });

  it("shows each live frame and captures nothing while they arrive", async () => {
    for (let i = 0; i < 6; i++) {
      flushSync(() => screen({ png: `LIVE${i}`, mime: "image/jpeg" }));
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(preview()).toBe(`data:image/jpeg;base64,LIVE${i}`);
    }
    expect(captured.posts).toBe(1);
  });

  it("ignores frames from another conversation or another bot", async () => {
    flushSync(() => {
      screen({ threadId: "sibling", png: "SIBLING" });
      screen({ botId: "other", png: "OTHER" });
    });
    await settle();
    expect(preview()).toBe("data:image/jpeg;base64,LIVE5");
  });

  it("captures again once the frames stop", async () => {
    await vi.advanceTimersByTimeAsync(12_000);
    await settle();
    expect(captured.posts).toBeGreaterThan(1);
    expect(preview()).toBe("data:image/png;base64,POLLED");
  });

  it("keeps waiting on live frames when the bot opens a second conversation", async () => {
    const posts = captured.posts;
    flushSync(() => screen({ png: "AGAIN" }));
    render({ ...bot, tasks: [...bot.tasks!, { threadId: "sibling", title: "Other", createdAt: 2, approvalMode: "ask" }] } as Bot);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(captured.posts).toBe(posts);
    expect(preview()).toBe("data:image/png;base64,AGAIN");
  });
});
