// @vitest-environment happy-dom
// Take control where the person watches: the real panel, its real control requests, a stand-in for the live desktop.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  held: false,
  /** Whether a take with a lease gets it: false plays a hold someone else already has. */
  owned: true,
  controls: [] as Array<{ action?: string; controlLeaseId?: string }>,
  posts: [] as string[],
  beacons: [] as Array<{ url: string; body: Record<string, unknown>; keepalive: boolean }>,
  live: null as null | { target: string; expanded: boolean; onUnreachable: () => void },
}));
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
  CloudScreenPreview: ({ onOpen }: { onOpen: () => void }) => createElement("button", { "data-preview": "", onClick: onOpen }, "preview"),
}));
vi.mock("./LiveDesktop", () => ({
  LiveDesktop: (props: { target: string; expanded: boolean; onUnreachable: () => void }) => {
    fixture.live = props;
    return createElement("div", { "data-live-desktop": "", "data-target": props.target, "data-expanded": String(props.expanded) });
  },
}));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    const route = path.split("?")[0]!;
    if (init?.method === "POST") fixture.posts.push(route);
    if (route === "/api/bots/scout/computer/control") {
      if (init?.method !== "POST") return { held: fixture.held, helpReason: null };
      const body = JSON.parse(String(init.body));
      fixture.controls.push(body);
      if (body.action === "take") {
        const owned = !fixture.held || fixture.owned;
        fixture.held = true;
        return { held: true, helpReason: null, ...(body.controlLeaseId ? { owned: owned && fixture.owned, acquired: owned } : {}) };
      }
      fixture.held = false;
      return { held: false, helpReason: null };
    }
    if (route === "/api/bots/scout/local-computer") {
      return {
        mode: "per-bot", max_instances: 2, image: true, create_supported: true, container: "running", imageMatches: true,
        managed: true, network: "loopback", security: "hardened", persistence: "durable", desktopReady: true, ready: true,
        problem: null, viewer_url: "http://127.0.0.1:49152/vnc.html#password=fixture", target_key: `bot:${"a".repeat(64)}`,
      };
    }
    if (route === "/api/bots/scout/local-computer/screenshot") return { image: "data:image/png;base64,FRAME" };
    if (route === "/api/bots/scout/computer") {
      return { configured: true, ready: true, managed: true, imageMatches: true, container: "running", problem: null, box: { state: "ready" } };
    }
    if (route === "/api/bots/scout/computer/screenshot") return { png: "FRAME", format: "png" };
    if (route === "/api/bots/scout/computer/join") return { joinUrl: "https://desktop.invalid/scout" };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
let state: AppState;
let shown: Bot;
const draw = () => flushSync(() => root!.render(createElement(BotEditorStore, {
  value: {
    state,
    dispatch: (action: Action) => {
      if (action.type !== "computerControl") return;
      state = { ...state, computerControl: { ...state.computerControl, [action.botId]: { held: action.held, helpReason: action.helpReason, help: action.help } } };
      queueMicrotask(draw);
    },
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  },
  children: createElement(ComputerPanel, { bot: shown }),
})));
const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  shown = bot;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  draw();
  await settle();
};
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
const press = async (label: string) => {
  const target = button(label);
  expect(target, `no "${label}" button in: ${document.body.textContent}`).toBeDefined();
  flushSync(() => target!.click());
  await settle();
};
const liveDesktop = () => document.querySelector<HTMLElement>("[data-live-desktop]");
const shownLive = () => vi.waitFor(() => expect(liveDesktop(), "the live desktop must replace the picture, here").not.toBeNull());
/** What the server's broadcast does to every open view. */
const heldElsewhere = (held: boolean) => {
  state = { ...state, computerControl: { ...state.computerControl, scout: { held, helpReason: null } } };
  if (root) draw();
};
const releases = () => fixture.beacons.filter((beacon) => beacon.url === "/api/bots/scout/computer/control" && beacon.body.action === "release");

beforeEach(() => {
  // The panel remembers each conversation's tab (computer-panel-view.ts), so one test's tab must not open the next test on it.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  fixture.held = false;
  fixture.owned = true;
  fixture.controls = [];
  fixture.posts = [];
  fixture.beacons = [];
  fixture.live = null;
  state = { ...initialState, instances: [engine], config: { box: { configured: true } } as AppState["config"], computerControl: {} } as AppState;
  vi.stubGlobal("ogb", {
    desktopViewer: { open: vi.fn(async () => true), close: vi.fn(async () => true), onState: () => () => {}, currentState: async () => ({ open: false, contextId: null }) },
  });
  vi.spyOn(window, "open").mockImplementation(() => null);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    fixture.beacons.push({ url, body, keepalive: init?.keepalive === true });
    if (url === "/api/bots/scout/computer/control" && body.action === "release") {
      fixture.held = false;
      setTimeout(() => heldElsewhere(false), 0);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("taking control of a Local VM", () => {
  it("turns the panel's own picture into the live desktop at once; no window or tab opens", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    expect(liveDesktop()!.dataset.target).toBe(`local/bot-${"a".repeat(64)}`);
    expect(window.ogb!.desktopViewer!.open, "nothing may open in another window").not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(fixture.controls).toEqual([{ action: "take", controlLeaseId: expect.stringMatching(/^[0-9a-f]{36}$/) }]);
    expect(document.body.textContent).toContain("You're in control");
    expect(button("Hand control back")).toBeDefined();
  });

  it("hands back at once and returns to watching", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await press("Hand control back");
    expect(fixture.controls.at(-1)).toEqual({ action: "release" });
    expect(liveDesktop()).toBeNull();
    expect(button("Take control")).toBeDefined();
  });

  it("Full screen takes control straight into the whole window", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Full screen");
    expect(fixture.controls.map((control) => control.action)).toEqual(["take"]);
    await shownLive();
    expect(liveDesktop()!.dataset.expanded).toBe("true");
  });

  it("closing the panel, leaving its Screen view or closing the page gives back the hold it took", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    const lease = fixture.controls[0]!.controlLeaseId;
    root!.unmount();
    root = null;
    expect(releases(), "closing the panel left the bot waiting").toEqual([
      { url: "/api/bots/scout/computer/control", body: { action: "release", controlLeaseId: lease }, keepalive: true },
    ]);

    fixture.beacons = [];
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await press("Browser");
    expect(releases(), "leaving the Screen view left the bot waiting").toHaveLength(1);

    fixture.beacons = [];
    await press("Screen");
    await press("Take control");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(releases(), "closing the page left the bot waiting").toHaveLength(1);
    expect(liveDesktop()).toBeNull();
  });

  it("never gives back a hold another device has", async () => {
    fixture.held = true;
    fixture.owned = false;
    heldElsewhere(true);
    await open(makeBot({ computer: "vm" }));
    await press("Full screen");
    await shownLive();
    root!.unmount();
    root = null;
    expect(releases()).toEqual([]);
  });

  it("a hand-back from elsewhere ends the live view once it lasts, and a flicker does not", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    heldElsewhere(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    heldElsewhere(true);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(liveDesktop(), "an out-of-order event ended the session").not.toBeNull();
    heldElsewhere(false);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await settle();
    expect(liveDesktop()).toBeNull();
    expect(releases(), "it was not this panel's to give back").toEqual([]);
  });

  it("a desktop that never comes up gives the computer back and says so", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    flushSync(() => fixture.live!.onUnreachable());
    await settle();
    expect(releases()).toHaveLength(1);
    expect(liveDesktop()).toBeNull();
    expect(document.body.textContent).toContain("MausBot couldn't open the live desktop. Try again.");
  });
});

describe("taking control of other computers", () => {
  it("a VPS is driven in place too, and handing back closes its viewer tunnel", async () => {
    await open(makeBot({ computer: "cloud", cloudBackend: "vps" }));
    await press("Take control");
    await shownLive();
    expect(liveDesktop()!.dataset.target).toBe("vps/scout");
    expect(window.ogb!.desktopViewer!.open).not.toHaveBeenCalled();
    await press("Hand control back");
    expect(fixture.beacons.some((beacon) => beacon.url.startsWith("/api/bots/scout/computer/viewer-close"))).toBe(true);
  });

  it("a cloud computer's provider-hosted desktop still opens in the app's own viewer window", async () => {
    await open(makeBot({ computer: "cloud" }));
    await press("Take control");
    expect(liveDesktop()).toBeNull();
    expect(fixture.posts).toContain("/api/bots/scout/computer/join");
    expect(window.ogb!.desktopViewer!.open).toHaveBeenCalledWith("https://desktop.invalid/scout", "Scout's live desktop", "scout");
  });
});
