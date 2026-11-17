// @vitest-environment happy-dom
import { StrictMode, act, createElement as h, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, reducer, type Action } from "@/state/store";
import { SIDE_PANEL_OPEN_KEY, useRememberedSidePanel } from "./use-remembered-side-panel";

let root: Root;
let container: HTMLElement;
let send: (action: Action) => void;
let options = { enabled: true, inspector: true };

/** The app's wiring: the real reducer, and the panels App draws from its open flags. */
function Shell() {
  const [state, dispatch] = useReducer(reducer, initialState);
  send = dispatch;
  useRememberedSidePanel(state, dispatch, options);
  return h("div", null,
    state.activeView === "chat" && h("main", { "data-view": "chat" }),
    state.appSettingsOpen && h("dialog", { "data-modal": "settings" }),
    state.computerOpen && h("aside", { "data-panel": "computer" }),
    state.inspectorOpen && h("aside", { "data-panel": "inspector" }));
}

/** A fresh app start: a new store, as after a restart. */
const start = async (strict = false) => {
  await act(async () => root?.unmount());
  container.replaceChildren();
  root = createRoot(container);
  await act(async () => root.render(strict ? h(StrictMode, null, h(Shell)) : h(Shell)));
};
const run = (action: Action) => act(async () => send(action));
const panel = () => container.querySelector("aside")?.getAttribute("data-panel") ?? null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  options = { enabled: true, inspector: true };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("opens the bot's screen again after a restart when the person left it open", async () => {
  await start();
  expect(panel()).toBeNull();
  await run({ type: "toggleComputer" });
  expect(panel()).toBe("computer");

  await start();
  expect(panel()).toBe("computer");
});

it("opens the bot info panel again after a restart", async () => {
  await start();
  await run({ type: "toggleInspector" });

  await start();
  expect(panel()).toBe("inspector");
});

it("stays closed after a restart when the person closed the panel", async () => {
  await start();
  await run({ type: "toggleComputer" });
  await run({ type: "toggleComputer", open: false });

  await start();
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBeNull();
});

it("opens the panel again when the person comes back from routines, without forgetting it there", async () => {
  await start();
  await run({ type: "toggleComputer" });
  await run({ type: "showRoutines" });
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("computer");

  await run({ type: "showChat" });
  expect(panel()).toBe("computer");
});

it("leaves panels closed and the choice untouched in the phone layout", async () => {
  await start();
  await run({ type: "toggleComputer" });
  options = { enabled: false, inspector: true };

  await start();
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("computer");
});

it("opens the remembered panel when the window grows out of the phone layout", async () => {
  await start();
  await run({ type: "toggleComputer" });
  options = { enabled: false, inspector: true };
  await start();
  expect(panel()).toBeNull();

  options = { enabled: true, inspector: true };
  await act(async () => root.render(h(Shell)));
  expect(panel()).toBe("computer");
});

it("doesn't open the bot info panel where the app never shows it", async () => {
  await start();
  await run({ type: "toggleInspector" });
  options = { enabled: true, inspector: false };

  await start();
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("inspector");
});

it("keeps the choice when the bot info panel can't show, also when React replays effects", async () => {
  await start();
  await run({ type: "toggleInspector" });
  options = { enabled: true, inspector: false };

  await start(true);
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("inspector");
});

it("keeps Settings open when the window grows out of the phone layout", async () => {
  await start();
  await run({ type: "toggleComputer" });
  options = { enabled: false, inspector: true };
  await start();
  await run({ type: "toggleAppSettings", open: true });

  options = { enabled: true, inspector: true };
  await act(async () => root.render(h(Shell)));
  expect(container.querySelector("[data-modal=settings]")).not.toBeNull();
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("computer");
});

it("opens the panel again after Settings closes it", async () => {
  await start();
  await run({ type: "toggleComputer" });
  await run({ type: "toggleAppSettings", open: true });
  expect(panel()).toBeNull();
  expect(localStorage.getItem(SIDE_PANEL_OPEN_KEY)).toBe("computer");

  await run({ type: "toggleAppSettings", open: false });
  expect(panel()).toBe("computer");
});

it("starts with panels closed when storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  await start();
  expect(panel()).toBeNull();
  await run({ type: "toggleComputer" });
  expect(panel()).toBe("computer");
  vi.restoreAllMocks();
});
