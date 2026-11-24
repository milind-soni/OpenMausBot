// @vitest-environment happy-dom
// Simple mode, the real Settings window in a browser tab: search and links reach Advanced settings without leaving Simple.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";

const fx = vi.hoisted(() => ({
  section: "overview" as AppSettingsSection,
  listeners: new Set<() => void>(),
  dispatch: vi.fn(),
  setAdvancedMode: vi.fn(),
  features: {} as Record<string, boolean>,
}));
const { marker } = vi.hoisted(() => ({ marker: (name: string) => () => `MARKER:${name};` }));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { fx.listeners.add(listener); return () => { fx.listeners.delete(listener); }; };
  return {
    ...actual,
    api: () => new Promise(() => {}),
    useStore: () => {
      const section = useSyncExternalStore(subscribe, () => fx.section);
      return { state: { ...actual.initialState, appSettingsSection: section, config: { composio: { configured: false }, features: fx.features }, instances: [], bots: [] }, dispatch: fx.dispatch };
    },
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: fx.setAdvancedMode }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("../EnginesSettings", () => ({ EnginesSettings: marker("engines") }));
vi.mock("../keys/KeysPage", () => ({ KeysPage: marker("keys") }));
vi.mock("../AutomaticRecoverySettings", () => ({ AutomaticRecoverySettings: marker("backup-model") }));
vi.mock("../DecisionModelSettings", () => ({ DecisionModelSettings: marker("routing") }));
vi.mock("../ImageGenerationSettings", () => ({ ImageGenerationSettings: marker("images") }));
vi.mock("../CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("../WindowPlaceTitle", () => ({ useWindowPlace: () => null, windowPlaceName: () => "This computer" }));

const { SettingsModal } = await import("../SettingsModal");

let host: HTMLDivElement;
let root: Root;

const field = () => document.querySelector<HTMLInputElement>("[data-settings-search]")!;
const hit = (id: string) => document.querySelector<HTMLButtonElement>(`[data-settings-hit="${id}"]`)!;
const body = () => document.querySelector<HTMLElement>("[data-settings-page-body]")!;
const header = () => document.querySelector<HTMLElement>("[data-settings-header]")!;

function search(value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  setLocale("en");
  fx.section = "overview";
  fx.features = {};
  fx.dispatch.mockReset();
  fx.setAdvancedMode.mockReset();
  fx.dispatch.mockImplementation((action: { type: string; section?: AppSettingsSection }) => {
    if (action.type === "toggleAppSettings" && action.section) fx.section = action.section;
    for (const listener of Array.from(fx.listeners)) listener();
  });
  vi.stubGlobal("ogb", undefined);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("an Advanced setting found from Simple", () => {
  it("opens on its page, marked, and Simple mode stays on; clearing the search puts it away", async () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    search("routing");
    expect(hit("routing").textContent).toContain("Advanced");
    flushSync(() => hit("routing").click());
    expect(fx.section).toBe("ai");
    await vi.waitFor(() => expect(body().textContent).toContain("MARKER:routing;"));
    const peek = document.querySelector<HTMLElement>('[data-settings-peek="routing"]')!;
    expect(peek.textContent).toContain("Advanced setting");
    expect(body().textContent).not.toContain("MARKER:backup-model;");
    expect(body().textContent).not.toContain("MARKER:images;");
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();

    search("");
    expect(body().textContent).not.toContain("MARKER:routing;");
    expect(fx.section).toBe("ai");
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();
  });

  it("opens a row on a page only Advanced lists with just its section, marked, and clearing the search goes back to Overview", async () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    search("analytics");
    flushSync(() => hit("analytics").click());
    expect(fx.section).toBe("general");
    await vi.waitFor(() => expect(document.querySelector('[data-settings-peek="privacy"]')?.textContent).toContain("Advanced setting"));
    expect(body().querySelector('[data-settings-block="privacy"]')).not.toBeNull();
    expect(body().querySelector('[data-settings-block="typing"]')).toBeNull();
    expect(body().querySelector('[data-settings-block="notifications"]')).toBeNull();
    expect(header().textContent).not.toContain("Advanced setting");
    expect(document.querySelector('[data-settings-page="general"]')).toBeNull();
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();

    search("");
    expect(fx.section).toBe("overview");
    expect(document.querySelector("[data-settings-peek]")).toBeNull();
  });

  it("opens a page only Advanced lists whole, at its Simple level, with the mark beside its title", async () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    search("general");
    flushSync(() => hit("page:general").click());
    await vi.waitFor(() => expect(body().getAttribute("data-settings-page-body")).toBe("general"));
    expect(header().textContent).toContain("Advanced setting");
    for (const block of ["typing", "notifications", "privacy"]) expect(body().querySelector(`[data-settings-block="${block}"]`)).not.toBeNull();
    expect(document.querySelector("[data-settings-peek]")).toBeNull();
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();
  });

  it("shows only what a link asks for: Decision and extraction, not the rest of AI's Advanced sections", async () => {
    fx.section = "decisionModel";
    flushSync(() => root.render(createElement(SettingsModal)));
    await vi.waitFor(() => expect(body().textContent).toContain("MARKER:routing;"));
    expect(document.querySelector('[data-settings-peek="routing"]')?.textContent).toContain("Advanced setting");
    expect(body().textContent).not.toContain("MARKER:backup-model;");
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();
  });

  it("opens an old link to Activity at the top of Data in the desktop app, where only a browser has Activity", async () => {
    vi.stubGlobal("ogb", { platform: "darwin" });
    fx.section = "activity";
    flushSync(() => root.render(createElement(SettingsModal)));
    await vi.waitFor(() => expect(body().getAttribute("data-settings-page-body")).toBe("data"));
    expect(body().querySelector('[data-settings-block="storage"]')).not.toBeNull();
    expect(body().querySelector('[data-settings-block="activity"]')).toBeNull();
    expect(header().textContent).toContain("Advanced setting");
    expect(fx.setAdvancedMode).not.toHaveBeenCalled();
  });

  it("finds no Repeat computer tasks without AI where the server can't repeat saved steps, so no mark sits over an empty section", async () => {
    flushSync(() => root.render(createElement(SettingsModal)));
    search("repeat");
    expect(hit("saved-steps")).toBeNull();
    flushSync(() => root.unmount());
    fx.features = { savedStepsHere: true };
    root = createRoot(host);
    flushSync(() => root.render(createElement(SettingsModal)));
    search("repeat");
    flushSync(() => hit("saved-steps").click());
    await vi.waitFor(() => expect(document.querySelector('[data-settings-peek="automation"]')?.textContent).toContain("Advanced setting"));
    expect(body().querySelector('[data-settings-block="automation"]')?.textContent).toContain("Repeat computer tasks without AI");
  });
});
