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

const dragHost = (id: string) => document.querySelector<HTMLElement>(`[data-bot-drag-row="${id}"]`);
const pointer = (type: string, clientY: number) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY });
let under: Element | null = null;

beforeEach(() => {
  dispatch.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  under = null;
  document.elementFromPoint = () => under;
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Each row 50px tall, one under another, so a drop on a row's lower edge lands after it.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rows = [...document.querySelectorAll("[data-bot-drag-row]")];
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
/** Presses `moving`'s row, drags it over the top or bottom edge of `onto`'s row and lets go, or presses Escape first. */
function dragOnto(moving: string, onto: string, edge: "top" | "bottom", cancel = false) {
  const from = dragHost(moving), target = dragHost(onto);
  expect(from, `${moving} is draggable`).not.toBeNull();
  expect(target, `${onto} is draggable`).not.toBeNull();
  const start = from!.getBoundingClientRect().top + 25;
  flushSync(() => from!.dispatchEvent(pointer("pointerdown", start)));
  const box = target!.getBoundingClientRect();
  const y = edge === "top" ? box.top + 2 : box.bottom - 2;
  under = target;
  flushSync(() => window.dispatchEvent(pointer("pointermove", y)));
  expect(from!.style.pointerEvents).toBe("none");
  if (cancel) flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  flushSync(() => window.dispatchEvent(pointer("pointerup", y)));
  expect(from!.style.transform).toBe("");
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

    it("puts a bot dropped above a working one first among the rest, without storing the working one's place", () => {
      // Saved alpha, bravo, charlie, delta; delta is working, so it is drawn first.
      render([bot("alpha"), bot("bravo"), bot("charlie"), bot("delta", { busy: true })]);
      expect(order()).toEqual(["delta", "alpha", "bravo", "charlie"]);
      dragOnto("charlie", "delta", "top");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["charlie", "alpha", "bravo", "delta"] }]);
    });

    it("says only a keyboard move the rows show: Alt+Up past a working bot changes nothing", () => {
      render([bot("alpha"), bot("bravo"), bot("delta", { busy: true })]);
      expect(order()).toEqual(["delta", "alpha", "bravo"]);
      const press = (id: string, key: string) => flushSync(() => document.querySelector(`[data-sidebar-bot-row="${id}"]`)!
        .dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })));
      press("alpha", "ArrowUp");
      expect(saved()).toEqual([]);
      expect(document.body.textContent).not.toContain("moved to position");
      press("alpha", "ArrowDown");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["bravo", "alpha", "delta"] }]);
      expect(document.body.textContent).toContain("Alpha moved to position 3 of 3");
    });

    it("moves the open bot with Alt+Up/Down while typing is elsewhere, but not over text being written", () => {
      render([bot("alpha"), bot("bravo"), bot("charlie")]);
      const field = document.createElement("textarea");
      document.body.append(field);
      const press = (key: string) => flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })));
      press("ArrowDown");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["bravo", "alpha", "charlie"] }]);
      field.value = "draft";
      press("ArrowDown");
      expect(saved()).toHaveLength(1);
      field.remove();
    });

    it("puts the bot back when Escape is pressed mid-drag", () => {
      render([bot("alpha"), bot("bravo"), bot("charlie")]);
      dragOnto("charlie", "alpha", "top", true);
      expect(saved()).toEqual([]);
    });

    it("moves a bot below a waiting one's place among the rows as drawn", () => {
      render([bot("alpha"), bot("bravo", { activity: "waiting-on-you" }), bot("charlie"), bot("delta")]);
      expect(order()).toEqual(["bravo", "alpha", "charlie", "delta"]);
      dragOnto("delta", "bravo", "bottom");
      expect(saved()).toEqual([{ type: "botsOrdered", botIds: ["delta", "alpha", "bravo", "charlie"] }]);
    });
  });
}
