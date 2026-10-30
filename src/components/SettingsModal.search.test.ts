// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), scrolled: [] as Element[] }));
vi.mock("@/lib/scroll-within", () => ({ scrollWithin: (_scroller: unknown, target: Element) => { fixture.scrolled.push(target); }, scrollParent: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { appSettingsSection: "general", instances: [], bots: [], config: { features: {}, composio: { mode: "self" } }, appSettingsCloudLink: 0, appSettingsPhonePairing: 0 },
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
  ["./EnginesSettings", "EnginesSettings"], ["./RemoteComputerSection", "RemoteComputerSection"], ["./CompanionSection", "CompanionSection"],
  ["./ServerPairingCard", "ServerPairingCard"], ["./LocalComputerSection", "LocalComputerSection"], ["./CloudAccountSettings", "CloudAccountSettings"],
  ["./PeopleSection", "PeopleSection"], ["./ActivitySection", "ActivitySection"], ["./UsageSection", "UsageSection"], ["./ImportSettings", "ImportSettings"],
  ["./CustomDomainSettings", "CustomDomainSettings"], ["./LoginsSettings", "LoginsSettings"], ["./PlanUsage", "PlanUsageSummary"],
] as const) vi.doMock(path, async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), [name]: () => null }));

let host: HTMLDivElement;
let root: Root;
const scrolled = fixture.scrolled;

beforeAll(() => {
  HTMLElement.prototype.checkVisibility ??= () => true;
});

beforeEach(async () => {
  vi.clearAllMocks();
  setLocale("en");
  scrolled.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const { SettingsModal } = await import("./SettingsModal");
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

  it("lists a builder control as Advanced and, when chosen, opens General at the Advanced mode row", () => {
    type("font");
    const result = host.querySelector<HTMLButtonElement>('[data-settings-advanced-only="settings.font.title"]')!;
    expect(result.textContent).toBe("Interface font · Advanced");
    flushSync(() => result.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "general" });
    expect(scrolled.map((element) => element.getAttribute("data-settings-block"))).toContain("advanced-mode");
    expect(search().value).toBe("");
  });
});
