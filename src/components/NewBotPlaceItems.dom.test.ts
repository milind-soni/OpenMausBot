// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { NewBotChoice, PlacesTogetherState } from "@/lib/places-together";

const store = vi.hoisted(() => ({ instances: [] as Array<{ displayName: string; driverKind: string; snapshot: { state: string; freeFallback?: boolean } }> }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: unknown) => unknown) => select(store) }));

import { resetPlacesTogetherForTest } from "@/lib/places-together";
import { NewBotOtherPlaceItem, useNewBotHereLabel } from "./NewBotPlaceItems";

let container: HTMLDivElement, root: Root, said: PlacesTogetherState, choice: NewBotChoice | null;
const joined = (here: "computer" | "cloud"): PlacesTogetherState => ({ v: 1, available: true, on: true, here, other: { home: here === "cloud" ? "computer" : "cloud", state: "ready", bots: [] } });
const page = {
  state: vi.fn(async () => said), set: vi.fn(), open: vi.fn(), onChanged: vi.fn(() => () => {}),
  newBotChoice: vi.fn(async () => choice), newBot: vi.fn(async () => true), onNewBot: vi.fn(() => () => {}),
};
const onHere = vi.fn(), onClose = vi.fn();
const items = () => [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")];
function Menu() {
  const here = useNewBotHereLabel();
  return createElement("div", null,
    createElement("button", { role: "menuitem", "data-new-bot-home": "here", onClick: onHere }, here ?? "New bot"),
    here && createElement(NewBotOtherPlaceItem, { itemClass: "item", onClose }));
}
const render = async () => { await act(async () => root.render(createElement(Menu))); await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  said = joined("computer");
  choice = { home: "cloud", state: "ready", ais: [{ name: "Claude", kind: "claudeAgent" }, { name: "Included AI", kind: "included" }] };
  store.instances = [{ displayName: "Claude", driverKind: "claude", snapshot: { state: "available" } }, { displayName: "Codex", driverKind: "codex", snapshot: { state: "available" } }];
  window.ogb = { placesTogether: page } as never;
  for (const fn of [...Object.values(page), onHere, onClose]) fn.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetPlacesTogetherForTest(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

it("with the switch off it is the one New bot item, and main is asked nothing about the other place", async () => {
  said = { v: 1, available: true, on: false, here: "computer", other: null };
  await render();
  expect(items().map((item) => item.textContent)).toEqual(["New bot"]);
  await act(async () => items()[0]!.click());
  expect(onHere).toHaveBeenCalledTimes(1);
  expect(page.newBotChoice).not.toHaveBeenCalled();
  expect(page.newBot).not.toHaveBeenCalled();
});

it("on: asks only where the bot lives, the place on screen first, and says what differs there", async () => {
  await render();
  expect(items().map((item) => item.getAttribute("data-new-bot-home"))).toEqual(["here", "cloud"]);
  expect(items()[0]!.textContent).toBe("New bot on this computer");
  expect(items()[1]!.textContent).toBe("New bot on My CloudSigned in only there: Included AI. Signed in only here: Codex.");
  await act(async () => items()[0]!.click());
  expect(onHere).toHaveBeenCalledTimes(1);
  expect(page.newBot).not.toHaveBeenCalled();
  await act(async () => items()[1]!.click());
  expect(page.newBot).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onHere).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector("[role=dialog], [role=alert]")).toBeNull();
});

it("on My Cloud's page the Cloud comes first; a sleeping Cloud and a place with no AI are said plainly", async () => {
  said = joined("cloud");
  choice = { home: "computer", state: "ready", ais: [] };
  await render();
  expect(items().map((item) => item.textContent)).toEqual(["New bot on My Cloud", "New bot on this computerNo AI is signed in there yet."]);
  expect(document.body.querySelector("[data-new-bot-differs]")!.textContent).toBe("No AI is signed in there yet.");
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  root = createRoot(container);
  said = joined("computer");
  choice = { home: "cloud", state: "asleep", ais: null };
  await render();
  expect(document.body.querySelector("[data-new-bot-differs]")!.textContent).toBe("My Cloud is asleep. This wakes it.");
});

it("says nothing extra when both places have the same AIs", async () => {
  choice = { home: "cloud", state: "ready", ais: [{ name: "Codex", kind: "codex" }, { name: "Claude", kind: "claudeAgent" }] };
  await render();
  expect(document.body.querySelector("[data-new-bot-differs]")).toBeNull();
});

it("counts an AI that only works through free no-login models on neither side", async () => {
  store.instances = [{ displayName: "Claude", driverKind: "claude", snapshot: { state: "available" } }, { displayName: "OpenCode", driverKind: "opencode", snapshot: { state: "available", freeFallback: true } }];
  choice = { home: "cloud", state: "ready", ais: [{ name: "Claude", kind: "claudeAgent" }] };
  await render();
  expect(document.body.querySelector("[data-new-bot-differs]")).toBeNull();
});

it("never shows an account's email address in the line: the engine's name stands in", async () => {
  store.instances = [{ displayName: "Claude", driverKind: "claude", snapshot: { state: "available" } }];
  choice = { home: "cloud", state: "ready", ais: [{ name: "Claude", kind: "claudeAgent" }, { name: "alice@example.com", kind: "codex" }] };
  await render();
  expect(document.body.querySelector("[data-new-bot-differs]")!.textContent).toBe("Signed in only there: OpenAI.");
});

it("a Cloud whose page would not hear the request shows the item disabled with one plain line, and a click does nothing", async () => {
  said = { ...joined("computer"), other: { home: "cloud", state: "ready", bots: [], newBot: false } };
  await render();
  const item = items()[1] as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(item.textContent).toBe("New bot on My CloudMy Cloud needs its next update for this.");
  await act(async () => item.click());
  expect(page.newBot).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
