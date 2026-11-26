// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced,
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
const { resetPlacesTogetherForTest } = await import("@/lib/places-together");
const { resetPlaceRowsForTest } = await import("@/lib/place-rows");
const { setUniversalPins } = await import("@/lib/sidebar-preferences");

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
const shown = () => { const seen = ids(); return { seen, once: new Set(seen).size === seen.length }; };
const row = (id: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home: "cloud", id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), color: "blue", ...over });
const cloud = (bots: PlaceBotRow[]): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer", other: { home: "cloud", state: "ready", bots } });
const page = (said: PlacesTogetherState) => ({ state: vi.fn(async () => said), set: vi.fn(async () => said), open: vi.fn(async () => true), onChanged: vi.fn(() => () => {}) });
const filter = () => host.querySelector<HTMLButtonElement>("[data-sidebar-unread-filter]")!;
const click = async () => act(async () => filter().click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  localStorage.clear();
  setLocale("en");
  mode.advanced = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setUniversalPins(false);
  resetPlacesTogetherForTest();
  resetPlaceRowsForTest();
  vi.unstubAllGlobals();
  delete (window as { ogb?: unknown }).ogb;
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

  it("counts and lists My Cloud's bots too, and opens one where it lives", async () => {
    const other = page(cloud([row("scout"), row("tech", { waiting: true, lastAt: 5 }), row("old", { unread: true, lastAt: 1 })]));
    window.ogb = { placesTogether: other } as never;
    await render([bot("ann"), unread("ben", 20)]);
    expect(filter().dataset.sidebarUnreadFilter).toBe("3");
    await click();
    expect(ids()).toEqual(["cloud:old", "cloud:tech", "ben"]);
    await act(async () => host.querySelector<HTMLElement>('[data-sidebar-bot-row="cloud:tech"]')!.click());
    expect(other.open.mock.calls).toEqual([["tech"]]);
  });

  it("renames a listed bot from its menu", async () => {
    await render([bot("ann"), unread("ben", 20)]);
    await click();
    await act(async () => { host.querySelector('[data-sidebar-bot-row="ben"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Rename");
    await act(async () => rename!.click());
    expect(host.querySelector('[data-sidebar-bot-row="ben"] input')).not.toBeNull();
  });

  const withPin = [bot("ann"), bot("pip", { pinned: true, unread: true, tasks: [{ threadId: "pip-t", title: "Chat", createdAt: 1, updatedAt: 5, unread: true }] }), unread("ben", 20)];
  const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("sits under the Pinned section and lists a pinned bot once, in the pins, not in its count", async () => {
    mode.advanced = true;
    await render(withPin);
    const pinned = host.querySelector('[data-sidebar-section-id="builtin:pinned"]')!;
    expect(pinned.contains(filter())).toBe(true);
    expect(after(pinned.querySelector('[data-sidebar-bot-row="pip"]')!, filter())).toBe(true);
    expect(filter().dataset.sidebarUnreadFilter).toBe("1");
    await click();
    expect(shown()).toEqual({ seen: ["pip", "ben"], once: true });
    expect(after(filter(), host.querySelector('[data-sidebar-bot-row="ben"]')!)).toBe(true);
  });

  it("sits under the pins kept above the list and lists a pinned bot once", async () => {
    mode.advanced = true;
    setUniversalPins(true);
    await render(withPin);
    expect(after(host.querySelector("[data-sidebar-universal-pins]")!, filter())).toBe(true);
    expect(filter().dataset.sidebarUnreadFilter).toBe("1");
    await click();
    expect(shown()).toEqual({ seen: ["pip", "ben"], once: true });
  });

  it("sits under the pinned tiles of the Simple sidebar and lists a pinned bot once", async () => {
    await render(withPin);
    const pip = host.querySelector('[data-sidebar-bot-row="pip"]')!;
    expect(after(pip, filter())).toBe(true);
    expect(filter().dataset.sidebarUnreadFilter).toBe("1");
    await click();
    expect(shown()).toEqual({ seen: ["pip", "ben"], once: true });
  });
});
