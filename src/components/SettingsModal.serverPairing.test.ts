import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// These pin the card as always offered; the server decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined, phonePairing: 0 }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config, appSettingsPhonePairing: fixture.phonePairing, instances: [], bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./settings/pages/DevicesPage", () => ({ DevicesPage: () => "DEVICES_PAGE" }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => "SERVER_PAIRING_CARD_MARKER" }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "companion";
  fixture.config = undefined;
  fixture.phonePairing = 0;
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("the old phone section, opened by Connect your phone or a link", () => {
  it("opens Devices on a hosted server reached from a browser (no window.ogb), with no pairing card of its own", () => {
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toContain('data-settings-page-open="devices"');
    expect(html).toContain("DEVICES_PAGE");
    expect(html).not.toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("opens Devices inside the desktop app, on this computer and on the server it owns alike", () => {
    fixture.phonePairing = 3;
    vi.stubGlobal("window", { ogb: { companion: {} } });
    expect(render()).toContain("DEVICES_PAGE");
    vi.stubGlobal("window", { ogb: {} });
    expect(render()).toContain("DEVICES_PAGE");
  });

  it("is not a page for a desktop that drives another computer: it opens This app's place of that connection instead", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const html = render();
    expect(html).not.toContain("DEVICES_PAGE");
    expect(html).not.toContain('data-settings-page="devices"');
  });

  it("on an OMB Cloud home, which is personal, offers no People section to invite anyone", () => {
    vi.stubGlobal("window", {});
    expect(render()).toContain(">People<");
    fixture.config = { cloudHome: true };
    const html = render();
    expect(html).toContain("DEVICES_PAGE");
    expect(html).not.toContain(">People<");
  });

  it("is Devices on this computer and on a server's own page alike, never Phone & devices", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    expect(render()).toContain(">Devices<");
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toContain(">Devices<");
    expect(html).not.toContain("Phone &amp; devices");
    expect(html).not.toContain("This server");
  });
});
