// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ advanced: true, android: false, browser: false, page: undefined as unknown }));

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
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: fixture.android ? [{ serial: "p1" }] : [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: ({ page }: { page?: unknown }) => { fixture.page = page; return null; } }));
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
const { requestPanelPage } = await import("@/lib/page-open");
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
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine("claude"), engine("codex")], config: { box: { configured: true },
    ...(fixture.browser ? { features: { browser: true }, browserEngine: { kind: "engine" } } : {}) } as AppState["config"] } as AppState,
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
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="computer-tabs"] [role="tab"]')];
const tab = (label: string) => tabs().find((candidate) => candidate.textContent?.trim() === label)!;
const tabLabels = () => tabs().map((candidate) => candidate.textContent?.trim());
const selected = () => tabs().find((candidate) => candidate.getAttribute("aria-selected") === "true")?.textContent?.trim();
const tabStops = () => tabs().filter((candidate) => candidate.getAttribute("tabindex") === "0").map((candidate) => candidate.textContent?.trim());
const tabListName = () => document.querySelector('[data-testid="computer-tabs"]')?.getAttribute("aria-label");
const press = (label: string, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => tab(label).dispatchEvent(event));
  return event;
};

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
beforeEach(() => {
  // The panel remembers each conversation's tab, so one test's click must not choose the next test's tab.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  fixture.advanced = true;
  fixture.android = false;
  fixture.browser = false;
  fixture.page = undefined;
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  setLocale("en");
});

describe("Computer panel tab", () => {
  it("names the tablist from the active catalog", async () => {
    setLocale("de");
    await open(makeBot());
    expect(document.querySelector('[data-testid="computer-tabs"]')?.getAttribute("role")).toBe("tablist");
    expect(tabListName()).toBe(t("computer.tabsAria"));
    expect(tabListName()).not.toBe("Bot panel view");
  });

  it("stays on Data through a model change and follows a conversation change", async () => {
    await open(makeBot());
    expect(selected()).toBe("Screen");
    flushSync(() => tab("Data").click());
    await settle();
    expect(selected()).toBe("Data");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="data-panel"]')).not.toBeNull());

    await open(makeBot({ modelSelection: { instanceId: "codex", model: "m" } }));
    expect(selected()).toBe("Data");
    expect(document.querySelector('[data-testid="data-panel"]')).not.toBeNull();

    await open(makeBot({ threadId: "thread-2", tasks: [{ threadId: "thread-2", title: "Second", createdAt: 2, approvalMode: "ask" }] } as Partial<Bot>));
    expect(selected()).toBe("Screen");
  });

  it("shows the Browser tab with a published page's Open, and hands the page to the browser to open", async () => {
    fixture.browser = true;
    await open(makeBot());
    expect(selected()).toBe("Screen");
    const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
    flushSync(() => requestPanelPage("scout", PAGE));
    await settle();
    expect(selected()).toBe("Browser");
    expect(fixture.page).toMatchObject({ botId: "scout", url: PAGE });
    flushSync(() => tab("Data").click());
    flushSync(() => requestPanelPage("another-bot", PAGE));
    await settle();
    expect(selected()).toBe("Data");
  });

  it("marks the selected trigger and only that one", async () => {
    await open(makeBot());
    expect(tabs().map((candidate) => candidate.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);

    flushSync(() => tab("Data").click());
    await settle();
    expect(tabs().map((candidate) => candidate.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true"]);
  });

  it("keeps one Tab stop and moves it with the arrow, Home and End keys", async () => {
    await open(makeBot());
    expect(tabStops()).toEqual(["Screen"]);

    press("Screen", "ArrowRight");
    await settle();
    expect(selected()).toBe("Routines");
    expect(tabStops()).toEqual(["Routines"]);
    expect(document.activeElement).toBe(tab("Routines"));

    press("Routines", "ArrowLeft");
    await settle();
    expect(selected()).toBe("Screen");
    expect(document.activeElement).toBe(tab("Screen"));

    // Wraps around the row's ends.
    press("Screen", "ArrowLeft");
    await settle();
    expect(selected()).toBe("Data");
    press("Data", "ArrowRight");
    await settle();
    expect(selected()).toBe("Screen");

    press("Screen", "End");
    await settle();
    expect(selected()).toBe("Data");
    expect(document.activeElement).toBe(tab("Data"));
    press("Data", "Home");
    await settle();
    expect(selected()).toBe("Screen");
    expect(document.activeElement).toBe(tab("Screen"));
  });

  it("leaves the vertical arrows to the page's scrolling", async () => {
    await open(makeBot());
    flushSync(() => tab("Screen").focus());
    expect(press("Screen", "ArrowDown").defaultPrevented).toBe(false);
    expect(press("Screen", "ArrowUp").defaultPrevented).toBe(false);
    await settle();
    expect(selected()).toBe("Screen");
    expect(document.activeElement).toBe(tab("Screen"));
  });

  it("moves over an Android tab that appeared", async () => {
    fixture.android = true;
    await open(makeBot());
    expect(tabLabels()).toEqual(["Screen", "Routines", "Android", "Browser", "Data"]);
    press("Routines", "ArrowRight");
    await settle();
    expect(selected()).toBe("Android");
  });

  it("keeps one selected tab when Android disconnects", async () => {
    fixture.android = true;
    await open(makeBot());
    flushSync(() => tab("Android").click());
    await settle();
    expect(selected()).toBe("Android");

    fixture.android = false;
    await open(makeBot());
    expect(tabLabels()).not.toContain("Android");
    expect(selected()).toBe("Screen");
  });

  it("stops on the Files tab in Simple mode", async () => {
    fixture.advanced = false;
    await open(makeBot());
    expect(tabLabels()).toEqual(["Screen", "Browser", "Data", "Files"]);
    press("Screen", "End");
    await settle();
    expect(selected()).toBe("Files");
    expect(document.activeElement).toBe(tab("Files"));
  });

  it("points every selected trigger at its panel and the panel back", async () => {
    await open(makeBot());
    for (const label of ["Screen", "Routines", "Browser", "Data"]) {
      flushSync(() => tab(label).click());
      await settle();
      const trigger = tab(label);
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(trigger.id);
    }
  });

  it("puts every selected panel in the tab sequence", async () => {
    await open(makeBot());
    for (const label of ["Screen", "Routines", "Browser", "Data"]) {
      flushSync(() => tab(label).click());
      await settle();
      const panel = document.getElementById(tab(label).getAttribute("aria-controls")!);
      expect(panel?.getAttribute("tabindex"), label).toBe("0");
    }
  });
});
