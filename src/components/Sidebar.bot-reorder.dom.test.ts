// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

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
const BOT_TYPE = "application/x-openmausbot-sidebar-bot";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: `${id}-t`, title: "Chat", createdAt: 1 }], ...extra,
});
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;
const render = (bots: Bot[]) => flushSync(() => root.render(createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots, selectedId: bots[0]!.id }, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(Sidebar, { open: true, onClose: () => {} }),
})));

function dataTransfer() {
  const data = new Map<string, string>();
  return { data, effectAllowed: "all", dropEffect: "none", get types() { return [...data.keys()]; },
    setData: (type: string, value: string) => { data.set(type, value); }, getData: (type: string) => data.get(type) ?? "",
    setDragImage: () => {}, files: [], items: [] };
}
function fire(target: Element, type: string, transfer: ReturnType<typeof dataTransfer>, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  flushSync(() => target.dispatchEvent(event));
  return event;
}
/** The draggable element around a bot's row: the one carrying the drag handlers. */
const dragHost = (id: string) => document.querySelector(`[data-sidebar-bot-row="${id}"]`)?.closest('[draggable="true"]') ?? null;

beforeEach(() => {
  dispatch.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Each row 50px tall, one under another, so a drop on a row's lower edge lands after it.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rows = [...document.querySelectorAll('[draggable="true"]')];
    const index = Math.max(0, rows.indexOf(this));
    return { top: index * 50, bottom: index * 50 + 50, height: 50, left: 0, right: 200, width: 200, x: 0, y: index * 50, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const order = () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")].map((row) => row.dataset.sidebarBotRow);
/** Drags `moving` onto the top or bottom edge of `onto`'s row and lets go. */
function dragOnto(moving: string, onto: string, edge: "top" | "bottom") {
  const from = dragHost(moving), target = dragHost(onto);
  expect(from, `${moving} is draggable`).not.toBeNull();
  expect(target, `${onto} is draggable`).not.toBeNull();
  const transfer = dataTransfer();
  fire(from!, "dragstart", transfer);
  expect(transfer.types).toContain(BOT_TYPE);
  const box = target!.getBoundingClientRect();
  const y = edge === "top" ? box.top + 2 : box.bottom - 2;
  fire(target!, "dragover", transfer, y);
  fire(target!, "drop", transfer, y);
  fire(from!, "dragend", transfer);
}
const saved = () => dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "botsOrdered");

for (const advanced of [false, true]) {
  describe(`dragging a bot in ${advanced ? "Advanced" : "Simple"} mode`, () => {
    beforeEach(() => { mode.advanced = advanced; });

    it("moves it below another bot and saves the order", () => {
      render([bot("alpha"), bot("bravo"), bot("charlie"), bot("delta")]);
      expect(order()).toEqual(["alpha", "bravo", "charlie", "delta"]);
      dragOnto("delta", "bravo", "bottom");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["alpha", "bravo", "delta", "charlie"] }]);
    });

    it("keeps a working bot in its place, and a bot dropped above it lands there", () => {
      render([bot("alpha"), bot("bravo"), bot("charlie"), bot("delta", { busy: true })]);
      expect(order()).toEqual(["alpha", "bravo", "charlie", "delta"]);
      dragOnto("alpha", "delta", "top");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["bravo", "charlie", "alpha", "delta"] }]);
    });

    it("moves a bot past a working one with Alt+arrow, as the rows show", () => {
      render([bot("alpha"), bot("bravo"), bot("delta", { busy: true })]);
      expect(order()).toEqual(["alpha", "bravo", "delta"]);
      const press = (id: string, key: string) => flushSync(() => document.querySelector(`[data-sidebar-bot-row="${id}"]`)!
        .dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })));
      press("alpha", "ArrowUp");
      expect(saved()).toEqual([]);
      expect(document.body.textContent).not.toContain("moved to position");
      press("bravo", "ArrowDown");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["alpha", "delta", "bravo"] }]);
      expect(document.body.textContent).toContain("Bravo moved to position 3 of 3");
    });

    it("keeps a bot waiting on the person in its place, and drops a bot below it there", () => {
      render([bot("alpha"), bot("bravo", { activity: "waiting-on-you" }), bot("charlie"), bot("delta")]);
      expect(order()).toEqual(["alpha", "bravo", "charlie", "delta"]);
      dragOnto("delta", "bravo", "bottom");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["alpha", "bravo", "delta", "charlie"] }]);
    });

    it("plans with an unread bot in its own place, like any other row", () => {
      // Saved alpha, bravo, charlie, delta, echo; delta is working and echo is unread, and both stay where they are.
      const unread = bot("echo", { tasks: [{ threadId: "echo-t", title: "Chat", createdAt: 1, unread: true }] });
      render([bot("alpha"), bot("bravo"), bot("charlie"), bot("delta", { busy: true }), unread]);
      expect(order()).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
      dragOnto("echo", "alpha", "top");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["echo", "alpha", "bravo", "charlie", "delta"] }]);
      dispatch.mockReset();
      flushSync(() => document.querySelector('[data-sidebar-bot-row="alpha"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true })));
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["bravo", "alpha", "charlie", "delta", "echo"] }]);
      expect(document.body.textContent).toContain("Alpha moved to position 2 of 5");
    });
  });
}
