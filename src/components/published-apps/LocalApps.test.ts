// @vitest-environment happy-dom
// Saved apps on the apps page: the section, its cards and their actions, and one app open in its own view.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalApp } from "../../../shared/local-apps";
import { botHtmlDocument } from "../../../shared/app-frame/document";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  state: {
    bots: [{ id: "mira", name: "Mira", color: "blue", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "sales" }] }],
    groups: [],
    config: {},
  },
  dispatch: vi.fn(),
  api: vi.fn(),
}));
class FakeApiError extends Error {
  status: number; body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) { super(message); this.status = status; this.body = body; }
}
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, flushBotPatches: async () => null }), api: fixture.api, ApiError: FakeApiError }));
vi.mock("@/state/api", () => ({ api: fixture.api, ApiError: FakeApiError }));

const { PublishedAppsPage } = await import("./PublishedAppsPage");
const { REMOVE_UNDO_MS } = await import("./LocalAppsSection");
const { openLocalApp, resetLocalApps } = await import("@/lib/local-apps");
const { resetAppInstall } = await import("@/lib/local-app-install");

const NOW = Date.parse("2026-11-26T12:00:00Z");
const app = (id: string, name: string, more: Partial<LocalApp> = {}): LocalApp => ({
  id, name, botId: "mira", bot: { name: "Mira", color: "blue" }, threadId: "sales", messageId: `m-${id}`, versions: [{ rev: 0, at: NOW }], rev: 0,
  createdAt: NOW - 86_400_000, updatedAt: NOW - 2 * 3_600_000, manifest: { name }, chat: true, ...more,
});
const BOARD = app("la_board0000000000000", "Sales board", { versions: [{ rev: 0, at: NOW }, { rev: 1, at: NOW }, { rev: 2, at: NOW }], rev: 2 });
const ROTA = app("la_rota00000000000000", "Staff rota", { chat: false, botId: "gone", bot: null });
const SAMPLE = app("la_starter_ledger__", "Ledger", { chat: false, botId: "", threadId: "", messageId: "la_starter_ledger__", bot: null, sample: true });

let root: Root;
let host: HTMLElement;
let saved: LocalApp[];
let published: unknown[];
const calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  saved = [BOARD, ROTA];
  published = [];
  calls.length = 0;
  fixture.dispatch.mockReset();
  fixture.state.config = {};
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (path === "/api/published-apps") return { apps: published };
    if (path.startsWith("/api/published-apps/framing")) return { framing: "blocked" };
    if (path === "/api/local-apps") return { apps: saved };
    if (path.endsWith("/rpc")) return { columns: [{ name: "region", type: "VARCHAR" }], rows: [{ region: "north" }], truncated: false };
    const one = /^\/api\/local-apps\/(la_\w+)(\/app)?/.exec(path);
    const found = saved.find((candidate) => candidate.id === one?.[1]);
    if (!one || !found) throw new FakeApiError("No such app.", 404);
    if (one[2]) {
      const rev = new URL(path, "http://omb.test").searchParams.get("rev");
      return botHtmlDocument({ messageId: found.messageId, rev: Number(rev), html: `<p>${found.name} version ${Number(rev) + 1}</p>`,
        ...(found.manifest.uses ? { uses: found.manifest.uses as Array<"data" | "state"> } : {}) });
    }
    if (method === "DELETE") { saved = saved.filter((candidate) => candidate.id !== found.id); return { ok: true }; }
    if (method === "PATCH") {
      const change = JSON.parse(init!.body!) as { name?: string; pinnedRev?: number | null };
      const next = { ...found, ...(change.name ? { name: change.name } : {}),
        ...(change.pinnedRev !== undefined ? { pinnedRev: change.pinnedRev ?? undefined, rev: change.pinnedRev ?? found.versions.at(-1)!.rev } : {}) };
      saved = saved.map((candidate) => (candidate.id === found.id ? next : candidate));
      return { app: next };
    }
    return { app: found };
  });
  resetLocalApps();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const show = async () => { await act(async () => root.render(createElement(PublishedAppsPage))); await settle(); };
const card = (id: string) => host.querySelector<HTMLElement>(`[data-local-app="${id}"]`)!;
const button = (within: ParentNode, name: string) => [...within.querySelectorAll("button")].find((one) => (one.getAttribute("aria-label") ?? one.textContent?.trim()) === name)!;
const menuItem = (name: string) => [...([...document.querySelectorAll("[role=menu]")].at(-1)?.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]") ?? [])]
  .find((one) => one.textContent?.includes(name))!;

describe("saved apps on the apps page", () => {
  it("says how to get one when nothing is saved, above the published apps", async () => {
    saved = [];
    published = [{ id: "page-a", source: "page", title: "Bakery", url: "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/", bot: { id: "mira", name: "Mira" },
      threadId: "main", publishedAt: NOW, access: "link", canDelete: true }];
    await show();
    const headings = [...host.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings.slice(0, 2)).toEqual(["On this computer", "Published"]);
    expect(host.querySelector("[data-local-apps-empty]")?.textContent).toBe("No saved apps yetAsk a bot to build a page, then Save as app.");
  });

  it("shows one empty state, not two, when nothing is saved or published", async () => {
    saved = [];
    await show();
    expect(host.querySelector("[data-apps-empty]")?.textContent).toBe("No apps yetAsk a bot to build a page, then save it as an app or publish it.");
    expect(host.querySelector("[data-local-apps-empty]")).toBeNull();
    expect(host.textContent).not.toContain("Nothing published yet");
  });

  it("words the place as this Cloud on a Cloud", async () => {
    fixture.state.config = { cloudHome: true };
    await show();
    expect(host.querySelector("h2")?.textContent).toBe("In this Cloud");
  });

  it("shows a card for each app with its name, its bot and when it changed", async () => {
    await show();
    expect([...host.querySelectorAll("[data-local-app-name]")].map((title) => title.textContent)).toEqual(["Sales board", "Staff rota"]);
    expect(card(BOARD.id).textContent).toContain("Mira · 2 hr ago");
    expect(card(ROTA.id).textContent).toContain("Bot removed");
    expect(button(card(BOARD.id), "Open in its own window")).toBeUndefined();
  });

  it("labels a starter app Sample, with no chat to go to, in its card and its view", async () => {
    saved = [BOARD, SAMPLE];
    await show();
    expect(card(SAMPLE.id).textContent).toContain("Sample · 2 hr ago");
    expect(card(SAMPLE.id).textContent).not.toContain("Bot removed");
    act(() => button(card(SAMPLE.id), "More for Ledger").click());
    expect(menuItem("Go to chat")).toBeUndefined();
    expect(menuItem("Remove")).toBeDefined();
    act(() => button(card(SAMPLE.id), "Open Ledger").click());
    await settle();
    const header = host.querySelector("header")!.textContent;
    expect(header).toContain("Sample");
    expect(header).not.toContain("By ");
    expect(button(host, "Go to chat")).toBeUndefined();
    expect(host.textContent).not.toContain("chat it came from");
    expect(host.querySelector(`[data-local-app-view="${SAMPLE.id}"]`)?.getAttribute("data-local-app-state")).toBe("live");
  });

  it("opens an app in its own window on the desktop", async () => {
    const openWindow = vi.fn(async () => true);
    vi.stubGlobal("ogb", { localApps: { openWindow, openChat: vi.fn() } });
    await show();
    act(() => button(card(BOARD.id), "Open in its own window").click());
    expect(openWindow).toHaveBeenCalledWith(BOARD.id);
  });

  it("renames in place, Esc keeping the old name", async () => {
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    await act(async () => menuItem("Rename").click());
    const field = card(BOARD.id).querySelector<HTMLInputElement>("[data-local-app-name-field]")!;
    expect(document.activeElement).toBe(field);
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    act(() => button(card(BOARD.id), "More for Sales board").click());
    await act(async () => menuItem("Rename").click());
    const again = card(BOARD.id).querySelector<HTMLInputElement>("[data-local-app-name-field]")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(again, "Team board");
      again.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(calls.find((call) => call.method === "PATCH")).toEqual({ method: "PATCH", path: `/api/local-apps/${BOARD.id}`, body: { name: "Team board" } });
    expect(card(BOARD.id).querySelector("[data-local-app-name]")?.textContent).toBe("Team board");
  });

  it("removes at once with Undo, and tells the server only once Undo has passed", async () => {
    await show();
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    await act(async () => menuItem("Remove").click());
    expect(card(ROTA.id)).toBeNull();
    expect(host.textContent).toContain("“Staff rota” removed.");
    act(() => button(host, "Undo").click());
    expect(card(ROTA.id)).not.toBeNull();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    await act(async () => menuItem("Remove").click());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOVE_UNDO_MS + 10); });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`/api/local-apps/${ROTA.id}`]);
    expect(host.textContent).not.toContain("removed.");
  });

  it("goes to the chat it came from, and offers no chat once it is gone", async () => {
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    await act(async () => menuItem("Go to chat").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "mira", threadId: "sales" });
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    expect(menuItem("Go to chat")).toBeUndefined();
  });
});

describe("a saved app open in its own view", () => {
  it("fills the page with the app's frame, sandboxed as in the chat, under its name", async () => {
    await show();
    act(() => button(card(BOARD.id), "Open Sales board").click());
    await settle();
    const view = host.querySelector<HTMLElement>(`[data-local-app-view="${BOARD.id}"]`)!;
    expect(view.dataset.localAppState).toBe("live");
    expect(host.querySelector("h1")?.textContent).toBe("Sales board");
    const frame = view.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.srcdoc).toContain("Sales board version 3");
    expect(calls.find((call) => call.path.startsWith(`/api/local-apps/${BOARD.id}/app`))!.path).toContain("rev=2");
    act(() => button(host, "Back to apps").click());
    expect(host.querySelector("[data-local-app-view]")).toBeNull();
  });

  it("keeps an earlier version from the version menu, and follows the newest again", async () => {
    openLocalApp(BOARD.id);
    await show();
    expect(host.querySelector("[data-local-app-version]")?.textContent).toBe("Version 3");
    act(() => button(host, "Versions").click());
    await act(async () => menuItem("Version 1").click());
    await settle();
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ pinnedRev: 0 });
    expect(host.querySelector("[data-local-app-version]")?.textContent).toBe("Version 1 · kept");
    expect(host.querySelector("iframe")!.srcdoc).toContain("Sales board version 1");
    act(() => button(host, "Versions").click());
    await act(async () => menuItem("Newest").click());
    await settle();
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ pinnedRev: null });
    expect(host.querySelector("iframe")!.srcdoc).toContain("Sales board version 3");
  });

  it("goes to the chat from the header, and has none for an app whose chat is gone", async () => {
    openLocalApp(BOARD.id);
    await show();
    act(() => button(host, "Go to chat").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "mira", threadId: "sales" });
    act(() => openLocalApp(ROTA.id));
    await settle();
    expect(button(host, "Go to chat")).toBeUndefined();
  });

  it("says so when the app is gone", async () => {
    openLocalApp("la_missing0000000000");
    await show();
    expect(host.textContent).toContain("This app is no longer here.");
  });
});

describe("installing a saved app on this computer", () => {
  let bridge: { list: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn>; uninstall: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    resetAppInstall();
    let installed = [BOARD.id];
    bridge = {
      list: vi.fn(async () => ({ available: true, apps: installed.map((id) => ({ id, name: "x", path: "/p" })) })),
      install: vi.fn(async (input: { id: string; name: string }) => { installed = [...installed, input.id]; return { ok: true, app: { id: input.id, name: input.name, path: "/p" } }; }),
      uninstall: vi.fn(async (id: string) => { installed = installed.filter((one) => one !== id); return { ok: true, removed: true }; }),
      cleanup: vi.fn(async () => []),
    };
    vi.stubGlobal("ogb", { appInstall: bridge });
  });

  it("tidies launchers against the whole list, marks an installed app, and offers Install or Uninstall in its menu", async () => {
    await show();
    expect(bridge.cleanup).toHaveBeenCalledWith([BOARD.id, ROTA.id]);
    expect(card(BOARD.id).querySelector("[data-local-app-installed]")?.textContent).toBe("Installed");
    expect(card(ROTA.id).querySelector("[data-local-app-installed]")).toBeNull();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    expect(menuItem("Uninstall")).toBeDefined();
    expect(menuItem("Install on this computer")).toBeUndefined();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    await act(async () => menuItem("Install on this computer").click());
    await settle();
    expect(bridge.install).toHaveBeenCalledWith({ id: ROTA.id, name: "Staff rota" });
    expect(card(ROTA.id).querySelector("[data-local-app-installed]")).not.toBeNull();
    expect(document.querySelector("[role=dialog], [role=alertdialog]")).toBeNull();
  });

  it("installs a starter app like any saved one", async () => {
    saved = [BOARD, SAMPLE];
    await show();
    act(() => button(card(SAMPLE.id), "More for Ledger").click());
    await act(async () => menuItem("Install on this computer").click());
    await settle();
    expect(bridge.install).toHaveBeenCalledWith({ id: SAMPLE.id, name: "Ledger" });
    expect(card(SAMPLE.id).querySelector("[data-local-app-installed]")).not.toBeNull();
  });

  it("says so in one line when a launcher couldn't be written", async () => {
    bridge.install.mockResolvedValueOnce({ ok: false, reason: "failed" });
    await show();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    await act(async () => menuItem("Install on this computer").click());
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("“Staff rota” couldn't be installed on this computer. Try again.");
  });

  it("offers nothing where launchers can't be installed", async () => {
    bridge.list.mockResolvedValue({ available: false, apps: [] });
    await show();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    expect(menuItem("Install on this computer")).toBeUndefined();
    expect(host.querySelector("[data-local-app-installed]")).toBeNull();
  });

  it("uninstalls once a removal is past its Undo, and reinstalls under a new name", async () => {
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    await act(async () => menuItem("Rename").click());
    const field = card(BOARD.id).querySelector<HTMLInputElement>("[data-local-app-name-field]")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Team board");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(bridge.install).toHaveBeenCalledWith({ id: BOARD.id, name: "Team board" });
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    act(() => button(card(BOARD.id), "More for Team board").click());
    await act(async () => menuItem("Remove").click());
    expect(bridge.uninstall).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOVE_UNDO_MS + 10); });
    expect(bridge.uninstall).toHaveBeenCalledWith(BOARD.id);
  });

  it("offers Uninstall from the app view's header, and marks it installed there", async () => {
    openLocalApp(BOARD.id);
    await show();
    expect(host.querySelector("header [data-local-app-installed]")).not.toBeNull();
    act(() => button(host, "More for Sales board").click());
    await act(async () => menuItem("Uninstall").click());
    await settle();
    expect(bridge.uninstall).toHaveBeenCalledWith(BOARD.id);
    expect(host.querySelector("header [data-local-app-installed]")).toBeNull();
  });
});

describe("an installed app's icon on the Desktop", () => {
  type Bridge = Record<"list" | "install" | "uninstall" | "cleanup" | "addToDesktop" | "removeFromDesktop", ReturnType<typeof vi.fn>>;
  let bridge: Bridge;
  let installed: string[];
  let onDesktop: string[];
  const order: string[] = [];
  beforeEach(() => {
    resetAppInstall();
    installed = [BOARD.id];
    onDesktop = [];
    order.length = 0;
    bridge = {
      list: vi.fn(async () => ({ available: true, apps: installed.map((id) => ({ id, name: "x", path: "/p", desktop: onDesktop.includes(id) })) })),
      install: vi.fn(async (input: { id: string; name: string }) => { order.push(`install ${input.id}`); installed = [...installed, input.id]; return { ok: true, app: { id: input.id, name: input.name, path: "/p" } }; }),
      uninstall: vi.fn(async (id: string) => { installed = installed.filter((one) => one !== id); onDesktop = onDesktop.filter((one) => one !== id); return { ok: true, removed: true }; }),
      cleanup: vi.fn(async () => []),
      addToDesktop: vi.fn(async (id: string) => { order.push(`desktop ${id}`); onDesktop = [...onDesktop, id]; return { ok: true, app: { id, name: "x", path: "/p", desktop: true } }; }),
      removeFromDesktop: vi.fn(async (id: string) => { onDesktop = onDesktop.filter((one) => one !== id); return { ok: true, removed: true }; }),
    };
    vi.stubGlobal("ogb", { appInstall: bridge });
  });

  it("offers Add to Desktop on the card, and Remove from Desktop once it is there", async () => {
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    expect(menuItem("Remove from Desktop")).toBeUndefined();
    await act(async () => menuItem("Add to Desktop").click());
    await settle();
    expect(bridge.addToDesktop).toHaveBeenCalledWith(BOARD.id);
    expect(bridge.install).not.toHaveBeenCalled();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    expect(menuItem("Add to Desktop")).toBeUndefined();
    expect(menuItem("Uninstall")).toBeDefined();
    await act(async () => menuItem("Remove from Desktop").click());
    await settle();
    expect(bridge.removeFromDesktop).toHaveBeenCalledWith(BOARD.id);
    act(() => button(card(BOARD.id), "More for Sales board").click());
    expect(menuItem("Add to Desktop")).toBeDefined();
    expect(document.querySelector("[role=dialog], [role=alertdialog]")).toBeNull();
  });

  it("installs an app that is not installed yet, then adds it to the Desktop", async () => {
    await show();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    expect(menuItem("Install on this computer")).toBeDefined();
    await act(async () => menuItem("Add to Desktop").click());
    await settle();
    expect(order).toEqual([`install ${ROTA.id}`, `desktop ${ROTA.id}`]);
    expect(card(ROTA.id).querySelector("[data-local-app-installed]")).not.toBeNull();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    expect(menuItem("Uninstall")).toBeDefined();
    expect(menuItem("Remove from Desktop")).toBeDefined();
  });

  it("says so in one line when the install or the Desktop icon failed, and never adds one after a failed install", async () => {
    bridge.addToDesktop.mockResolvedValueOnce({ ok: false, reason: "no-desktop" });
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    await act(async () => menuItem("Add to Desktop").click());
    await settle();
    expect([...host.querySelectorAll("[role=alert]")].map((line) => line.textContent)).toEqual(["“Sales board” couldn't be added to the Desktop. Try again."]);
    bridge.install.mockResolvedValueOnce({ ok: false, reason: "failed" });
    bridge.addToDesktop.mockClear();
    act(() => button(card(ROTA.id), "More for Staff rota").click());
    await act(async () => menuItem("Add to Desktop").click());
    await settle();
    expect(bridge.addToDesktop).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("[role=alert]")].map((line) => line.textContent)).toEqual(["“Staff rota” couldn't be installed on this computer. Try again."]);
  });

  it("offers no Desktop item in a desktop build without it", async () => {
    vi.stubGlobal("ogb", { appInstall: { list: bridge.list, install: bridge.install, uninstall: bridge.uninstall, cleanup: bridge.cleanup } });
    await show();
    act(() => button(card(BOARD.id), "More for Sales board").click());
    expect(menuItem("Uninstall")).toBeDefined();
    expect(menuItem("Add to Desktop")).toBeUndefined();
  });

  it("offers both from the app view's header, and Uninstall clears the Desktop item", async () => {
    onDesktop = [BOARD.id];
    openLocalApp(BOARD.id);
    await show();
    act(() => button(host, "More for Sales board").click());
    expect(menuItem("Uninstall")).toBeDefined();
    await act(async () => menuItem("Remove from Desktop").click());
    await settle();
    expect(bridge.removeFromDesktop).toHaveBeenCalledWith(BOARD.id);
    act(() => button(host, "More for Sales board").click());
    await act(async () => menuItem("Add to Desktop").click());
    await settle();
    expect(bridge.addToDesktop).toHaveBeenCalledWith(BOARD.id);
    act(() => button(host, "More for Sales board").click());
    await act(async () => menuItem("Uninstall").click());
    await settle();
    act(() => button(host, "More for Sales board").click());
    expect(menuItem("Install on this computer")).toBeDefined();
    expect(menuItem("Add to Desktop")).toBeDefined();
  });

  it("shows a failed Desktop change in the app view's one line", async () => {
    bridge.removeFromDesktop.mockResolvedValueOnce({ ok: false, reason: "invalid-id" });
    onDesktop = [BOARD.id];
    openLocalApp(BOARD.id);
    await show();
    act(() => button(host, "More for Sales board").click());
    await act(async () => menuItem("Remove from Desktop").click());
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("“Sales board” couldn't be removed from the Desktop. Try again.");
  });
});

describe("a saved app's live data and state", () => {
  const frame = () => host.querySelector<HTMLIFrameElement>("[data-local-app-view] iframe")!;
  const fromPage = (data: unknown) => act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, source: frame().contentWindow as unknown as MessageEventSource }));
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  let toPage: Array<{ id?: unknown; result?: unknown; error?: { message?: string } }>;
  const handshake = async () => {
    toPage = [];
    vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation((message: unknown) => { toPage.push(message as never); });
    await fromPage({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    await fromPage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  };
  const QUERY = { jsonrpc: "2.0", id: "q1", method: "mausbot/data/query", params: { sql: "SELECT region FROM sales" } };

  it("queries its bot's data through the page route, with its source conversation and message", async () => {
    saved = [{ ...BOARD, manifest: { name: "Sales board", uses: ["data", "state"] } }];
    openLocalApp(BOARD.id);
    await show();
    await handshake();
    await fromPage(QUERY);
    const call = calls.find((one) => one.path.endsWith("/rpc"))!;
    expect(call).toEqual({ method: "POST", path: `/api/bots/mira/apps/m-${BOARD.id}/rpc`,
      body: { threadId: "sales", method: "mausbot/data/query", params: { sql: "SELECT region FROM sales" } } });
    expect(toPage.find((message) => message.id === "q1")?.result).toEqual({ columns: [{ name: "region", type: "VARCHAR" }], rows: [{ region: "north" }], truncated: false });
    expect(host.querySelector("[data-local-app-chat-gone]")).toBeNull();
  });

  it("says once that its chat was deleted, and answers the page's calls with why, asking no server", async () => {
    saved = [{ ...ROTA, manifest: { name: "Staff rota", uses: ["data"] } }];
    openLocalApp(ROTA.id);
    await show();
    expect(host.querySelector("[data-local-app-chat-gone]")?.textContent).toBe("This app's chat was deleted, so its live data and saved state aren't available.");
    await handshake();
    await fromPage(QUERY);
    expect(calls.some((one) => one.path.endsWith("/rpc"))).toBe(false);
    expect(toPage.find((message) => message.id === "q1")?.error?.message).toBe("This app's chat was deleted, so its live data and saved state aren't available.");
  });
});

