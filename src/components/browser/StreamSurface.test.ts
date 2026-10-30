// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewStreamControl, PreviewStreamEvents, PreviewStreamInput } from "@/lib/browser-stream-client";
import { controlPill } from "./ChromeRow";
import { letterbox, mapToPage, mapToSurface, StreamSurface } from "./StreamSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = { width: 1600, height: 1000 };
let frame = { width: 3200, height: 2000 };
let host: HTMLDivElement;
let root: Root;
let observers: Array<() => void> = [];

class FakeResizeObserver {
  constructor(readonly callback: () => void) { observers.push(callback); }
  observe() { queueMicrotask(this.callback); }
  disconnect() { observers = observers.filter((callback) => callback !== this.callback); }
}

beforeEach(() => {
  frame = { width: 3200, height: 2000 };
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("createImageBitmap", async () => ({ ...frame, close() {} }));
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: box.width, bottom: box.height, ...box, toJSON() {} } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(box.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(box.height);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const control = (controller: PreviewStreamControl["controller"], more: Partial<PreviewStreamControl> = {}): PreviewStreamControl => ({ canOperate: true, controller, generation: 1, dialog: null, ...more });
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(props: Partial<Parameters<typeof StreamSurface>[0]> = {}) {
  const input = vi.fn<(message: PreviewStreamInput) => void>();
  const client = { send: vi.fn<(message: PreviewStreamInput) => boolean>(() => true), stop: vi.fn() };
  let events!: PreviewStreamEvents;
  const connect = vi.fn((_target: unknown, handlers: PreviewStreamEvents) => { events = handlers; return client; });
  const onLeave = vi.fn();
  await act(async () => root.render(createElement(StreamSurface, { connect, input, onLeave, ...props })));
  await flush();
  const canvas = host.querySelector("canvas")!;
  const page = host.querySelector("textarea")!;
  const show = async (next: PreviewStreamControl | null, viewport = { width: 1600, height: 1000 }) => {
    await act(async () => {
      events.onViewport(viewport);
      events.onConnectedChange(true);
      events.onControl?.(next as PreviewStreamControl);
      events.onFrame(new ArrayBuffer(8));
    });
    await flush();
  };
  return { input, client, connect, onLeave, canvas, page, show, events: () => events };
}

const pointer = (canvas: HTMLCanvasElement, type: string, x: number, y: number) => act(async () => {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", bubbles: true }));
});
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;

describe("the picture and the page", () => {
  it("maps a point through the letterbox both ways, and refuses one outside the picture", () => {
    expect(letterbox({ width: 1600, height: 1200 }, { width: 3200, height: 2000 })).toEqual({ width: 1600, height: 1000, left: 0, top: 100 });
    const rect = { left: 10, top: 20, width: 1600, height: 1200 };
    const viewport = { width: 1600, height: 1000 };
    expect(mapToPage(rect, { width: 3200, height: 2000 }, viewport, 10 + 800, 20 + 100 + 500, false)).toEqual({ x: 800, y: 500, scale: 1 });
    expect(mapToPage(rect, { width: 3200, height: 2000 }, viewport, 400, 20 + 50, false)).toBeNull();
    expect(mapToPage(rect, { width: 3200, height: 2000 }, viewport, 400, 20 + 50, true)).toMatchObject({ y: 0 });
    expect(mapToSurface({ x: 800, y: 500, width: 200, height: 30 }, { width: 1600, height: 1200 }, { width: 3200, height: 2000 }, viewport)).toEqual({ left: 800, top: 600, width: 200, height: 30 });
    expect(mapToPage({ left: 0, top: 0, width: 800, height: 500 }, { width: 2560, height: 1600 }, { width: 1280, height: 800 }, 400, 250, false)).toEqual({ x: 640, y: 400, scale: 1.6 });
  });

  it("fills the panel: it connects with the panel's size and a frame cap of that size times the screen's scale", async () => {
    const { connect } = await mount();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]![0]).toEqual({ maxWidth: 3200, maxHeight: 2000, width: 1600, height: 1000 });
  });

  it("sends a resize while it only watches, so the page keeps filling the panel", async () => {
    const { client, show } = await mount();
    await show(control("agent"));
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1200, bottom: 900, width: 1200, height: 900, toJSON() {} } as DOMRect);
    await act(async () => { for (const observer of observers) observer(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(client.send).toHaveBeenCalledWith({ type: "resize", width: 1200, height: 900 });
  });

  it("raises its frame cap in place when the panel outgrows it, so the person keeps the browser they hold", async () => {
    const { client, connect, show } = await mount();
    await show(control("you"));
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1800, bottom: 1100, width: 1800, height: 1100, toJSON() {} } as DOMRect);
    await act(async () => { for (const observer of observers) observer(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(client.send).toHaveBeenCalledWith({ type: "frameCap", maxWidth: 3600, maxHeight: 2200 });
    expect(connect).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("sizes the page to this panel again when it takes control, so the page fits the view in use", async () => {
    const { client, show } = await mount();
    await show(control("agent"));
    client.send.mockClear();
    await show(control("you"));
    expect(client.send).toHaveBeenCalledWith({ type: "resize", width: 1600, height: 1000 });
  });

  it("sends a watcher's press in page pixels to the panel's control rules, but nothing while another viewer holds the browser", async () => {
    const { input, canvas, page, show } = await mount();
    await show(control("agent"));
    await pointer(canvas, "pointerdown", 400, 250);
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ type: "mouse", action: "down", x: 400, y: 250, button: "left" }));
    expect(page.disabled).toBe(false);
    input.mockClear();
    await show(control("another-viewer"));
    await pointer(canvas, "pointerdown", 400, 250);
    expect(input).not.toHaveBeenCalled();
    expect(page.disabled).toBe(true);
  });

  it("returns to the app's controls on Shift+Escape, and keeps Escape alone in the page", async () => {
    const { input, onLeave, page, show } = await mount();
    await show(control("you"));
    page.focus();
    await act(async () => { page.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); });
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ type: "key", action: "down", key: "Escape" }));
    expect(onLeave).not.toHaveBeenCalled();
    input.mockClear();
    await act(async () => { page.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", shiftKey: true, bubbles: true })); });
    expect(onLeave).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(page);
  });
});

describe("what the page asks of the person", () => {
  it("offers the page's file picker to the person in control and sends their files to it", async () => {
    const fetches: Array<{ url: string; body: FormData }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { fetches.push({ url, body: init.body as FormData }); return new Response(null, { status: 204 }); }));
    const { show, events } = await mount();
    await show(control("you"));
    await act(async () => events().onFileChooser?.({ multiple: true, accept: ".txt", uploadUrl: "/api/bots/pepper/browser/upload?chooser=c1", credentials: true }));
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(host.textContent).toContain("The page asks for files.");
    expect(picker.multiple).toBe(true);
    expect(picker.accept).toBe(".txt");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe("/api/bots/pepper/browser/upload?chooser=c1");
    expect((fetches[0]!.body.get("file") as File).name).toBe("notes.txt");
    expect(host.textContent).not.toContain("The page asks for");
    await act(async () => events().onFileChooser?.({ multiple: false, accept: "", uploadUrl: "/api/bots/pepper/browser/upload?chooser=c2", credentials: true }));
    await act(async () => button("Cancel").click());
    await flush();
    expect(fetches[1]!.url).toBe("/api/bots/pepper/browser/upload?chooser=c2");
    expect(fetches[1]!.body.getAll("file")).toEqual([]);
  });

  it("offers what the page downloaded, saved from the bot's computer on Save", async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ href: this.getAttribute("href")!, download: this.download }); });
    const { show, events } = await mount();
    await show(control("you"));
    await act(async () => events().onDownload?.({ fileName: "report.csv", sizeBytes: 8, url: "/api/bots/pepper/browser/download/d1" }));
    expect(host.textContent).toContain("Downloaded report.csv");
    await act(async () => button("Save").click());
    expect(clicked).toEqual([{ href: "/api/bots/pepper/browser/download/d1", download: "report.csv" }]);
    expect(host.textContent).not.toContain("Downloaded report.csv");
  });

  it("copies what the page copied to this device, and offers a Copy button when the device refuses", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { show, events } = await mount();
    await show(control("you"));
    await act(async () => events().onClipboard?.("copied words"));
    await flush();
    expect(writeText).toHaveBeenCalledWith("copied words");
    expect(host.textContent).not.toContain("The page copied text");
    writeText.mockRejectedValueOnce(new Error("not allowed"));
    await act(async () => events().onClipboard?.("second"));
    await flush();
    expect(host.textContent).toContain("The page copied text");
    await act(async () => button("Copy").click());
    expect(writeText).toHaveBeenLastCalledWith("second");
  });

  it("draws a dropdown list where the page has it and sends the option chosen, or nothing on Escape", async () => {
    const { client, show, events } = await mount();
    await show(control("you"));
    const popup = { type: "selectPopup", id: "list-1", options: [{ label: "Apple", disabled: false }, { label: "Banana", disabled: true }, { label: "Cherry", disabled: false }], selectedIndex: 0, rect: { x: 20, y: 100, width: 200, height: 30 } };
    await act(async () => events().onMessage?.(popup));
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    expect([...list.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(list.style.left).toBe("20px");
    expect(list.style.top).toBe("132px");
    await act(async () => (list.querySelectorAll<HTMLElement>('[role="option"]')[1]!).click());
    expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectChoose" }));
    await act(async () => (list.querySelectorAll<HTMLElement>('[role="option"]')[2]!).click());
    expect(client.send).toHaveBeenCalledWith({ type: "selectChoose", id: "list-1", index: 2 });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => events().onMessage?.({ ...popup, id: "list-2" }));
    await act(async () => { host.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ id: "list-2" }));
  });

  it("answers a page's dialog only from the person in control, and shows none of it while another viewer holds the browser", async () => {
    const { client, show } = await mount();
    const dialog = { type: "confirm", message: "Leave this page?", defaultValue: "" };
    await show(control("agent", { dialog }));
    expect(host.textContent).toContain("Leave this page?");
    expect(host.textContent).toContain("Take control to respond.");
    await show(control("you", { dialog }));
    await act(async () => button("Accept").click());
    expect(client.send).toHaveBeenCalledWith({ type: "dialog", accept: true });
    await show(control("another-viewer", { dialog }));
    expect(host.textContent).not.toContain("Leave this page?");
  });

  it("answers a site's sign-in prompt by the tab and challenge it showed", async () => {
    const { client, show, events } = await mount();
    await show(control("agent"));
    await act(async () => events().onMessage?.({ type: "authPrompt", tabId: "t2", id: "c7", origin: "http://intranet.example", realm: "Staff" }));
    await show(control("agent"));
    expect(host.querySelector('[aria-label="Sign in to this site"]')).toBeNull();
    await show(control("you"));
    expect(host.textContent).toContain("http://intranet.example asks for “Staff”");
    host.querySelector<HTMLInputElement>('input[name="username"]')!.value = "ada";
    host.querySelector<HTMLInputElement>('input[name="password"]')!.value = "secret";
    await act(async () => { host.querySelector<HTMLFormElement>('[aria-label="Sign in to this site"]')!.requestSubmit(); });
    expect(client.send).toHaveBeenCalledWith({ type: "authAnswer", tabId: "t2", id: "c7", username: "ada", password: "secret" });
    expect(host.querySelector('[aria-label="Sign in to this site"]')).toBeNull();
    await act(async () => events().onMessage?.({ type: "authPrompt", tabId: "t1", id: "c8", origin: "http://other.example", realm: "" }));
    await act(async () => events().onMessage?.({ type: "authPromptClosed", id: "c7" }));
    expect(host.textContent).toContain("http://other.example");
    await act(async () => events().onMessage?.({ type: "authPromptClosed", id: "c8" }));
    expect(host.querySelector('[aria-label="Sign in to this site"]')).toBeNull();
  });

  it("shows the bot's cursor where it acts, and hides it while the person has control", async () => {
    const { show, events } = await mount();
    await show(control("agent"));
    await act(async () => events().onPointer?.({ phase: "click", x: 800, y: 500, sequence: 3 }));
    const cursor = host.querySelector<HTMLElement>("[data-agent-cursor]")!;
    expect(cursor.style.transform).toBe("translate3d(800px, 500px, 0)");
    await show(control("you"));
    expect(host.querySelector("[data-agent-cursor]")).toBeNull();
  });
});

describe("who has the browser", () => {
  it("names each state from this viewer's side", () => {
    expect(controlPill(false, null, "")).toBe("connecting");
    expect(controlPill(true, control("unclaimed"), "")).toBe("watching");
    expect(controlPill(true, control("agent"), "")).toBe("bot");
    expect(controlPill(true, control("you"), "")).toBe("yours");
    expect(controlPill(true, control("another-viewer"), "")).toBe("elsewhere");
    expect(controlPill(true, control("agent", { owned: true }), "")).toBe("held");
    expect(controlPill(true, control("agent"), "pending")).toBe("taking");
    expect(controlPill(true, control("agent"), "slow")).toBe("waiting");
  });
});
