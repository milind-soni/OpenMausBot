// @vitest-environment happy-dom
// The real mode and thread preferences: a browser put back on Advanced mode at boot sees its thread folders in the
// sidebar again; Simple mode keeps one conversation per bot there.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Task } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

// What the one-time cleanup left: the record that this browser was on Advanced, no mode key, no threads choice.
const stored = new Map<string, string>([["omb-new-look", "seen"], ["omb-skin", "midnight"]]);
vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, String(value)),
  removeItem: (key: string) => void stored.delete(key) });
const { settleInterfaceMode } = await import("@/lib/new-look");
settleInterfaceMode();
const { readAdvancedMode, setAdvancedMode } = await import("@/lib/interface-mode");
const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale, t } = await import("@/lib/i18n");

const thread = (threadId: string, title: string, projectId?: string): Task =>
  ({ threadId, title, createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask", projectId });
const atlas: Bot = {
  id: "atlas", threadId: "loose", name: "Atlas", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  projects: [{ id: "taxes", name: "Taxes" }],
  tasks: [thread("loose", "Loose chat"), thread("filed", "Filed chat", "taxes")],
};
const state: AppState = {
  ...initialState, connected: true, selectedId: "atlas", activeView: "chat", bots: [atlas],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(Sidebar, { open: true, onClose: () => {} }) })));
  await settle();
}
const expand = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("task.expandNamed", { name: "Atlas" })}"]`);
const folder = () => document.querySelector('[data-sidebar-folder-row="taxes"]');

beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("thread folders after Advanced mode comes back", () => {
  it("shows a browser put back on Advanced its thread folders, threads being on by default", async () => {
    expect(readAdvancedMode()).toBe(true);
    expect(stored.has("omb-show-threads")).toBe(false);
    await draw();
    expect(folder(), "folded until opened").toBeNull();
    flushSync(() => expand()!.click());
    await settle();
    expect(folder()?.textContent).toContain("Taxes");
    expect(document.querySelector('[data-sidebar-thread-row="loose"]')).not.toBeNull();
  });

  it("hides them in Simple mode and shows them again when switched back", async () => {
    flushSync(() => setAdvancedMode(false));
    await draw();
    expect(folder()).toBeNull();
    expect(expand()).toBeNull();
    flushSync(() => setAdvancedMode(true));
    await draw();
    expect(folder()?.textContent).toContain("Taxes");
  });
});
