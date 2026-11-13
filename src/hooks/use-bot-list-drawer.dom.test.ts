// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBotListDrawer, type DrawerPlace } from "./use-bot-list-drawer";

const START: DrawerPlace = { selectedId: "scout", botThread: "private", groupThread: undefined, view: "chat", pluginsOpen: false, settingsOpen: false };

let root: Root;
let container: HTMLElement;

/** The app's wiring: the menu button, and the list with a conversation row and the "Just me / Team" switch. */
function Shell({ place }: { place: DrawerPlace }) {
  const drawer = useBotListDrawer(place);
  return h("div", { onClickCapture: drawer.open ? drawer.noteAction : undefined, onKeyDownCapture: drawer.open ? drawer.noteAction : undefined },
    h("button", { "aria-label": "Open bot list", "aria-expanded": drawer.open, onClick: drawer.show }),
    h("aside", null,
      h("div", { "data-team-side": "me" }, h("button", { "data-option": "team" })),
      h("button", { "data-row": "thread" }),
      h("button", { "data-row": "close", onClick: drawer.hide })));
}

const show = (place: DrawerPlace) => act(async () => root.render(h(Shell, { place })));
const press = (selector: string) => act(async () => container.querySelector<HTMLElement>(selector)!.click());
const expanded = () => container.querySelector('[aria-label="Open bot list"]')!.getAttribute("aria-expanded");

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await show(START);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens from the menu button and says so", async () => {
  expect(expanded()).toBe("false");
  await press('[aria-label="Open bot list"]');
  expect(expanded()).toBe("true");
  await press('[data-row="close"]');
  expect(expanded()).toBe("false");
});

it("stays open while the conversation under it changes by itself, as it does when the app starts", async () => {
  await press('[aria-label="Open bot list"]');
  await show({ ...START, botThread: "shared" });
  expect(expanded(), "the app opened the shared chat").toBe("true");
  await show({ ...START, botThread: "private" });
  expect(expanded(), "and went back to the person's own").toBe("true");
  await show({ ...START, selectedId: "room", botThread: undefined, groupThread: "room-1" });
  await press('[aria-label="Open bot list"]');
  await show({ ...START, selectedId: "room", botThread: undefined, groupThread: "room-2" });
  expect(expanded(), "a group chat's conversation too").toBe("true");
});

it("closes when a conversation the person picked in the list comes on screen", async () => {
  await press('[aria-label="Open bot list"]');
  await press('[data-row="thread"]');
  expect(expanded(), "still open while the switch is on its way").toBe("true");
  await show({ ...START, botThread: "picked" });
  expect(expanded()).toBe("false");
});

it("closes for a conversation picked with the keyboard", async () => {
  await press('[aria-label="Open bot list"]');
  await act(async () => { container.querySelector('[data-row="thread"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await show({ ...START, botThread: "picked" });
  expect(expanded()).toBe("false");
});

it("stays open after the Just me / Team switch, which only changes what the list shows", async () => {
  await press('[aria-label="Open bot list"]');
  await press('[data-option="team"]');
  await show({ ...START, botThread: "shared" });
  expect(expanded()).toBe("true");
});

it("forgets an earlier pick each time it opens", async () => {
  await press('[aria-label="Open bot list"]');
  await press('[data-row="thread"]');
  await show({ ...START, botThread: "picked" });
  await press('[aria-label="Open bot list"]');
  await show({ ...START, botThread: "shared" });
  expect(expanded()).toBe("true");
});

it.each([
  ["another chat", { selectedId: "other" }],
  ["another page", { view: "routines" }],
  ["the apps page", { pluginsOpen: true }],
  ["a bot's settings", { settingsOpen: true }],
] as const)("closes when the person goes to %s, however they got there", async (_where, change) => {
  await press('[aria-label="Open bot list"]');
  await show({ ...START, ...change });
  expect(expanded()).toBe("false");
});
