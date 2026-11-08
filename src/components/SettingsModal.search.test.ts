// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), scrolled: [] as Element[], section: "general" }));
vi.mock("@/lib/scroll-within", () => ({ scrollWithin: (_scroller: unknown, target: Element) => { fixture.scrolled.push(target); }, scrollParent: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { appSettingsSection: fixture.section, instances: [], bots: [], config: { features: {}, composio: { mode: "self" }, rooms: { turnTimeoutMinutes: 5 } }, appSettingsCloudLink: 0, appSettingsPhonePairing: 0 },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: {} } }) }));
vi.mock("./SidebarProfileMenu", async (importOriginal) => ({ ...await importOriginal<typeof import("./SidebarProfileMenu")>(), useServerUpdateItem: () => null }));
for (const [path, name] of [
  ["./EnginesSettings", "EnginesSettings"], ["./RemoteComputerSection", "RemoteComputerSection"], ["./PhoneDevicesSection", "PhoneDevicesSection"],
  ["./ServerPairingCard", "ServerPairingCard"], ["./LocalComputerSection", "LocalComputerSection"], ["./CloudAccountSettings", "CloudAccountSettings"],
  ["./PeopleSection", "PeopleSection"], ["./ActivitySection", "ActivitySection"], ["./UsageSection", "UsageSection"], ["./ImportSettings", "ImportSettings"],
  ["./CustomDomainSettings", "CustomDomainSettings"], ["./LoginsSettings", "LoginsSettings"], ["./PlanUsage", "PlanUsageSummary"],
] as const) vi.doMock(path, async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), [name]: () => null }));

const { SettingsModal } = await import("./SettingsModal");
let host: HTMLDivElement;
let root: Root;
const scrolled = fixture.scrolled;

beforeAll(() => {
  HTMLElement.prototype.checkVisibility ??= () => true;
});

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.section = "general";
  setLocale("en");
  scrolled.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(SettingsModal)));
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
const search = () => host.querySelector<HTMLInputElement>("[data-settings-search]")!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
  flushSync(() => search().dispatchEvent(new Event("input", { bubbles: true })));
};

describe("Settings search in Simple mode", () => {
  it("opens on the dialog itself, and a typed letter moves into search", () => {
    expect(document.activeElement).toBe(dialog());
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(search());
    expect(search().value).toBe("f");
  });

  it("points nowhere Advanced, Simple being the only mode, and finds Automatic recovery under More settings", () => {
    for (const words of ["font", "chat width", "circles", "universal", "this run"]) {
      type(words);
      expect(host.querySelector("[data-settings-advanced-only]"), words).toBeNull();
      expect(dialog().textContent, words).not.toContain("· Advanced");
    }
    type("recovery");
    const result = host.querySelector<HTMLButtonElement>('[data-settings-more-result="settings.recovery.title"]')!;
    expect(result.textContent).toBe("Automatic recovery · More settings");
    flushSync(() => result.click());
    expect(host.querySelector("h2")!.textContent).toBe("More settings");
    expect(host.querySelector('[data-settings-block="limits"]')!.textContent).toContain("Automatic recovery");
    expect(scrolled.map((element) => element.getAttribute("data-settings-block"))).toContain("limits");
    expect(search().value).toBe("");
  });

  it("opens More settings from the bottom of General: the hidden pages, then Limits, and Back returns to its row", () => {
    const heading = () => host.querySelector("h2")!.textContent;
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-settings-more]")!.click());
    expect(heading()).toBe("More settings");
    expect([...host.querySelectorAll("[data-settings-more-section]")].map((row) => row.getAttribute("data-settings-more-section")))
      .toEqual(["decisionModel", "imageGeneration", "backups", "experimental"]);
    const limits = host.querySelector('[data-settings-block="limits"]')!;
    expect(limits.querySelector("h3")!.textContent).toBe("Limits");
    for (const title of ["Group turns", "Tool time limit", "Parallel threads", "Automatic recovery", "Event log cleanup"]) expect(limits.textContent, title).toContain(title);
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-settings-more-section="backups"]')!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
    expect(heading()).toBe("General");
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-settings-more]")!.click());
    flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Back")!.click());
    expect(heading()).toBe("General");
    expect(scrolled.map((element) => element.getAttribute("data-settings-block"))).toContain("more");
  });

  it("leaves More settings when a link opens another setting, even one back on General", () => {
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-settings-more]")!.click());
    expect(host.querySelector('[data-settings-block="limits"]')).not.toBeNull();
    const follow = (section: string) => {
      fixture.section = section;
      flushSync(() => root.render(createElement(SettingsModal)));
    };
    follow("appearance");
    expect(host.querySelector("h2")!.textContent).toBe("General");
    expect(host.querySelector('[data-settings-block="limits"]')).toBeNull();
    follow("general");
    expect(host.querySelector('[data-settings-block="limits"]')).toBeNull();
    expect(host.querySelector("[data-settings-more]")).not.toBeNull();
  });

  it("finds a hidden page and a limit as More settings, and opens each where it lives", () => {
    type("backups");
    const page = host.querySelector<HTMLButtonElement>('[data-settings-more-result="backups"]')!;
    expect(page.textContent).toBe("Backups · More settings");
    flushSync(() => page.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
    expect(search().value).toBe("");

    type("parallel");
    const limit = host.querySelector<HTMLButtonElement>('[data-settings-more-result="settings.threads.title"]')!;
    expect(limit.textContent).toBe("Parallel threads · More settings");
    expect(host.querySelector('[data-settings-advanced-only="settings.threads.title"]')).toBeNull();
    flushSync(() => limit.click());
    expect(host.querySelector("h2")!.textContent).toBe("More settings");
    expect(scrolled.map((element) => element.getAttribute("data-settings-block"))).toContain("limits");
  });
});
