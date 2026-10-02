import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// #950: a packaged desktop build never surfaced a way to mint a session
// pairing code, so MCP clients (and a second desktop app) had no path to
// one. ServerPairingCard was gated on `!window.ogb`, hiding it from every
// desktop instance instead of only the ones that don't own the server
// being paired against. MOCA-84 then found the remote-client case needs it
// too. These tests pin the card as always offered; the server decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined }));
// Pinned to Advanced: these cover the Advanced rail; Simple has its own suite.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: ({ cloudHome }: { cloudHome?: boolean }) => `SERVER_PAIRING_CARD_MARKER${cloudHome ? " cloud" : ""}` }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "companion";
  fixture.config = undefined;
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
    // MOCA-84: a NAS-hosted server reached from the Mac app had no pairing
    // options at all — the companion section is hidden remotely too. The
    // desktop's requests carry the hosted server's session, so the server,
    // not this gate, decides whether that session may mint codes.
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
