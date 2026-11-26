// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => false,
}));
vi.mock("@/lib/thread-preferences", async (original) => ({
  ...await original<typeof import("@/lib/thread-preferences")>(), useShowThreads: () => false,
}));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: false, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: `${id}-t`, title: "Chat", createdAt: 1 }], ...extra,
});
const unread = (id: string, at: number) => bot(id, { unread: true, messages: [{ id: `${id}-m`, role: "bot", kind: "text", text: "hi", at }],
  tasks: [{ threadId: `${id}-t`, title: "Chat", createdAt: 1, updatedAt: at, unread: true }] });

let host: HTMLDivElement, root: Root;
const tree = (bots: Bot[], selectedId: string) => createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots, selectedId }, dispatch: vi.fn(),
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(Sidebar, { open: true, onClose: () => {} }),
});
async function render(bots: Bot[], selectedId = "") {
  await act(async () => root.render(tree(bots, selectedId)));
  await act(async () => { await Promise.resolve(); });
}
const ids = () => [...host.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")].map((item) => item.dataset.sidebarBotRow);
const filter = () => host.querySelector<HTMLButtonElement>("[data-sidebar-unread-filter]")!;
const click = async () => act(async () => filter().click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  localStorage.clear();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the sidebar's Unread filter", () => {
  const plain = [bot("ann"), unread("ben", 20), bot("cal", { activity: "waiting-on-you" }), bot("dee"), unread("eve", 10)];

  it("counts unread and waiting bots and moves no row while it is closed", async () => {
    await render([bot("ann"), bot("ben"), bot("cal"), bot("dee"), bot("eve")]);
    const rows = ids();
    expect(filter().dataset.sidebarUnreadFilter).toBe("0");
    expect(filter().getAttribute("aria-pressed")).toBe("false");
    await render(plain);
    expect(ids()).toEqual(rows);
    expect(filter().dataset.sidebarUnreadFilter).toBe("3");
    expect(filter().getAttribute("aria-label")).toBe("Unread, 3");
  });

  it("lists only those bots in a fixed order and gives the list back exactly as it was", async () => {
    await render(plain);
    const rows = ids();
    await click();
    expect(filter().getAttribute("aria-pressed")).toBe("true");
    expect(ids()).toEqual(["cal", "eve", "ben"]);

    await render(plain.map((one) => (one.id === "dee" ? unread("dee", 1) : one.id === "eve" ? unread("eve", 99) : one)));
    expect(ids()).toEqual(["cal", "eve", "ben", "dee"]);

    await click();
    expect(ids()).toEqual(rows);
  });

  it("keeps the opened bot until another conversation is open, then says all is read", async () => {
    const one = [bot("ann"), unread("ben", 20)];
    await render(one);
    await click();
    await render(one, "ben");
    await render([bot("ann"), bot("ben")], "ben");
    expect(ids()).toEqual(["ben"]);
    await render([bot("ann"), bot("ben")], "ann");
    expect(ids()).toEqual([]);
    expect(host.textContent).toContain("All read");
  });
});
