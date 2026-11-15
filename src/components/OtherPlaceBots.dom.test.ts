// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";
import { resetPlacesTogetherForTest } from "@/lib/places-together";
import { OtherPlaceBots, OwnBotHomeMark } from "./OtherPlaceBots";
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
const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const render = async (...parts: Array<ReturnType<typeof createElement>>) => { await act(async () => root.render(createElement("div", null, ...parts))); await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  said = state();
  window.ogb = { placesTogether: page } as never;
  for (const fn of Object.values(page)) fn.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetPlacesTogetherForTest(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

it("draws nothing with the switch off, and nothing in a browser", async () => {
  said = state({ on: false, other: null });
  await render(createElement(OtherPlaceBots, { key: "list" }), createElement(OwnBotHomeMark, { key: "mark" }));
  expect(q("[data-other-place]")).toBeNull();
  expect(q("[data-bot-home]")).toBeNull();
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  delete (window as { ogb?: unknown }).ogb;
  root = createRoot(container);
  await render(createElement(OtherPlaceBots, { key: "list" }));
  expect(q("[data-other-place]")).toBeNull();
  expect(page.state).toHaveBeenCalledTimes(1);
});

it("lists My Cloud's bots under their own heading, each with the cloud mark, and a click opens that bot on My Cloud", async () => {
  await render(createElement(OtherPlaceBots, { key: "list" }));
  expect(q("[data-other-place]")!.getAttribute("data-other-place")).toBe("cloud");
  expect(q("[data-section]")!.getAttribute("data-section")).toBe("On My Cloud");
  expect(all("[data-placed-bot]").map((item) => item.getAttribute("data-placed-bot"))).toEqual(["cloud:scout", "cloud:nova"]);
  expect(all("[data-placed-bot] svg[data-bot-home='cloud']").length).toBe(2);
  expect(q('[data-placed-bot="cloud:nova"] [data-testid="unread-dot"]')).toBeTruthy();
  expect(q('[data-placed-bot="cloud:scout"] [data-testid="unread-dot"]')).toBeNull();
  expect(q("[data-other-place-line]")).toBeNull();
  await act(async () => q('[data-placed-bot="cloud:nova"]')!.click());
  expect(page.open.mock.calls).toEqual([["nova"]]);
});

it("on My Cloud's page: this computer's bots carry no cloud, and the page's own rows do", async () => {
  said = state({ here: "cloud", other: { home: "computer", state: "ready", bots: [row("computer", "scout", "Scout")] } });
  await render(createElement(OtherPlaceBots, { key: "list" }), createElement("span", { key: "own", "data-own": "" }, createElement(OwnBotHomeMark)));
  expect(q("[data-section]")!.getAttribute("data-section")).toBe("On this computer");
  expect(q('[data-placed-bot="computer:scout"] [data-bot-home="cloud"]')).toBeNull();
  expect(q("[data-own] [data-bot-home='cloud']")).toBeTruthy();
});

it("a sleeping, waking or unreachable Cloud keeps its bots, dimmed, under one short line, and they still open", async () => {
  for (const [power, line] of [["asleep", "My Cloud is asleep. Open a bot to wake it."], ["waking", "My Cloud is waking up…"], ["offline", "My Cloud can't be reached right now."]] as const) {
    said = state({ other: { home: "cloud", state: power, bots: [row("cloud", "scout", "Scout")] } });
    await render(createElement(OtherPlaceBots, { key: "list" }));
    await act(async () => changed());
    expect(q("[data-other-place-line]")!.textContent).toBe(line);
    expect(q("[data-other-place-line]")!.getAttribute("role")).toBe("status");
    expect(q('[data-placed-bot="cloud:scout"]')!.className).toContain("opacity-60");
    expect((q('[data-placed-bot="cloud:scout"]') as HTMLButtonElement).disabled).toBe(false);
  }
  expect(document.body.querySelector("[role=alert], [role=dialog]")).toBeNull();
});

it("a bot with the same id as one of this page's own is its own row: it carries the other home, and its click names that home's bot", async () => {
  said = state({ other: { home: "cloud", state: "ready", bots: [row("cloud", "scout", "Scout there", { unread: true })] } });
  await render(createElement("div", { key: "own", "data-own-bot": "scout" }, "Scout here"), createElement(OtherPlaceBots, { key: "list" }));
  expect(q('[data-placed-bot="cloud:scout"]')!.getAttribute("data-bot-home")).toBe("cloud");
  expect(q('[data-placed-bot="cloud:scout"]')!.textContent).toContain("Scout there");
  expect(q("[data-own-bot] [data-testid='unread-dot']")).toBeNull();
  await act(async () => q('[data-placed-bot="cloud:scout"]')!.click());
  expect(page.open.mock.calls).toEqual([["scout"]]);
});

it("a Cloud this window is not signed in to says so in one line, with no rows", async () => {
  said = state({ other: { home: "cloud", state: "signin", bots: [] } });
  await render(createElement(OtherPlaceBots, { key: "list" }));
  expect(q("[data-other-place-line]")!.textContent).toBe("Open My Cloud once to sign in.");
  expect(all("[data-placed-bot]")).toEqual([]);
});

it("follows the sidebar's search, and hides the heading when nothing there matches", async () => {
  await render(createElement(OtherPlaceBots, { key: "list", query: "research" }));
  expect(all("[data-placed-bot]").map((item) => item.getAttribute("data-placed-bot"))).toEqual(["cloud:nova"]);
  await render(createElement(OtherPlaceBots, { key: "list", query: "zzz" }));
  expect(q("[data-other-place]")).toBeNull();
});

it("the switch: marked Early, off until turned on, and hidden where main does not offer it", async () => {
  said = state({ on: false, other: null });
  await render(createElement(SettingsLook.Provider, { key: "switch", value: true }, createElement(PlacesTogetherSwitch)));
  expect(q("[data-places-together]")!.getAttribute("data-places-together")).toBe("off");
  expect(q("[data-places-together]")!.textContent).toContain("This computer and My Cloud together");
  expect(q("[data-places-together] [data-settings-tag]")!.textContent).toBe("Early");
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
  said = state({ here: "cloud", other: { home: "computer", state: "ready", bots: [] } });
  await act(async () => changed());
  expect(q("[data-places-together]")!.getAttribute("data-places-together")).toBe("on");
  await act(async () => q("[data-places-together] [role=switch]")!.click());
  expect(page.set.mock.calls).toEqual([[false]]);
});
