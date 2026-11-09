// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), scrolled: [] as Element[], section: "overview" }));
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
  ["./CustomDomainSettings", "CustomDomainSettings"], ["./VaultSettings", "VaultSettings"], ["./PlanUsage", "PlanUsageSummary"],
] as const) vi.doMock(path, async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), [name]: () => null }));

const { SettingsModal } = await import("./SettingsModal");
const { setAdvancedMode } = await import("@/lib/interface-mode");
let host: HTMLDivElement;
let root: Root;
const scrolled = fixture.scrolled;

beforeAll(() => {
  HTMLElement.prototype.checkVisibility ??= () => true;
});

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.section = "overview";
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

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const search = () => document.querySelector<HTMLInputElement>("[data-settings-search]")!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
  flushSync(() => search().dispatchEvent(new Event("input", { bubbles: true })));
};

describe("Settings search in Simple mode", () => {
  it("opens with the search field focused, and / or ⌘F come back to it from anywhere in Settings", () => {
    expect(document.activeElement).toBe(search());
    flushSync(() => dialog().focus());
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(search());
  });

  it("lists rows with where they live, the place's or the app's own name first", () => {
    type("notifications");
    const first = document.querySelector<HTMLButtonElement>("[data-settings-hit]")!;
    expect(first.getAttribute("data-settings-hit")).toBe("notifications");
    // Simple keeps notifications on This app (This browser in a tab), not on General.
    expect(first.textContent, "a browser tab is This browser").toContain("This browser");
    expect(first.textContent).not.toContain("General");
    type("phone");
    expect(document.querySelector("[data-settings-hit]")!.textContent).toContain("Phone & devices");
  });

  it("tags an Advanced row from Simple; choosing it turns Advanced mode on and lands on the row", () => {
    type("parallel threads");
    const hit = document.querySelector<HTMLButtonElement>('[data-settings-hit="parallel"]')!;
    expect(hit.textContent).toContain("Advanced");
    flushSync(() => hit.click());
    expect(vi.mocked(setAdvancedMode)).toHaveBeenCalledWith(true);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "bots" });
  });

  it("says plainly when nothing matches, with the Help Center beside it", () => {
    type("zzqx");
    expect(document.querySelector("[data-settings-no-match]")!.textContent).toContain("Nothing matches “zzqx”");
    expect(document.querySelector("[data-settings-hit]")).toBeNull();
  });

  it("finds the server pairing card from the phrase \"server pairing\"", () => {
    type("server pairing");
    expect(host.querySelector('[data-settings-page="phone"]')).not.toBeNull();
  });

  it("puts the nav back when the search is cleared", () => {
    type("vault");
    expect(document.querySelector("[data-settings-results]")).not.toBeNull();
    type("");
    expect(document.querySelector('[data-settings-page="vault"]')).not.toBeNull();
  });
});
