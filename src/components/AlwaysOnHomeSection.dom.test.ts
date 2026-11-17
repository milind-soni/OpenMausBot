// @vitest-environment happy-dom
// The section against a fake preload bridge: the switch on the spare computer, and adding one from the main computer.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }), api: async () => ({ sessions: sessions.list }) }));
vi.mock("./PlaceAddSheet", async () => {
  const { createElement: h } = await import("react");
  return {
    RailSheet: ({ children }: { children: unknown }) => h("div", { "data-rail-sheet": "" }, children as never),
    OwnServerLink: () => h("div", { "data-own-server-link": "" }),
  };
});

const { AlwaysOnHomeSection, alwaysOnLines, homeStatusLine, systemSettingLines } = await import("./AlwaysOnHomeSection");

const off = { on: false, since: null };
const companionState = (devices = 0, computers = false): CompanionState => ({
  enabled: true, keepAwake: false, port: 8810, pairing: null,
  devices: Array.from({ length: devices }, (_, index) => ({ id: `p${index}`, name: `Phone ${index}`, createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false })),
  routes: { wifi: { on: true, since: 1 }, relay: off, tailscale: computers ? { on: true, since: 1, name: "mini", computers: true } : off, https: off } as CompanionState["routes"],
});
const home = (over: Partial<AlwaysOnHomeState> = {}): AlwaysOnHomeState =>
  ({ available: true, on: false, platform: "darwin", openAtLogin: false, awake: "off", updates: "by-itself", ...over });

let host: HTMLDivElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const text = () => host.textContent ?? "";

beforeEach(() => {
  setLocale("en");
  sessions.list = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

type Act = (call: (companion: unknown) => Promise<CompanionState>) => Promise<CompanionState>;
function render(state: CompanionState, { act = vi.fn<Act>(async () => state), onAddPhone = vi.fn() } = {}) {
  const c = { busy: false, accountBusy: false, act } as unknown as PhoneSetupController;
  flushSync(() => root.render(createElement(AlwaysOnHomeSection, { c, state, onAddPhone })));
  return { act, onAddPhone };
}

describe("what the switch says it did", () => {
  it("one line for each part, from main's own state", () => {
    expect(alwaysOnLines(home({ on: true, openAtLogin: true, awake: "holding" })).map((line) => [line.key, line.good])).toEqual([
      ["alwaysOn.login.on", true], ["alwaysOn.awake.on", true], ["alwaysOn.updates.byItself", true], ["alwaysOn.windowClosed", true], ["alwaysOn.restarts", true],
    ]);
    expect(alwaysOnLines(home({ on: true, awake: "battery", updates: "package", available: false })).map((line) => line.key)).toEqual([
      "alwaysOn.login.unavailable", "alwaysOn.awake.battery", "alwaysOn.updates.package", "alwaysOn.windowClosed", "alwaysOn.restarts",
    ]);
  });

  it("names the Mac's own settings on a Mac only", () => {
    expect(systemSettingLines("darwin")).toHaveLength(4);
    expect(systemSettingLines("win32")).toEqual([]);
    expect(systemSettingLines("linux")).toEqual([]);
  });

  it("the status line counts what reaches it", () => {
    expect(homeStatusLine(0)).toBe("Home is on · nothing paired yet");
    expect(homeStatusLine(1)).toBe("Home is on · reachable from 1 device");
    expect(homeStatusLine(2)).toBe("Home is on · reachable from 2 devices");
  });
});

describe("on the spare computer", () => {
  it("one switch turns it on; then what it did, the status, the next step and the Mac's own settings", async () => {
    let saved = home();
    const set = vi.fn(async (on: boolean) => (saved = home({ on, openAtLogin: on, awake: on ? "holding" : "off" })));
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: vi.fn(async () => saved), set } };
    sessions.list = [{ id: "laptop" }];
    const { onAddPhone } = render(companionState(1));
    await vi.waitFor(() => expect($("[data-always-on-switch] [role=switch]")).not.toBeNull());
    expect(text()).toContain("Use this Mac as an always-on home");
    expect($("[data-always-on-details]")).toBeNull();
    flushSync(() => $<HTMLButtonElement>("[data-always-on-switch] [role=switch]")!.click());
    await vi.waitFor(() => expect($("[data-always-on-details]")).not.toBeNull());
    expect(set).toHaveBeenCalledWith(true);
    expect(text()).toContain("Opens at login");
    expect(text()).toContain("Stays awake while plugged in");
    expect(text()).toContain("Installs updates by itself when nobody is using it");
    expect(text()).toContain("Starts its server again if it stops");
    await vi.waitFor(() => expect($("[data-always-on-status]")?.textContent).toBe("Home is on · reachable from 2 devices"));
    expect($("[data-always-on-system]")?.textContent).toContain("System Settings → Energy");
    expect($("[data-always-on-system]")?.textContent).toContain("Automatically log in as");
    expect($("[data-always-on-system]")?.textContent).toContain("Accessibility and Screen Recording");
    expect($("[data-always-on-steps]"), "a home doesn't offer adding another").toBeNull();
    flushSync(() => $<HTMLButtonElement>("[data-always-on-add-phone]")!.click());
    expect(onAddPhone).toHaveBeenCalledOnce();
  });

  it("Add your other computer turns on Your other computers in one tap; once on, it points at Pair a computer", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: async () => home({ on: true, openAtLogin: true, awake: "holding" }), set: vi.fn() } };
    const setTailscaleComputers = vi.fn(async () => companionState(0, true));
    const { act } = render(companionState(0), { act: vi.fn<Act>(async (call) => call({ setTailscaleComputers, state: vi.fn() })) });
    await vi.waitFor(() => expect($("[data-always-on-add-computer]")).not.toBeNull());
    flushSync(() => $<HTMLButtonElement>("[data-always-on-add-computer]")!.click());
    await vi.waitFor(() => expect(setTailscaleComputers).toHaveBeenCalledWith(true));
    expect(act).toHaveBeenCalledOnce();
    render(companionState(0, true));
    await vi.waitFor(() => expect($("[data-always-on-add-computer]")).toBeNull());
    expect(text()).toContain("choose Pair a computer under Your other computers");
  });

  it("on Windows the Mac's settings are left out, and a Linux package's updates say where they come from", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "linux", alwaysOnHome: { state: async () => home({ on: true, platform: "linux", openAtLogin: true, awake: "holding", updates: "package" }), set: vi.fn() } };
    render(companionState(0));
    await vi.waitFor(() => expect($("[data-always-on-details]")).not.toBeNull());
    expect(text()).toContain("Use this computer as an always-on home");
    expect(text()).toContain("Updates come through your package manager");
    expect($("[data-always-on-system]")).toBeNull();
  });
});

describe("on the main computer", () => {
  const environments = (servers: Array<{ id: string; name: string; origin?: string; home?: boolean; kind?: "local" | "remote" }>, status: unknown[] = []) => ({
    state: vi.fn(async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: servers })),
    status: vi.fn(async () => status),
    switch: vi.fn(async () => {}),
    onStatus: () => () => {},
  });

  it("walks through adding one: the steps, Connect opens the existing pairing sheet", async () => {
    const env = environments([{ id: "local", name: "This computer", kind: "local" }]);
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome: vi.fn() } };
    render(companionState(0));
    await vi.waitFor(() => expect($("[data-settings-disclosure=add-always-on] button")).not.toBeNull());
    expect(text()).toContain("Add a Mac mini or other always-on computer");
    flushSync(() => $<HTMLButtonElement>("[data-settings-disclosure=add-always-on] button")!.click());
    expect($("[data-always-on-steps]")?.textContent).toContain("Use this Mac as an always-on home");
    expect($("[data-always-on-steps]")?.textContent).toContain("Tailscale");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-connect]")!.click());
    expect($("[data-rail-sheet] [data-own-server-link]")).not.toBeNull();
  });

  it("once added: how it is doing, Open its bots, and Move my bots there after a plain confirm", async () => {
    const env = environments([
      { id: "local", name: "This computer", kind: "local" },
      { id: "cloud", name: "My Cloud", kind: "remote", origin: "https://cloud.example.test", home: true },
      { id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" },
    ], [{ id: "mini", state: "connected", since: 1, version: "0.1.166", behind: false, install: null }]);
    const makeHome = vi.fn(async () => ({ started: true }));
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome, places: vi.fn(async () => ({ places: [], add: {} })) } };
    render(companionState(0));
    await vi.waitFor(() => expect($("[data-always-on-computer=mini]")).not.toBeNull());
    expect($("[data-always-on-computer=cloud]"), "My Cloud is not a computer added by hand").toBeNull();
    await vi.waitFor(() => expect($("[data-always-on-health]")?.textContent).toBe("Online"));
    expect(text()).toContain("Mac mini has its own circle at the left edge of the window");
    expect(text()).toContain("Bots there use its screen, browser and files");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-open]")!.click());
    expect(env.switch).toHaveBeenCalledWith("mini");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move]")!.click());
    expect(makeHome, "nothing moves before the confirm").not.toHaveBeenCalled();
    expect(text()).toContain("Moves this computer's bots, chats, memory and routines to Mac mini");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move-yes]")!.click());
    await vi.waitFor(() => expect(makeHome).toHaveBeenCalledWith("mini"));
  });

  it("says main's own words when it can't move there", async () => {
    const env = environments([{ id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" }]);
    const makeHome = vi.fn(async () => { throw new Error("This server can't be your bots' home."); });
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome, places: vi.fn(async () => ({ places: [], add: {} })) } };
    render(companionState(0));
    await vi.waitFor(() => expect($("[data-always-on-move]")).not.toBeNull());
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move]")!.click());
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move-yes]")!.click());
    await vi.waitFor(() => expect($("[role=alert]")?.textContent).toBe("This server can't be your bots' home."));
  });

  it("nothing at all where neither part can run (an older app, or a browser)", () => {
    (globalThis as { ogb?: unknown }).ogb = {};
    render(companionState(0));
    expect(host.innerHTML).toBe("");
  });
});
