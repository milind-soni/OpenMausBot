// @vitest-environment happy-dom
// The remote client's Take control: the real panel and its control requests, a stand-in for the app's viewer window.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ owned: true, controls: [] as Array<{ action: string; controlLeaseId?: string }> }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => false }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./RoutinesPage", () => ({ RoutineEditor: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (path === "/api/bots/scout/computer/control") {
      const body = JSON.parse(String(init?.body));
      fixture.controls.push(body);
      return body.action === "take" ? { held: true, helpReason: null, owned: fixture.owned } : { held: false, helpReason: null };
    }
    if (path === "/api/bots/scout/computer/join") return { joinUrl: "https://desktop.invalid/scout" };
    return {};
  },
}));

const { RemoteDesktopPanel } = await import("./remote-desktop-panel");
const { viewerClosedRelease } = await import("./computer-takeover");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const bot = {
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, computer: "cloud", messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
let root: Root | null = null;

beforeEach(() => {
  fixture.controls = [];
  viewerClosedRelease("scout");
});
afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it.each([
  { row: "its open fails", owned: true, opened: false, releases: true, closes: false },
  { row: "its take found another device's hold", owned: false, opened: true, releases: false, closes: false },
  { row: "its take owned the hold", owned: true, opened: true, releases: false, closes: true },
])("the remote panel's Take control gives back only a hold its own take owned, by that take's lease: $row", async ({ owned, opened, releases, closes }) => {
  fixture.owned = owned;
  vi.stubGlobal("ogb", { desktopViewer: { open: vi.fn(async () => opened), close: vi.fn(async () => true), onState: () => () => {}, currentState: async () => ({ open: false, contextId: null }) } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(BotEditorStore, { value: {
    state: { ...initialState, instances: [engine], config: { box: { configured: true } } as AppState["config"] } as AppState,
    dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  }, children: createElement(RemoteDesktopPanel, { bot }) })));
  const take = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Take control");
  expect(take, document.body.textContent ?? "").toBeDefined();
  flushSync(() => take!.click());
  await vi.waitFor(() => expect(fixture.controls.length).toBeGreaterThan(0));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const lease = fixture.controls[0]!.controlLeaseId;
  expect(fixture.controls).toEqual([
    { action: "take", controlLeaseId: expect.stringMatching(/^[0-9a-f]{36}$/) },
    ...(releases ? [{ action: "release", controlLeaseId: lease }] : []),
  ]);
  expect(viewerClosedRelease("scout")).toEqual(closes ? { action: "release", controlLeaseId: lease } : null);
});
