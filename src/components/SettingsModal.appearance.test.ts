import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  showThreads: true,
  setShowThreads: vi.fn(),
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({
  useShowThreads: () => fixture.showThreads,
  setShowThreads: fixture.setShowThreads,
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "appearance";
  fixture.showThreads = true;
  fixture.switches = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Appearance", () => {
  it("groups skins, thread visibility, and tool-call display with preservation copy", () => {
    const html = render();
    expect(html).toContain('<option value="appearance" selected="">Appearance</option>');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).toContain('aria-label="Show tool calls in chat"');
    expect(html).toContain("on this device only");
    expect(html).toContain("all conversation history and running work");
    expect(html).toContain("channels are unchanged");
    expect(html).toContain("Turn this back on");
    expect(html).not.toContain("Maximum turn length");
  });

  it.each([true, false])("only updates the local preference when the switch is %s", (enabled) => {
    fixture.showThreads = enabled;
    render();
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Show threads")!;
    expect(toggle.checked).toBe(enabled);
    toggle.onClick!({} as never);
    expect(fixture.setShowThreads).toHaveBeenCalledWith(!enabled);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("leaves non-appearance General settings in place", () => {
    fixture.section = "general";
    const html = render();
    expect(html).toContain("Profile");
    expect(html).toContain("Maximum turn length");
    expect(html).toContain("Maximum running threads per bot");
    expect(html).toContain('aria-label="App language"');
    expect(html).toContain("Diagnostics");
    expect(html).not.toContain('aria-label="Show threads"');
    expect(html).not.toContain('aria-label="Show tool calls in chat"');
    expect(html).not.toContain("Midnight");
  });

  it("makes local appearance available remotely without exposing server settings", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain('<option value="appearance" selected="">Appearance</option>');
    expect(html).toContain('<option value="companion">Remote access</option>');
    expect(html).not.toContain('<option value="general">');
    expect(html).not.toContain('<option value="connections">');
    expect(html).not.toContain('<option value="engines">');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).not.toContain('aria-label="Show tool calls in chat"');
  });

  it("uses English fallback for new keys in untranslated languages", () => {
    setLocale("ja");
    const html = render();
    expect(html).toContain("Appearance");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).toContain("all conversation history and running work");
    expect(html).not.toContain("settings.threadDisplay");
  });
});
