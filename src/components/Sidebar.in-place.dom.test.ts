// @vitest-environment happy-dom
// A My Cloud bot opened in place from the real Sidebar's one list: the click readies it through main and opens its
// conversation in this page's own store (src/lib/place-chat.ts), never moving the window; when that can't be done it
// opens on My Cloud's page as before. Its row's menu keeps a way to My Cloud's own page.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { ArrangedBot, PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced,
}));
vi.mock("@/lib/thread-preferences", async (original) => ({
  ...await original<typeof import("@/lib/thread-preferences")>(), useShowThreads: () => mode.advanced,
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

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: `${id}-t`, title: "Chat", createdAt: 1 }], ...extra,
});
const row = (id: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home: "cloud", id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), color: "blue", ...over });
const said = (over: Partial<PlacesTogetherState> = {}): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: "ready", bots: [row("scout", { title: "Open issues" }), row("tech", { unread: true, title: "Deploy check", lastAt: 9_000, preview: "Deploy **passed** on staging." })] }, ...over });
const OWN = [bot("mausbot", { chiefOfStaff: true }), bot("git"), bot("ledger")];

const dispatch = vi.fn();
let host: HTMLDivElement, root: Root, answer: () => Promise<PlacesTogetherState>;
const page = {
  state: vi.fn(() => answer()),
  set: vi.fn(async () => said()),
  open: vi.fn(async () => true),
  onChanged: vi.fn((_callback: () => void) => () => {}),
  arrange: vi.fn(async (entries: ArrangedBot[]) => entries),
  openInPlace: vi.fn(async (_id: string) => ({ ok: true })),
};
/** This page's store has loaded (its departments are known for sure). */
let hydrated = false;
const tree = (bots: Bot[], icons = false) => createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots, selectedId: bots[0]!.id, ...(hydrated ? { hydrated: true as const } : {}) }, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(Sidebar, { open: true, onClose: () => {}, collapseToIcons: icons }),
});
async function render(bots = OWN, icons = false) {
  await act(async () => root.render(tree(bots, icons)));
  await act(async () => { await Promise.resolve(); });
}
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const { resetPlaceChatForTest } = await import("@/lib/place-chat");
const scoutThere = { id: "scout", name: "Scout", threadId: "t1", title: "", description: "", color: "blue", notifications: true, unread: false, chiefOfStaff: true,
  modelSelection: { instanceId: "claude", model: "opus" }, tasks: [{ threadId: "t1", title: "Flats", createdAt: 1 }], messages: [{ id: "m1", role: "bot", kind: "text", text: "Four flats.", at: 1 }] };
/** This computer's server, forwarding to My Cloud: the bot in the page's ids, or a refusal. */
let served: (path: string) => Response;
const fetched: string[] = [];
class Source { static made: Source[] = []; url: string; onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; closed = false;
  constructor(url: string) { this.url = url; Source.made.push(this); } close() { this.closed = true; } }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetched.length = 0;
  Source.made = [];
  served = (path) => path.startsWith("/api/bots/cloud%3Ascout")
    ? new Response(JSON.stringify({ bot: { ...scoutThere, id: "cloud:scout", threadId: "cloud:t1", tasks: [{ threadId: "cloud:t1", title: "Flats", createdAt: 1 }] } }), { headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404 });
  vi.stubGlobal("fetch", async (path: string) => { fetched.push(String(path)); return served(String(path)); });
  vi.stubGlobal("EventSource", Source);
  dispatch.mockReset();
  for (const fn of Object.values(page)) fn.mockClear();
  page.openInPlace.mockImplementation(async () => ({ ok: true }));
  answer = async () => said();
  localStorage.clear();
  hydrated = false;
  setLocale("en");
  mode.advanced = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetPlacesTogetherForTest();
  resetPlaceRowsForTest();
  resetPlaceChatForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { ogb?: unknown }).ogb;
});
const settled = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0)); });

describe("a My Cloud bot opens in this window", () => {
  it("a click opens its conversation in this page's store, by its place's id: the window never moves", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    await act(async () => q('[data-sidebar-bot-row="cloud:scout"]')!.click());
    await settled();
    expect(page.openInPlace.mock.calls).toEqual([["scout"]]);
    expect(page.open).not.toHaveBeenCalled();
    expect(fetched).toContain("/api/bots/cloud%3Ascout?messages=80");
    const actions = dispatch.mock.calls.map(([action]) => action);
    const added = actions.find((action) => action.type === "botPatched");
    expect(added.bot.id).toBe("cloud:scout");
    expect(added.bot.threadId).toBe("cloud:t1");
    // My Cloud's Chief is never this page's Chief, and nothing of it notifies here.
    expect(added.bot.chiefOfStaff).toBe(false);
    expect(added.bot.notifications).toBe(false);
    expect(actions.at(-1)).toEqual({ type: "select", id: "cloud:scout" });
    // Its live stream, through this computer's own server.
    expect(Source.made.map((source) => source.url)).toEqual(["/api/places/cloud/events?bot=cloud%3Ascout"]);
  });

  it("opens on My Cloud's page instead when main can't ready it, or this computer's server can't read it", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    page.openInPlace.mockImplementation(async () => ({ ok: false }));
    await act(async () => q('[data-sidebar-bot-row="cloud:scout"]')!.click());
    await settled();
    expect(page.open.mock.calls).toEqual([["scout"]]);
    page.openInPlace.mockImplementation(async () => ({ ok: true }));
    served = () => new Response(JSON.stringify({ error: "no", code: "place_unsupported" }), { status: 404 });
    await act(async () => q('[data-sidebar-bot-row="cloud:tech"]')!.click());
    await settled();
    expect(page.open.mock.calls).toEqual([["scout"], ["tech"]]);
    expect(dispatch.mock.calls.some(([action]) => action.type === "select")).toBe(false);
  });

  it("a session My Cloud signed out is replaced once, and the bot opens here all the same", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    const good = served;
    let first = true;
    served = (path) => { if (first) { first = false; return new Response(JSON.stringify({ error: "x", code: "place_signin" }), { status: 502 }); } return good(path); };
    await act(async () => q('[data-sidebar-bot-row="cloud:scout"]')!.click());
    await settled();
    expect(page.openInPlace.mock.calls).toEqual([["scout"], ["scout", true]]);
    expect(page.open).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([action]) => action).at(-1)).toEqual({ type: "select", id: "cloud:scout" });
  });

  it("an app without it opens on My Cloud's page, as before", async () => {
    const { openInPlace: _gone, ...older } = page;
    window.ogb = { placesTogether: older } as never;
    await render();
    await act(async () => q('[data-sidebar-bot-row="cloud:scout"]')!.click());
    expect(page.open.mock.calls).toEqual([["scout"]]);
    expect(q('[data-placed-actions]')).toBeNull();
  });

  it("the row's menu opens My Cloud's own page at that bot, and offers nothing that changes it", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    await act(async () => q('[data-placed-actions="cloud:scout"]')!.click());
    // Choosing the menu's button chooses nothing else: the bot is not opened by it.
    expect(page.openInPlace).not.toHaveBeenCalled();
    const menu = document.querySelector<HTMLElement>("[data-placed-menu]")!;
    expect([...menu.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["Open on My Cloud's page"]);
    await act(async () => menu.querySelector<HTMLElement>("[role=menuitem]")!.click());
    expect(page.open.mock.calls).toEqual([["scout"]]);
    expect(document.querySelector("[data-placed-menu]")).toBeNull();
    // Right-click opens the same menu.
    await act(async () => { q('[data-sidebar-bot-row="cloud:scout"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(document.querySelector("[data-placed-menu]")).not.toBeNull();
  });

  it("the bot open in place is drawn once, as its row, which shows it chosen", async () => {
    window.ogb = { placesTogether: page } as never;
    const open = { ...bot("scout"), id: "cloud:scout", threadId: "cloud:t1", name: "Scout" };
    await act(async () => root.render(createElement(BotEditorStore, {
      value: { state: { ...initialState, connected: true, bots: [...OWN, open], selectedId: "cloud:scout" }, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(Sidebar, { open: true, onClose: () => {} }),
    })));
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelectorAll('[data-sidebar-bot-row="cloud:scout"]').length).toBe(1);
    expect(host.querySelector('[aria-current="page"][data-sidebar-bot-row], [aria-current="page"] [data-sidebar-bot-row]')?.getAttribute("data-sidebar-bot-row")).toBe("cloud:scout");
  });
});
