// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";
import { resetPlacesTogetherForTest } from "@/lib/places-together";
import { OtherPlaceLine } from "./OtherPlaceBots";
import { PlacesTogetherSwitch } from "./PlacesTogetherSwitch";
import { SettingsLook } from "./SettingsPrimitives";

let container: HTMLDivElement, root: Root, said: PlacesTogetherState, changed: () => void;
const row = (home: "computer" | "cloud", id: string, name: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home, id, threadId: `t-${id}`, name, color: "blue", ...over });
const state = (over: Partial<PlacesTogetherState> = {}): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: "ready", bots: [row("cloud", "scout", "Scout"), row("cloud", "nova", "Nova", { unread: true, title: "Research" })] }, ...over });
const page = {
  state: vi.fn(async () => said),
  set: vi.fn(async (on: boolean) => { said = on ? state() : state({ on: false, other: null }); return said; }),
  open: vi.fn(async () => true),
  onChanged: vi.fn((cb: () => void) => { changed = cb; return () => {}; }),
};
const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const render = async (...parts: Array<ReturnType<typeof createElement>>) => { await act(async () => root.render(createElement("div", null, ...parts))); await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  said = state();
  window.ogb = { placesTogether: page } as never;
  for (const fn of Object.values(page)) fn.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetPlacesTogetherForTest(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

it("draws nothing with the switch off, nothing in a browser, and nothing while the other place has rows: they are in the list", async () => {
  said = state({ on: false, other: null });
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place]")).toBeNull();
  said = state();
  await act(async () => changed());
  expect(q("[data-other-place]")).toBeNull();
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  delete (window as { ogb?: unknown }).ogb;
  root = createRoot(container);
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place]")).toBeNull();
  expect(page.state).toHaveBeenCalledTimes(2);
});

it("nothing while the first read is under way: no spinner, the rows come when they come", async () => {
  said = state({ other: { home: "cloud", state: "loading", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place]")).toBeNull();
});

it("a Cloud this window is not signed in to says so in one quiet line that opens it, never a card or a dialog", async () => {
  const openMyCloud = vi.fn(async () => {});
  window.ogb = { placesTogether: page, cloudSendPage: { openMyCloud } } as never;
  said = state({ other: { home: "cloud", state: "signin", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place-line]")!.textContent).toBe("Open My Cloud once to sign in.");
  expect(q("[data-other-place]")!.getAttribute("data-other-place-state")).toBe("signin");
  await act(async () => q("button[data-other-place-line]")!.click());
  expect(openMyCloud).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector("[role=alert], [role=dialog]")).toBeNull();
});

it("a sleeping or unreachable Cloud with nothing kept says so as normal, and the line opens it; while it wakes the line only says so", async () => {
  const openMyCloud = vi.fn(async () => {});
  window.ogb = { placesTogether: page, cloudSendPage: { openMyCloud } } as never;
  said = state({ other: { home: "cloud", state: "asleep", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place-line]")!.textContent).toBe("My Cloud is asleep. Open it to see its bots.");
  expect(q("[data-other-place-line]")!.className).not.toContain("danger");
  await act(async () => q("button[data-other-place-line]")!.click());
  expect(openMyCloud).toHaveBeenCalledTimes(1);
  said = state({ other: { home: "cloud", state: "offline", bots: [] } });
  await act(async () => changed());
  expect(q("[data-other-place-line]")!.textContent).toBe("My Cloud can't be reached right now.");
  await act(async () => q("button[data-other-place-line]")!.click());
  expect(openMyCloud).toHaveBeenCalledTimes(2);
  said = state({ other: { home: "cloud", state: "waking", bots: [] } });
  await act(async () => changed());
  expect(q("[data-other-place-line]")!.tagName).toBe("P");
  expect(q("[data-other-place-line]")!.getAttribute("role")).toBe("status");
});

it("My Cloud's page says so when this computer's bots can't be read, in a line that opens nothing; nothing while they load or are listed", async () => {
  said = state({ here: "cloud", home: "computer", other: { home: "computer", state: "offline", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line" }));
  expect(q("[data-other-place-line]")!.textContent).toBe("This computer's bots can't be read right now.");
  expect(q("[data-other-place-line]")!.tagName).toBe("P");
  for (const power of ["ready", "loading"] as const) {
    said = state({ here: "cloud", home: "computer", other: { home: "computer", state: power, bots: power === "ready" ? [row("computer", "git", "Git")] : [] } });
    await act(async () => changed());
    expect(q("[data-other-place]")).toBeNull();
  }
});

it("in the avatars-only sidebar the line is its icon alone, its words its tooltip and label, and it still opens My Cloud", async () => {
  const openMyCloud = vi.fn(async () => {});
  window.ogb = { placesTogether: page, cloudSendPage: { openMyCloud } } as never;
  said = state({ other: { home: "cloud", state: "asleep", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line", icons: true }));
  const line = q("button[data-other-place-line]")!;
  expect(line.textContent).toBe("");
  expect(line.getAttribute("aria-label")).toBe("My Cloud is asleep. Open it to see its bots.");
  expect(line.getAttribute("title")).toBe("My Cloud is asleep. Open it to see its bots.");
  await act(async () => line.click());
  expect(openMyCloud).toHaveBeenCalledTimes(1);
});

it("a line is no search result: hidden while the sidebar is searched", async () => {
  said = state({ other: { home: "cloud", state: "signin", bots: [] } });
  await render(createElement(OtherPlaceLine, { key: "line", query: "scout" }));
  expect(q("[data-other-place]")).toBeNull();
});

it("the switch: no longer marked Early, says it is on by default, and is hidden where main does not offer it", async () => {
  said = state({ on: false, other: null });
  await render(createElement(SettingsLook.Provider, { key: "switch", value: true }, createElement(PlacesTogetherSwitch)));
  expect(q("[data-places-together]")!.getAttribute("data-places-together")).toBe("off");
  expect(q("[data-places-together]")!.textContent).toContain("This computer and My Cloud together");
  expect(q("[data-places-together]")!.textContent).toContain("On by default.");
  expect(q("[data-places-together]")!.textContent, "the grant covers every Cloud of the account").toContain("your Clouds' bots run commands on this computer");
  expect(q("[data-places-together] [data-settings-tag]")).toBeNull();
  await act(async () => q("[data-places-together] [role=switch]")!.click());
  expect(page.set.mock.calls).toEqual([[true]]);
  expect(q("[data-places-together]")!.getAttribute("data-places-together")).toBe("on");
  said = state({ available: false, on: false, other: null });
  await act(async () => changed());
  expect(q("[data-places-together]")).toBeNull();
});

it("My Cloud's page shows the switch only to turn it off: turning it on is this computer's", async () => {
  said = state({ here: "cloud", on: false, other: null });
  await render(createElement(SettingsLook.Provider, { key: "switch", value: true }, createElement(PlacesTogetherSwitch)));
  expect(q("[data-places-together]")).toBeNull();
  said = state({ here: "cloud", home: "computer", other: { home: "computer", state: "ready", bots: [] } });
  await act(async () => changed());
  expect(q("[data-places-together]")!.getAttribute("data-places-together")).toBe("on");
  await act(async () => q("[data-places-together] [role=switch]")!.click());
  expect(page.set.mock.calls).toEqual([[false]]);
});
