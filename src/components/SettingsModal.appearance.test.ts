import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SendKey } from "@/lib/send-key";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SECTIONS, sectionMatches, SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  showThreads: true,
  setShowThreads: vi.fn(),
  showRunCard: true,
  setShowRunCard: vi.fn(),
  sidebarDensity: "comfortable" as "comfortable" | "compact" | "icons",
  setSidebarDensity: vi.fn(),
  notificationSounds: true,
  setNotificationSounds: vi.fn(),
  sendKey: "enter" as SendKey,
  setSendKey: vi.fn(),
  advancedMode: false,
  setAdvancedMode: vi.fn(),
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
}));
// The Cloud account card reads the host platform (what a saved sign-in still locked asks for).
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } } }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({
  useShowThreads: () => fixture.showThreads,
  useShowThreadsChoice: () => fixture.showThreads,
  setShowThreads: fixture.setShowThreads,
}));
vi.mock("@/lib/run-card-preferences", () => ({
  useShowRunCard: () => fixture.showRunCard,
  setShowRunCard: fixture.setShowRunCard,
}));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.sidebarDensity,
  setSidebarDensity: fixture.setSidebarDensity,
}));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => fixture.notificationSounds,
  setNotificationSounds: fixture.setNotificationSounds,
}));
vi.mock("@/lib/send-key", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/send-key")>(),
  useSendKey: () => fixture.sendKey,
  setSendKey: fixture.setSendKey,
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: fixture.setAdvancedMode,
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
  fixture.showRunCard = true;
  fixture.sidebarDensity = "comfortable";
  fixture.notificationSounds = true;
  fixture.sendKey = "enter";
  // these pin the Advanced rail; Simple has its own suite (SettingsModal.simple.test.ts)
  fixture.advancedMode = true;
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
  it.each([true, false])("flips Advanced mode from the top of General when the switch is %s", (enabled) => {
    fixture.section = "general";
    fixture.advancedMode = enabled;
    const html = render();
    expect(html.indexOf('aria-label="Advanced mode"')).toBeLessThan(html.indexOf("Language"));
    expect(html).toContain('aria-label="Advanced mode"');
    expect(html).toContain("Nothing is deleted either way");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Advanced mode")!;
    expect(toggle.checked).toBe(enabled);
    toggle.onClick!({} as never);
    expect(fixture.setAdvancedMode).toHaveBeenCalledWith(!enabled);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the Advanced mode switch reachable from a paired remote client", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    expect(render()).toContain('aria-label="Advanced mode"');
  });

  it("does not repeat the Advanced mode switch in Appearance on this computer", () => {
    expect(render()).not.toContain('aria-label="Advanced mode"');
  });


  it("groups skins, thread visibility, and tool-call display with preservation copy", () => {
    const html = render();
    expect(html).toContain('<option value="appearance" selected="">Appearance</option>');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).toContain('aria-label="Pinned bots as circles"');
    expect(html).toContain('aria-label="Universal pins"');
    expect(html).toContain("from every group");
    expect(html).toContain("like Grok Bot");
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

  it.each([true, false])("mutes notification sounds on this computer only when the switch is %s", (enabled) => {
    fixture.notificationSounds = enabled;
    const html = render();
    expect(html).toContain('aria-label="Notification sounds"');
    expect(html).toContain("keep the banners but lose the chime");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Notification sounds")!;
    expect(toggle.checked).toBe(enabled);
    toggle.onClick!({} as never);
    expect(fixture.setNotificationSounds).toHaveBeenCalledWith(!enabled);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["comfortable", "Comfortable"],
    ["compact", "Compact"],
    ["icons", "Avatars only"],
  ] as const)("shows the saved sidebar density (%s) in Appearance", (density, label) => {
    fixture.sidebarDensity = density;
    const html = render();
    expect(html).toContain('aria-label="Choose sidebar density"');
    expect(html).toContain("Sidebar density");
    expect(html).toContain("collapsing the sidebar from its header");
    expect(html).toContain(`<option value="${density}" selected="">${label}</option>`);
    for (const option of ["Comfortable", "Compact", "Avatars only"]) expect(html).toContain(`>${option}</option>`);
    expect(fixture.setSidebarDensity).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["enter", "Enter"],
    ["shift-enter", "Shift+Enter"],
    ["mod-enter", "Ctrl+Enter"],
  ] as const)("shows the saved send key (%s) on this device only", (sendKey, label) => {
    fixture.sendKey = sendKey;
    const html = render();
    expect(html).toContain("Send messages with");
    expect(html).toContain('aria-label="Send messages with"');
    expect(html).toContain("Choose Shift+Enter or Ctrl+Enter so Enter starts a new line");
    expect(html).toContain("as Japanese input does. Ctrl+Enter sends whichever you choose.");
    expect(html).toContain(`<option value="${sendKey}" selected="">${label}</option>`);
    const options = [...html.matchAll(/<option value="(enter|shift-enter|mod-enter)"[^>]*>([^<]*)</g)].map((match) => [match[1], match[2]]);
    // only the key, so the closed menu fits its 240px column in every language
    expect(options).toEqual([["enter", "Enter"], ["shift-enter", "Shift+Enter"], ["mod-enter", "Ctrl+Enter"]]);
    expect(fixture.setSendKey).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("asks Japanese speakers in Japanese, with the key named for this computer", () => {
    setLocale("ja");
    fixture.sendKey = "shift-enter";
    const html = render();
    expect(html).toContain("メッセージの送信キー");
    expect(html).toContain("日本語入力のように Enter で変換を確定する場合は、Shift+Enter か Ctrl+Enter を選ぶと Enter で改行できます。");
    expect(html).toContain('<option value="enter">Enter</option>');
    expect(html).toContain('<option value="shift-enter" selected="">Shift+Enter</option>');
    expect(html).toContain('<option value="mod-enter">Ctrl+Enter</option>');
  });

  it("finds the send key by the keys' names on every platform", () => {
    const appearance = SECTIONS.find((section) => section.id === "appearance")!;
    for (const query of ["enter", "return", "shift+enter", "ctrl+enter", "cmd", "cmd+enter", "⌘", "⌘+enter", "command", "send", "new line", "ime"]) {
      expect(sectionMatches(appearance, query), query).toBe(true);
    }
  });

  it("offers the run card visibility toggle in Appearance", () => {
    fixture.showRunCard = true;
    const html = render();
    expect(html).toContain('aria-label="Show the run card"');
    expect(html).toContain("This run");
    expect(html).toContain("saving the run as a skill");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Show the run card")!;
    expect(toggle.checked).toBe(true);
    toggle.onClick!({} as never);
    expect(fixture.setShowRunCard).toHaveBeenCalledWith(false);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();

    fixture.showRunCard = false;
    render();
    const off = fixture.switches.filter((props) => props["aria-label"] === "Show the run card").at(-1)!;
    expect(off.checked).toBe(false);
    off.onClick!({} as never);
    expect(fixture.setShowRunCard).toHaveBeenLastCalledWith(true);
  });

  it("leaves non-appearance General settings in place", () => {
    fixture.section = "general";
    const html = render();
    expect(html).toContain("Profile");
    expect(html).toContain("Maximum turn length");
    expect(html).toContain("Maximum running threads per bot");
    expect(html).toContain("Automatic recovery");
    expect(html).toContain('aria-label="App language"');
    expect(html).toContain("Diagnostics");
    expect(html).not.toContain('aria-label="Show threads"');
    expect(html).not.toContain('aria-label="Choose sidebar density"');
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
    expect(html).not.toContain('<option value="backups">');
    expect(html).toContain("Midnight");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).toContain('aria-label="Notification sounds"');
    expect(html).toContain('aria-label="Choose sidebar density"');
    expect(html).not.toContain('aria-label="Show tool calls in chat"');
  });

  it("offers full backups in local Settings", () => {
    fixture.section = "backups";
    const html = render();
    expect(html).toContain('<option value="backups" selected="">Backups</option>');
    expect(html).toContain("Export full backup");
    expect(html).toContain('type="file" accept=".ombbackup"');
    expect(html).toContain("Older team backups and shareable templates");
  });

  it("uses English fallback for new keys in untranslated languages", () => {
    setLocale("ja");
    const html = render();
    expect(html).toContain("Appearance");
    expect(html).toContain('aria-label="Show threads"');
    expect(html).toContain('aria-label="Pinned bots as circles"');
    expect(html).toContain('aria-label="Universal pins"');
    expect(html).toContain("from every group");
    expect(html).toContain("like Grok Bot");
    expect(html).toContain("all conversation history and running work");
    expect(html).not.toContain("settings.threadDisplay");
  });

  it("offers desktop connections as a top-level page without exposing the list remotely", () => {
    fixture.section = "desktopWorkspaces";
    vi.stubGlobal("window", { ogb: { environments: {} } });
    const local = render();
    expect(local).toContain('<option value="desktopWorkspaces" selected="">Servers</option>');
    expect(local).toContain("Server address or pairing link");
    expect(local).toContain("Name (optional)");
    expect(local).toContain("Your servers");
    expect(local).toContain("npx openmausbot pair --label");
    fixture.section = "general";
    vi.stubGlobal("window", { ogb: { workspaces: {} } });
    expect(render()).not.toContain('<option value="desktopWorkspaces"');
  });

  it("offers optional Organisation settings only through the local desktop bridge", () => {
    fixture.section = "organization";
    vi.stubGlobal("window", { ogb: { organization: {} } });
    const local = render();
    expect(local).toContain('<option value="organization" selected="">Organization</option>');
    expect(local).toContain("personal and local models");
    fixture.section = "appearance";
    vi.stubGlobal("window", {});
    expect(render()).not.toContain('<option value="organization"');
    vi.stubGlobal("window", { ogb: { organization: {}, remoteClient: { active: true } } });
    expect(render()).not.toContain('<option value="organization"');
    expect(render()).toContain("Midnight");
  });
  it("offers personal Cloud separately and only through the local desktop bridge", () => {
    fixture.section = "cloudAccount";
    vi.stubGlobal("window", { ogb: { cloudAccount: {} } });
    expect(render()).toContain('<option value="cloudAccount" selected="">MausBot Cloud</option>');
    expect(render()).toContain("Free local use");
    fixture.section = "appearance";
    vi.stubGlobal("window", {}); expect(render()).not.toContain('<option value="cloudAccount"');
    vi.stubGlobal("window", { ogb: { cloudAccount: {}, remoteClient: { active: true } } });
    expect(render()).not.toContain('<option value="cloudAccount"');
  });
});
