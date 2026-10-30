// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";

const fx = vi.hoisted(() => ({
  section: "engines" as AppSettingsSection,
  advanced: false,
  config: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  dispatch: vi.fn(),
  api: vi.fn(),
}));
const { marker } = vi.hoisted(() => ({ marker: (name: string) => () => `MARKER:${name};` }));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { fx.listeners.add(listener); return () => { fx.listeners.delete(listener); }; };
  let snapshot = { section: fx.section, config: fx.config };
  const read = () => snapshot.section === fx.section && snapshot.config === fx.config ? snapshot : (snapshot = { section: fx.section, config: fx.config });
  return {
    ...actual,
    api: (...args: unknown[]) => fx.api(...args),
    useStore: () => {
      const { section, config } = useSyncExternalStore(subscribe, read);
      return { state: { ...actual.initialState, appSettingsSection: section, config, instances: [], bots: [] }, dispatch: fx.dispatch };
    },
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fx.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: marker("engines") }));
vi.mock("./DecisionModelSettings", () => ({ DecisionModelSettings: marker("decisionModel") }));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: marker("companion") }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: marker("desktopWorkspaces") }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: marker("computer") }));
vi.mock("./CloudAccountSettings", () => ({ CloudAccountSettings: marker("cloudAccount") }));
vi.mock("./OrganizationSettings", () => ({ OrganizationSettings: marker("organization") }));
vi.mock("./PeopleSection", () => ({ PeopleSection: marker("people") }));
vi.mock("./ActivitySection", () => ({ ActivitySection: marker("activity") }));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./ImportSettings", () => ({ ImportSettings: marker("import") }));
vi.mock("./LoginsSettings", () => ({ LoginsSettings: marker("logins") }));
vi.mock("./BrowserSettingsRows", () => ({ BuiltInBrowserRow: marker("browser") }));

const { SettingsModal } = await import("./SettingsModal");

let host: HTMLDivElement;
let root: Root;

function publish() {
  for (const listener of Array.from(fx.listeners)) listener();
}

const search = () => host.querySelector<HTMLInputElement>("[data-settings-search]")!;
const result = (id: string) => host.querySelector<HTMLButtonElement>(`[data-settings-key-result="${id}"]`);
const row = (id: string) => host.querySelector<HTMLElement>(`[data-key-row="${id}"]`)!;

function type(value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  setLocale("en");
  fx.section = "engines";
  fx.config = { composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" } };
  fx.dispatch.mockReset();
  fx.dispatch.mockImplementation((action: { type: string; section?: AppSettingsSection; config?: Record<string, unknown> }) => {
    if (action.type === "toggleAppSettings" && action.section) fx.section = action.section;
    if (action.type === "configStatus") fx.config = action.config!;
    publish();
  });
  vi.stubGlobal("ogb", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("searching Settings for a key", () => {
  it.each([false, true])("lists it by name and section and lands on its row, focused (Advanced: %s)", async (advanced) => {
    fx.advanced = advanced;
    flushSync(() => root.render(createElement(SettingsModal)));
    type("fish");
    const found = result("fishAudio")!;
    expect(found.textContent).toBe("Fish Audio API key · Voice and calls");
    flushSync(() => found.click());
    expect(search().value).toBe("");
    expect(fx.section).toBe("connections");
    const input = () => row("fishAudio").querySelector<HTMLInputElement>("[data-key-input]");
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    expect(row("fishAudio").hasAttribute("data-key-highlight")).toBe(true);
    expect(row("fishAudio").closest("[hidden]")).toBeNull();
  });

  it("names the OpenAI key twice: once for models, once for live calls", () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    type("openai");
    expect(result("openai")!.textContent).toBe("OpenAI API key · AI providers");
    expect(result("liveCalls")!.textContent).toBe("OpenAI key · Voice and calls");
  });

  it("says plainly when nothing matches", () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    type("zzzz");
    expect(host.textContent).toContain("Nothing matches “zzzz”");
    expect(host.querySelector("[data-settings-key-result]")).toBeNull();
  });
});
