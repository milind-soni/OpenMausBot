// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BROWSER_HELD_ELSEWHERE } from "../../shared/browser-held";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  capabilities: {} as Partial<DesktopCapabilities>,
  state: { config: { browserProfiles: [], browserEngine: { kind: "engine", engine: "chrome" } }, computerControl: {} } as Record<string, any>,
}));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api, useStore: () => ({ state: fixture.state }) }));
vi.mock("./BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: fixture.capabilities }) }));
const { BrowserPanel, LiveBrowser } = await import("./BrowserPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(value: string) {
    const message = JSON.parse(value) as Record<string, unknown>;
    if (message.type !== "ack") this.sent.push(message);
  }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data) })); }
  control(controller: string, more: Record<string, unknown> = {}) { this.message({ type: "control", canOperate: true, controller, generation: 1, dialog: null, ...more }); }
  refuse() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })); }
}

class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  close = vi.fn();
  constructor(readonly url: string) { FixtureEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  emit(name: string, data: unknown) { for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) })); }
}

let observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(readonly callback: () => void) { observers.push(callback); }
  observe() { queueMicrotask(this.callback); }
  disconnect() { observers = observers.filter((callback) => callback !== this.callback); }
}

const bot = { id: "pepper", name: "Pepper" } as Bot;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observers = [];
  FakeSocket.instances = [];
  FixtureEventSource.instances = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true });
  fixture.capabilities = {};
  fixture.state = { config: { browserProfiles: [], browserEngine: { kind: "engine", engine: "chrome" } }, computerControl: {} };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 3200, height: 2000, close() {} }));
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1600, bottom: 1000, width: 1600, height: 1000, toJSON() {} } as DOMRect);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render(props: Partial<Parameters<typeof LiveBrowser>[0]> = {}) {
  await act(async () => root.render(createElement(LiveBrowser, { bot, ...props })));
  await flush();
}
async function streaming(controller = "agent") {
  await render();
  const socket = FakeSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.message({ type: "viewport", width: 1600, height: 1000, zoom: 1, setting: { mode: "fill" } });
    socket.message({ type: "tabs", tabs: [{ tabId: "t1", title: "Example", url: "https://example.com/", active: true }] });
    socket.control(controller);
    socket.message(new ArrayBuffer(8));
  });
  await flush();
  return socket;
}
const pill = () => host.querySelector<HTMLButtonElement>("[data-pill]")!;
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;

describe("the browser panel's connection", () => {
  it("streams the new engine's browser over the v2 socket, sized to the panel", async () => {
    await render();
    expect(FakeSocket.instances).toHaveLength(1);
    const url = new URL(FakeSocket.instances[0]!.url);
    expect(url.pathname).toBe("/api/bots/pepper/browser/stream");
    expect(Object.fromEntries(url.searchParams)).toEqual({ maxWidth: "3200", maxHeight: "2000", width: "1600", height: "1000" });
    expect(FixtureEventSource.instances).toHaveLength(0);
    expect(host.querySelector("[data-browser-transport]")!.getAttribute("data-browser-transport")).toBe("stream");
  });

  it("uses the v1 live view on agent-browser, sized to the panel, and when the stream is refused before it opens", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(FixtureEventSource.instances[0]!.url).toBe("/api/bots/pepper/browser/live?width=1600&height=1000");
    act(() => root.unmount());
    root = createRoot(host);
    fixture.state.config.browserEngine = { kind: "engine", engine: "chrome" };
    await render();
    await act(async () => FakeSocket.instances.at(-1)!.refuse());
    await flush();
    expect(FixtureEventSource.instances).toHaveLength(2);
    expect(host.querySelector("[data-browser-transport]")!.getAttribute("data-browser-transport")).toBe("live");
  });

  it("says the browser is starting until its first frame arrives", async () => {
    await render();
    const socket = FakeSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.message({ type: "starting" });
      socket.control("unclaimed");
    });
    await flush();
    expect(host.textContent).toContain("Starting the browser…");
    await act(async () => socket.message(new ArrayBuffer(8)));
    await flush();
    expect(host.textContent).not.toContain("Starting the browser…");
  });

  it("says the browser closed after it sat unused, opens it again only when asked, and shows it once it runs", async () => {
    const socket = await streaming("unclaimed");
    await act(async () => socket.message({ type: "asleep" }));
    await flush();
    expect(host.textContent).toContain(t("browser.panel.asleep"));
    expect(socket.sent).not.toContainEqual({ type: "wake" });
    await act(async () => button(t("browser.panel.wake")).click());
    expect(socket.sent).toContainEqual({ type: "wake" });
    expect(button(t("browser.panel.waking")).disabled).toBe(true);
    await act(async () => socket.message({ type: "awake" }));
    await flush();
    expect(host.textContent).not.toContain(t("browser.panel.asleep"));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("shows the tab's address and enables history from what the stream says", async () => {
    const socket = await streaming();
    expect((host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!).value).toBe("https://example.com/");
    expect(button("Back").disabled).toBe(true);
    await act(async () => socket.message({ type: "nav", tabId: "t1", url: "https://example.com/two", loading: true, canGoBack: true, canGoForward: false }));
    expect((host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!).value).toBe("https://example.com/two");
    expect(button("Back").disabled).toBe(false);
    expect(button("Forward").disabled).toBe(true);
  });
});

describe("the native desktop browser", () => {
  const native = () => { fixture.state.config.browserEngine = { kind: "engine", engine: "native" }; };
  const layout = vi.fn();
  let take: (event: { token: string }) => void;
  let activity: (event: { token: string }) => void;
  beforeEach(() => {
    layout.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("ogb", { nativeBrowser: {
      layout,
      onTake: (callback: typeof take) => { take = callback; return () => {}; },
      onActivity: (callback: typeof activity) => { activity = callback; return () => {}; },
    } });
  });
  async function watching(controller = "agent") {
    native();
    fixture.capabilities = { nativeBrowser: { available: true } };
    await render();
    const socket = FakeSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.control(controller);
      socket.message({ type: "nativeView", token: "native-tab" });
      socket.message({ type: "tabs", tabs: [{ tabId: "t1", title: "Example", url: "https://example.test/", active: true }] });
    });
    await flush();
    return socket;
  }

  it("uses the metadata stream for the capable desktop and the real toolbar's existing control handoff", async () => {
    const socket = await watching();
    expect(new URL(socket.url).searchParams.get("native")).toBe("1");
    expect(FixtureEventSource.instances).toHaveLength(0);
    expect(host.querySelector("canvas, iframe")).toBeNull();
    expect(host.querySelector('[aria-label="Browser address"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')?.value).toBe("https://example.test/");
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ token: "native-tab", visible: true, canInput: false }));
    await act(async () => take({ token: "native-tab" }));
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, canInput: true }));
    await act(async () => button("Back").click());
    expect(socket.sent).not.toContainEqual({ type: "history", delta: -1 });
    await act(async () => socket.message({ type: "nav", url: "https://example.test/next", canGoBack: true, canGoForward: false }));
    await act(async () => button("Back").click());
    expect(socket.sent.at(-1)).toEqual({ type: "history", delta: -1 });
  });

  it("refreshes a resumed native hold on its existing socket without taking control or duplicating page input", async () => {
    const socket = await watching("you");
    const beforeActivity = socket.sent.length;
    const page = host.querySelector<HTMLElement>(`[aria-label="${t("browser.panel.pageLabel", { name: "Pepper" })}"]`);
    expect(page).not.toBeNull();
    await act(async () => {
      page!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 20, clientY: 30, bubbles: true }));
      page!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      activity({ token: "native-tab" });
    });
    expect(socket.sent.slice(beforeActivity)).toEqual([{ type: "nativeActivity" }]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("keeps remote and older clients on the image stream even when a native bridge exists", async () => {
    native();
    await render();
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket).toBeDefined();
    expect(new URL(socket.url).searchParams.has("native")).toBe(false);
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(layout).not.toHaveBeenCalled();
    fixture.capabilities = { nativeBrowser: { available: false } };
    await render();
    expect(host.querySelector("canvas")).not.toBeNull();
  });

  it("uses the existing live image fallback when a profile has no native v2 stream", async () => {
    native();
    fixture.capabilities = { nativeBrowser: { available: true } };
    await render();
    await act(async () => FakeSocket.instances.at(-1)!.refuse());
    await flush();
    expect(FixtureEventSource.instances).toHaveLength(1);
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(host.querySelector("[data-browser-transport]")?.getAttribute("data-browser-transport")).toBe("live");
  });

  it("routes native file pickers and site sign-in through the same authenticated stream", async () => {
    const uploads = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", uploads);
    const socket = await watching("you");
    await act(async () => socket.message({ type: "fileChooser", id: "file-1", multiple: false, accept: ".txt" }));
    expect(host.querySelector('[aria-label="Choose files for the page"]')).not.toBeNull();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    await act(async () => button(t("common.cancel")).click());
    await flush();
    expect(uploads).toHaveBeenCalledTimes(1);
    await act(async () => socket.message({ type: "authPrompt", tabId: "t1", id: "auth-1", origin: "https://example.test/", realm: "Fixture" }));
    const form = host.querySelector<HTMLFormElement>('[aria-label="Sign in to this site"]')!;
    expect(form).not.toBeNull();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    form.querySelector<HTMLInputElement>('[name="username"]')!.value = "Ada";
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = "fixture-only";
    await act(async () => form.requestSubmit());
    expect(socket.sent).toContainEqual({ type: "authAnswer", tabId: "t1", id: "auth-1", username: "Ada", password: "fixture-only" });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("hides the native page under the profile dialog, for another viewer and while the owner is hidden", async () => {
    const socket = await watching("you");
    await act(async () => button(t("browser.panel.profiles")).click());
    await flush();
    expect(host.querySelector("dialog[open]")).not.toBeNull();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, canInput: false }));
    await act(async () => button(t("browser.panel.closeProfiles")).click());
    await flush();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    await act(async () => socket.control("another-viewer"));
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    await act(async () => socket.control("you"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(socket.readyState).toBe(1);
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, canInput: false }));
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, canInput: true }));
  });

  it("keeps the typing dialog above the native page and sends its text through the same control", async () => {
    const socket = await watching("you");
    await act(async () => button(t("browser.panel.typeTextMenu")).click());
    await flush();
    const dialog = host.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(dialog).not.toBeNull();
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, canInput: false }));
    const input = dialog.querySelector<HTMLInputElement>('input[name="pageText"]')!;
    input.value = "Ada";
    await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    expect(socket.sent).toContainEqual({ type: "text", text: "Ada" });
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, canInput: true }));
  });

  it("keeps the existing browser menus above the native page while they are open", async () => {
    await watching("you");
    const summary = host.querySelector<HTMLElement>(`summary[aria-label="${t("browser.panel.menu")}"]`)!;
    const menu = summary.closest("details")!;
    await act(async () => summary.click());
    await flush();
    expect(menu.open).toBe(true);
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    await act(async () => summary.click());
    await flush();
    expect(menu.open).toBe(false);
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
  });

  it("clears startup on a native-ready message without waiting for an image and presents native notices once", async () => {
    const socket = await watching();
    await act(async () => socket.message({ type: "starting" }));
    expect(host.textContent).toContain(t("browser.panel.starting"));
    await act(async () => socket.message({ type: "nativeView", token: "native-tab" }));
    expect(host.textContent).not.toContain(t("browser.panel.starting"));
    await act(async () => socket.message({ type: "notice", message: "The browser needs to reconnect." }));
    expect([...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual(["The browser needs to reconnect."]);
  });

  it("retains the team thread scope and drops the former native surface after a profile switch", async () => {
    fixture.state.config.team = true;
    const socket = await watching();
    await render({ bot: { ...bot, threadId: "private-thread" } });
    const scoped = FakeSocket.instances.at(-1)!;
    expect(new URL(scoped.url).searchParams.get("threadId")).toBe("private-thread");
    await act(async () => { scoped.open(); scoped.control("agent"); scoped.message({ type: "nativeView", token: "private-tab" }); });
    await render({ bot: { ...bot, browserProfile: "guest" } });
    expect(socket.readyState).toBe(3);
    expect(scoped.readyState).toBe(3);
    expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ token: "private-tab", visible: false }));
  });
});

describe("while nobody can see the panel", () => {
  it("stops the stream while the page is hidden and reopens it when the page is back", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const socket = await streaming("unclaimed");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.instances).toEqual([socket]);
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]).not.toBe(socket);
  });

  it("keeps streaming for the viewer the page left holding the browser", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const socket = await streaming("you");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(FakeSocket.instances).toEqual([socket]);
    expect(socket.readyState).not.toBe(3);
  });
});

describe("a v1 live view whose stream dropped", () => {
  const live = () => FixtureEventSource.instances.at(-1)!;
  const emit = (name: string, data: unknown) => act(async () => live().emit(name, data));

  it("asks for the hold its last view had when the person reconnects", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    await emit("ready", { viewerId: "old-viewer" });
    await emit("error", { message: "Browser connection ended." });
    expect(host.textContent).toContain("Browser disconnected");
    await act(async () => button("Reconnect").click());
    await flush();
    expect(live().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer&width=1600&height=1000");
    await emit("ready", { viewerId: "new-viewer" });
    expect(host.textContent).not.toContain("Browser disconnected");
  });

  it("says the browser closed after it sat unused, and opens a new view only when asked", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    await emit("ready", { viewerId: "old-viewer" });
    await emit("error", { retryable: false, asleep: true, message: "This browser closed after it sat unused, to save memory." });
    await flush();
    expect(host.textContent).toContain(t("browser.panel.asleep"));
    expect(host.textContent).not.toContain("Browser disconnected");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(FixtureEventSource.instances).toHaveLength(1);
    await act(async () => button(t("browser.panel.wake")).click());
    await flush();
    expect(FixtureEventSource.instances).toHaveLength(2);
    expect(host.textContent).not.toContain(t("browser.panel.asleep"));
  });

  it("comes back when the window is focused after its retries ran out", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    vi.useFakeTimers();
    await emit("ready", { viewerId: "old-viewer" });
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await emit("error", { retryable: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    await emit("error", { retryable: true });
    expect(FixtureEventSource.instances).toHaveLength(6);
    expect(host.textContent).toContain("Browser disconnected");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(FixtureEventSource.instances).toHaveLength(7);
    expect(live().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer&width=1600&height=1000");
    await emit("ready", { viewerId: "back-viewer" });
    expect(host.textContent).not.toContain("Browser disconnected");
  });
});

describe("who holds the browser", () => {
  it("says the bot has it, takes it on Take control, and hands it back", async () => {
    const socket = await streaming("agent");
    expect(pill().textContent).toContain("Pepper has control");
    await act(async () => pill().click());
    await flush();
    expect(socket.sent).toContainEqual({ type: "takeControl" });
    expect(pill().dataset.pill).toBe("taking");
    await act(async () => socket.control("you"));
    await flush();
    expect(pill().textContent).toContain("You have control");
    await act(async () => pill().click());
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "releaseControl" });
  });

  it("says what keeping the browser means while the person has it", async () => {
    const socket = await streaming("agent");
    await act(async () => pill().click());
    await act(async () => socket.control("you"));
    await flush();
    expect(pill().title).toBe(t("browser.control.keptHint", { name: "Pepper" }));
    expect(pill().title).toContain("5 minutes");
  });

  it("shows the person their hold from another of their views, and hands it back from here", async () => {
    const socket = await streaming("agent");
    await act(async () => socket.control("agent", { owned: true }));
    await flush();
    expect(pill().dataset.pill).toBe("held");
    expect(pill().textContent).toContain("Pepper is paused for you");
    expect(pill().textContent).toContain(t("browser.control.handBack"));
    expect(pill().disabled).toBe(false);
    expect(host.textContent).not.toContain(BROWSER_HELD_ELSEWHERE);
    await act(async () => pill().click());
    await flush();
    expect(socket.sent).toEqual([{ type: "releaseControl" }]);
  });

  it("takes the browser on the first click and then sends that click, once", async () => {
    const socket = await streaming("unclaimed");
    const canvas = host.querySelector("canvas")!;
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 250, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: 400, clientY: 250, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", bubbles: true }));
    });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    const mouse = socket.sent.filter((message) => message.type === "mouse");
    expect(mouse.map((message) => [message.action, message.x, message.y])).toEqual([["down", 400, 250], ["up", 400, 250]]);
  });

  it("keeps the browser for the person holding it when the panel grows past its frame cap, as full screen does", async () => {
    const socket = await streaming("unclaimed");
    await act(async () => pill().click());
    await act(async () => socket.control("you"));
    await flush();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1800, bottom: 1100, width: 1800, height: 1100, toJSON() {} } as DOMRect);
    await act(async () => { for (const observer of observers) observer(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(FakeSocket.instances).toEqual([socket]);
    expect(socket.sent).toContainEqual({ type: "frameCap", maxWidth: 3600, maxHeight: 2200 });
    expect(pill().dataset.pill).toBe("yours");
  });

  it("says another device holds the browser, and sends nothing from this one", async () => {
    const socket = await streaming("another-viewer");
    expect(host.textContent).toContain(BROWSER_HELD_ELSEWHERE);
    expect(pill().disabled).toBe(true);
    const canvas = host.querySelector("canvas")!;
    await act(async () => { canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", bubbles: true })); });
    expect(socket.sent).toEqual([]);
  });

  it("returns focus from the page to the address bar on Shift+Escape", async () => {
    await streaming("you");
    const page = host.querySelector("textarea")!;
    page.focus();
    await act(async () => { page.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", shiftKey: true, bubbles: true })); });
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Browser address"]'));
  });
});

describe("what the person does in the panel", () => {
  it("navigates from the address bar, taking the browser first", async () => {
    const socket = await streaming("agent");
    const address = host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!;
    await act(async () => { address.focus(); });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(address, "example.org/docs");
      address.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { address.form!.requestSubmit(); });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "navigate", url: "https://example.org/docs" });
  });

  it("types into the page from the typing dialog only while it holds the browser", async () => {
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    const socket = await streaming("you");
    await act(async () => button("Type or paste text…").click());
    const field = host.querySelector<HTMLInputElement>('input[name="pageText"]')!;
    field.value = "hello there";
    await act(async () => { field.form!.requestSubmit(); });
    await flush();
    expect(socket.sent).toContainEqual({ type: "text", text: "hello there" });
    expect(field.value).toBe("");
  });

  it("sizes and zooms the page from the menu while it holds the browser", async () => {
    const socket = await streaming("you");
    await act(async () => button("Phone · 390×844").click());
    expect(socket.sent).toContainEqual({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await act(async () => button("Zoom in").click());
    expect(socket.sent).toContainEqual({ type: "zoom", factor: 1.1 });
    await act(async () => socket.message({ type: "viewport", width: 1455, height: 909, zoom: 1.1, setting: { mode: "fill" } }));
    expect(host.textContent).toContain("110%");
  });

  it("takes the browser for a sign-in and opens its page on a blank tab", async () => {
    await render({ signIn: { url: "https://accounts.example.com/login", site: "example.com", nonce: 1 } });
    const socket = FakeSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "about:blank", active: true }] });
      socket.control("unclaimed");
    });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "navigate", url: "https://accounts.example.com/login" });
  });
});

describe("a published page's Open", () => {
  const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
  const show = (page: { url?: string; nonce: number }) => act(async () => root.render(createElement(LiveBrowser, { bot, page })));

  it("reveals a page already opened by the server without taking control, waking or creating a blank tab", async () => {
    const socket = await streaming("agent");
    await show({ nonce: 1 });
    await show({ url: PAGE, nonce: 1 });
    expect(socket.sent).toEqual([]);
    await act(async () => socket.message({ type: "asleep" }));
    await show({ url: "", nonce: 2 });
    await show({ url: " ", nonce: 3 });
    expect(socket.sent).toEqual([]);
  });

  it("opens the page in a new tab, once, taking the browser first, so the bot's own tab stays as it was", async () => {
    const socket = await streaming("agent");
    await show({ url: PAGE, nonce: 1 });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "tabNew", url: PAGE });
    await show({ url: PAGE, nonce: 1 });
    await flush();
    expect(socket.sent.filter((message) => message.type === "tabNew")).toHaveLength(1);
    await show({ url: PAGE, nonce: 2 });
    await flush();
    expect(socket.sent.filter((message) => message.type === "tabNew")).toHaveLength(2);
  });

  it("waits for the view to connect, and wakes a browser that sat unused before opening the page", async () => {
    await render({ page: { url: PAGE, nonce: 1 } });
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.sent).toEqual([]);
    await act(async () => { socket.open(); socket.control("unclaimed"); socket.message({ type: "asleep" }); });
    await flush();
    expect(socket.sent).toEqual([{ type: "wake" }]);
    await act(async () => socket.message({ type: "awake" }));
    await flush();
    expect(socket.sent).toEqual([{ type: "wake" }, { type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "tabNew", url: PAGE });
  });
});

describe("a sign-in that stops at a passkey", () => {
  const PASSKEY = "https://accounts.google.com/v3/signin/challenge/pk/presend?TL=fixture";
  const notice = () => host.querySelector("section[role=status]");
  const go = async (socket: FakeSocket, url: string) => {
    await act(async () => socket.message({ type: "nav", tabId: "t1", url, loading: false, canGoBack: true, canGoForward: false }));
    await flush();
  };

  it("explains the passkey step and the ways that work, and goes once the page moves on", async () => {
    const socket = await streaming("you");
    expect(notice()).toBeNull();
    await go(socket, PASSKEY);
    expect(notice()?.textContent).toContain(t("browser.passkey.title"));
    expect(notice()?.textContent).toContain(t("browser.passkey.body", { provider: "Google" }));
    expect(notice()?.textContent).toContain(t("browser.passkey.appsGoogle", { name: "Pepper" }));
    expect(notice()?.textContent).toContain(t("browser.passkey.otherWayGoogle"));
    expect(notice()?.querySelectorAll("li")).toHaveLength(2);
    await go(socket, "https://accounts.google.com/v3/signin/challenge/pwd?TL=fixture");
    expect(notice()).toBeNull();
  });

  it("stays dismissed on that step only", async () => {
    const socket = await streaming("you");
    await go(socket, PASSKEY);
    await act(async () => button(t("browser.passkey.dismiss")).click());
    expect(notice()).toBeNull();
    await go(socket, "https://accounts.google.com/v3/signin/identifier");
    await go(socket, `${PASSKEY}&again=1`);
    expect(notice()).not.toBeNull();
  });

  it("on My Cloud, offers the lent PC by name, or how to lend one", async () => {
    fixture.state.config.cloudHome = true;
    fixture.api.mockImplementation(async (path: string) => path === "/api/shared-computers"
      ? { computers: [{ name: "Office PC", online: true, scopes: { screen: true } }] } : { ok: true });
    const socket = await streaming("you");
    await go(socket, PASSKEY);
    expect(notice()?.textContent).toContain(t("browser.passkey.lentPc", { computer: "Office PC", name: "Pepper" }));
    act(() => root.unmount());
    root = createRoot(host);
    fixture.api.mockImplementation(async (path: string) => path === "/api/shared-computers" ? { computers: [{ name: "Office PC", online: false, scopes: { screen: true } }] } : { ok: true });
    const again = await streaming("you");
    await go(again, PASSKEY);
    expect(notice()?.textContent).toContain(t("browser.passkey.lendPc", { name: "Pepper" }));
  });
});

describe("the browser panel before the browser is installed", () => {
  async function renderUninstalled(scopes: string[]) {
    fixture.state = { config: { browserProfiles: [], browserEngine: { kind: "unavailable", installable: true } }, computerControl: {} };
    fixture.api.mockImplementation(async (path: string) => path === "/api/auth/session" ? { scopes } : { ok: true });
    await act(async () => root.render(createElement(BrowserPanel, { bot })));
    await flush();
  }

  it("offers the install here instead of sending an admin to the panel they are on", async () => {
    await renderUninstalled(["admin"]);
    expect(host.textContent).toContain(t("browser.panel.engineNotInstalledHelp", { name: "Pepper" }));
    expect(host.textContent).not.toContain(t("browser.notInstalled"));
    expect(button(t("browser.panel.installEngine")).disabled).toBe(false);
  });

  it("keeps the setup steps for someone who cannot install", async () => {
    await renderUninstalled([]);
    expect(host.textContent).toContain(t("browser.notInstalled"));
    expect(button(t("browser.panel.installEngine")).disabled).toBe(true);
  });
});
