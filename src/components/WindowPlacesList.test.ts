// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import { setLocale } from "@/lib/i18n";
import { refreshPlaces } from "@/lib/places";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: () => null }));
const { ChromeRail } = await import("./ChromeRail");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const place = (id: string, name: string, extra: Partial<RailPlace> = {}): RailPlace => ({ id, name, color: null, kind: "cloud", opens: true, ...extra });
const COMPUTER = place("local", "This computer", { kind: "computer", active: true });
const SEVERAL = [COMPUTER, place("home", "My Cloud"), place("second", "Second"), place("acme", "Acme", { kind: "team" }), place("vps", "Office", { kind: "server" })];
let state: RailState;
let opening: ((besideRail: boolean) => void) | null;
let asked: boolean | null;
const workspaces = { places: vi.fn(async () => state), open: vi.fn(async () => {}), add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), onChanged: vi.fn(() => () => {}) };
const rail = { expand: vi.fn(async () => {}), listAsked: vi.fn(async () => { const was = asked; asked = null; return was; }), listClosed: vi.fn(async () => {}),
  onOpenList: vi.fn((callback: (besideRail: boolean) => void) => { opening = callback; return () => { opening = null; }; }), onSkin: vi.fn(() => () => {}) };
let host: HTMLDivElement, root: Root | null = null;
const flush = async () => { for (let round = 0; round < 3; round++) await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
async function mount() {
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(createElement(ChromeRail)); });
  await flush();
}
const list = () => document.querySelector<HTMLElement>("[data-window-places]");
const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-window-place-row="${id}"]`);
const signIn = () => document.querySelector<HTMLButtonElement>("[data-window-places-sign-in]");
const railArea = () => document.querySelector<HTMLElement>("[data-chrome-rail]");
const openIt = async (besideRail = true) => { await act(async () => opening!(besideRail)); await flush(); };
beforeEach(() => {
  setLocale("en");
  state = { places: SEVERAL, list: SEVERAL, add: { cloud: true, link: true, address: false } };
  opening = null; asked = null;
  vi.clearAllMocks();
  Object.assign(window, { ogb: { workspaces, rail } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

it("shows only once the view covers the window, never in the rail's strip", async () => {
  await mount();
  let answered = () => {};
  rail.expand.mockImplementationOnce(() => new Promise<void>((resolve) => { answered = resolve; }));
  await openIt();
  expect(rail.expand).toHaveBeenCalledWith(true);
  expect(list(), "main hasn't widened the view yet").toBeNull();
  await act(async () => answered());
  await flush();
  expect(list()).toBeTruthy();
});

it("sizes itself against the window, not the viewport units a resize leaves behind", async () => {
  await mount();
  await openIt();
  expect(list()!.className).toContain("max-w-[calc(100%-32px)]");
  expect(list()!.className).not.toContain("100vw");
});

it("a menu, so a focused row shows as its hover fill; the arrows move through the rows that can be chosen, round the ends", async () => {
  state = { places: [], list: [place("home", "My Cloud", { active: true }), place("far", "Far", { opens: false, ownNetwork: true }), place("second", "Second")], add: { cloud: true, link: true, address: false, signIn: true } };
  await mount();
  await openIt();
  expect(list()!.getAttribute("role")).toBe("menu");
  const press = async (key: string) => { await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key }))); };
  expect(document.activeElement).toBe(row("home"));
  await press("ArrowDown");
  expect(document.activeElement, "past the one that can't be chosen").toBe(row("second"));
  await press("ArrowDown");
  expect(document.activeElement).toBe(signIn());
  await press("ArrowDown");
  expect(document.activeElement, "round the end").toBe(row("home"));
  await press("ArrowUp");
  expect(document.activeElement).toBe(signIn());
});

it("the keyboard lands on the place on screen", async () => {
  state = { ...state, list: [place("home", "My Cloud"), place("second", "Second", { active: true })] };
  await mount();
  await openIt();
  expect(document.activeElement).toBe(row("second"));
});

it("nothing until the tag asks; then every place main lists, its kind in plain words, the one on screen marked, and the window covered", async () => {
  await mount();
  expect(list()).toBeNull();
  expect(rail.expand).not.toHaveBeenCalledWith(true);
  await openIt();
  expect([...list()!.querySelectorAll("[data-window-place-row]")].map((element) => element.textContent)).toEqual(["This computer", "MCMy Cloud", "SSecond" + "Cloud", "AAcme" + "Team", "OOffice" + "Server"]);
  expect(row("local")!.getAttribute("aria-current")).toBe("page");
  expect(row("local")!.querySelector("svg.lucide-check")).toBeTruthy();
  expect(row("home")!.getAttribute("aria-current")).toBeNull();
  expect(rail.expand).toHaveBeenCalledWith(true);
  expect(document.activeElement, "the keyboard is in the list").toBe(row("local"));
});

it("a row opens through the rail's own switch, and the list closes and lets go of the rail's page", async () => {
  await mount();
  await openIt();
  await act(async () => row("acme")!.click());
  await flush();
  expect(workspaces.open).toHaveBeenCalledExactlyOnceWith("acme");
  expect(list()).toBeNull();
  expect(rail.expand).toHaveBeenLastCalledWith(false);
  expect(rail.listClosed).toHaveBeenCalledOnce();
});

it("the place on screen only closes the list; a place with nothing to open can't be chosen", async () => {
  state = { ...state, list: [COMPUTER, place("net", "Far", { kind: "server", opens: false, ownNetwork: true, server: true })] };
  await mount();
  await openIt();
  expect(row("net")!.disabled).toBe(true);
  await act(async () => row("local")!.click());
  expect(workspaces.open).not.toHaveBeenCalled();
  expect(list()).toBeNull();
});

it("a server of the person's own not connected yet shows how to connect it, as its tile does", async () => {
  state = { ...state, list: [COMPUTER, place("signed-in:s", "Office", { kind: "server", opens: false, pairs: true, server: true })] };
  await mount();
  await openIt();
  await act(async () => row("signed-in:s")!.click());
  await flush();
  expect(document.querySelector('[data-place-add="connect-server"]')).toBeTruthy();
  expect(workspaces.open).not.toHaveBeenCalled();
});

it("signed out: this computer, and the line that says what signing in brings, which signs in through main", async () => {
  state = { places: [], list: [COMPUTER], add: { cloud: true, link: true, address: false, signIn: true } };
  await mount();
  await openIt(false);
  expect(row("local")!.textContent).toBe("This computer");
  expect(signIn()!.textContent).toBe("Sign in to see your Clouds and teams");
  await act(async () => signIn()!.click());
  await flush();
  expect(workspaces.add).toHaveBeenCalledExactlyOnceWith("signIn");
  expect(list()).toBeNull();
  expect(rail.listClosed).toHaveBeenCalledOnce();
});

it("signed in, no Sign in", async () => {
  await mount();
  await openIt();
  expect(signIn()).toBeNull();
});

it("a press outside closes it, and Escape does; a press on the list doesn't", async () => {
  await mount();
  await openIt();
  await act(async () => list()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(list()).toBeTruthy();
  await act(async () => document.querySelector("[data-window-places-backdrop]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(list()).toBeNull();
  await openIt();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(list()).toBeNull();
  expect(rail.listClosed).toHaveBeenCalledTimes(2);
});

it("with the rail hidden or no rail, its tiles stay away while the list is up; beside a rail that stands they stay", async () => {
  await mount();
  await openIt(false);
  expect(railArea()!.className).toContain("invisible");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(railArea()!.className).not.toContain("invisible");
  await openIt(true);
  expect(railArea()!.className).not.toContain("invisible");
});

it("asked for before the rail's page was up, the list opens as soon as it is", async () => {
  asked = false;
  state = { places: [], list: [COMPUTER], add: { cloud: true, link: true, address: false, signIn: true } };
  await mount();
  expect(list()).toBeTruthy();
  expect(railArea()!.className).toContain("invisible");
  expect(rail.expand).toHaveBeenCalledWith(true);
});

it("on an app with no list in main's answer, or no such bridge, nothing breaks", async () => {
  state = { places: SEVERAL, add: { cloud: false, link: false, address: false } };
  await mount();
  await openIt();
  expect(list(), "nothing to show until main's list comes").toBeNull();
  await act(async () => root!.unmount()); root = null;
  Object.assign(window, { ogb: { workspaces, rail: { expand: vi.fn(async () => {}) } } });
  await mount();
  expect(list()).toBeNull();
});
