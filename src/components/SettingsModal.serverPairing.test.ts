import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// These pin the card as always offered; the server decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined, phonePairing: 0 }));
// Pinned to Advanced: these cover the Advanced rail; Simple has its own suite.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config, appSettingsPhonePairing: fixture.phonePairing }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => "OTHER_APP_CLIENT_CARD", RemoteAccessScope: () => "REMOTE_ACCESS_SCOPE" }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: () => "SAVED_SERVERS" }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: ({ focusRequest }: { focusRequest?: number }) => `COMPANION_SECTION focus=${focusRequest ?? 0}` }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: ({ cloudHome, focusRequest }: { cloudHome?: boolean; focusRequest?: number }) => `SERVER_PAIRING_CARD_MARKER${cloudHome ? " cloud" : ""} focus=${focusRequest ?? 0}` }));

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

describe("Settings → Remote access: server pairing card visibility", () => {
  it("is offered on a hosted server reached from a browser (no window.ogb)", () => {
    vi.stubGlobal("window", {});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("is offered inside the desktop app when it owns the server being paired against", () => {
    vi.stubGlobal("window", { ogb: {} });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("is offered when this desktop is a remote client of a hosted workspace, whose phones pair only here", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("on an OMB Cloud home, which is personal, tells the card so and offers no People section to invite anyone", () => {
    vi.stubGlobal("window", {});
    expect(render()).toContain(">People<");
    fixture.config = { cloudHome: true };
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER cloud");
    expect(html).not.toContain(">People<");
  });
});

describe("Settings → Remote access opened by Connect your phone", () => {
  it("on this computer, reveals the phone flow, not the server's pairing code", () => {
    fixture.phonePairing = 3;
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=3");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });

  it("on the person's own Cloud in this window, reveals the Cloud's own pairing code", () => {
    fixture.phonePairing = 2;
    fixture.config = { cloudHome: true };
    vi.stubGlobal("window", { ogb: { cloudPlan: {} } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER cloud focus=2");
    expect(html).toContain("COMPANION_SECTION focus=0");
  });

  it("on another server, in a browser or as a remote client, reveals that server's pairing code", () => {
    fixture.phonePairing = 1;
    vi.stubGlobal("window", {});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    vi.stubGlobal("window", { ogb: { companion: {}, remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    expect(html).not.toContain("COMPANION_SECTION");
  });

  it("a plain visit reveals nothing", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=0");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });
});

describe("Settings keeps this computer as a server apart from connecting to one", () => {
  const desktop = { ogb: { companion: {}, environments: {}, remoteClient: { active: false } } };

  it("Remote access holds who can reach this computer, never the cards that make it a client", () => {
    vi.stubGlobal("window", desktop);
    const html = render();
    expect(html).toContain("REMOTE_ACCESS_SCOPE");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER");
    expect(html).toContain("COMPANION_SECTION");
    expect(html).not.toContain("OTHER_APP_CLIENT_CARD");
    expect(html).not.toContain("SAVED_SERVERS");
  });

  it("Servers holds the saved servers and the other desktop app, never this computer's remote access", () => {
    vi.stubGlobal("window", desktop);
    fixture.section = "desktopWorkspaces";
    const html = render();
    expect(html).toContain("SAVED_SERVERS");
    expect(html).toContain("OTHER_APP_CLIENT_CARD");
    expect(html.indexOf("SAVED_SERVERS")).toBeLessThan(html.indexOf("OTHER_APP_CLIENT_CARD"));
    expect(html).not.toContain("COMPANION_SECTION");
    expect(html).not.toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("a link to connect this app elsewhere opens Servers", () => {
    vi.stubGlobal("window", desktop);
    fixture.section = "remote";
    expect(render()).toContain("SAVED_SERVERS");
  });
});
