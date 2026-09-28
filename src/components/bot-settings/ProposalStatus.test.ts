// Boundary markers: a Chief-proposable group says its changes arrive as a
// card the owner confirms; an owner-only group says it never arrives as a
// proposal. Both hide when no other Chief covers the bot's section and in
// the draft editor, and sections with nothing proposal-eligible carry none.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, api, type Bot } from "@/state/store";
import { BotEditorContext } from "./BotEditorContext";

const fixture = vi.hoisted(() => ({ bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: vi.fn() }) };
});
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));
vi.mock("@/lib/mcp-servers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/mcp-servers")>(),
  useMcpServers: () => ({ servers: [] as Array<{ name: string; enabled: boolean }>, error: false, refresh: vi.fn() }),
}));

const { ProposalStatus } = await import("./ProposalStatus");
const { AccessSection } = await import("./AccessSection");
const { PermissionsSection } = await import("./PermissionsSection");
const { VisibilitySection } = await import("./VisibilitySection");

const CHIEF_COPY = "Chief-proposable";
const OWNER_COPY = "Owner-only";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "Scout",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function makeDerived(): ReturnType<typeof import("./useBotSettingsDerived").useBotSettingsDerived> {
  return {
    patch: vi.fn(),
    engine: undefined,
    approvalMode: "ask",
    trustedModesAvailable: false,
    canCoordinate: false,
    canUseConnectedApps: true,
    canUseVps: false,
    connectedAppsConfigured: true,
    connectedAppsEnabled: true,
    connectorGrantState: "full",
    canUseBrowser: false,
    desktopBrowser: false,
    browserBlockedOnWindows: false,
    browserFeature: true,
    browserAllowed: true,
    browserEnabled: false,
    browserSelectable: false,
    browserDisabledReason: "The built-in browser needs the OpenMausBot desktop app",
    sectionName: "General",
    currentChief: undefined,
    botRoutines: [],
    activeBotRoutines: 0,
    localSelectable: false,
    localDisabledReason: null,
    activeState: "idle",
    mascotMotion: null,
  } as ReturnType<typeof import("./useBotSettingsDerived").useBotSettingsDerived>;
}

function renderMarker(bot: Bot, kind: "chief" | "owner") {
  return renderToStaticMarkup(
    createElement(StoreProvider, null, createElement(ProposalStatus, { bot, kind })),
  );
}

describe("ProposalStatus", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows both markers when another bot is the section's Chief", () => {
    fixture.bots = [makeBot(), makeBot({ id: "chief-1", name: "Atlas", chiefOfStaff: true })];
    expect(renderMarker(makeBot(), "chief")).toContain(CHIEF_COPY);
    expect(renderMarker(makeBot(), "owner")).toContain(OWNER_COPY);
  });

  it("hides both markers when no Chief covers the section", () => {
    fixture.bots = [makeBot()];
    expect(renderMarker(makeBot(), "chief")).toBe("");
    expect(renderMarker(makeBot(), "owner")).toBe("");
  });

  it("shows markers when a Chief of another section manages this one", () => {
    fixture.bots = [
      makeBot({ section: "General" }),
      makeBot({ id: "chief-1", name: "Atlas", section: "Elsewhere", chiefOfStaff: true, managedSections: ["General"] }),
    ];
    expect(renderMarker(makeBot({ section: "General" }), "chief")).toContain(CHIEF_COPY);
  });

  it("hides markers for a Chief outside the section it does not manage", () => {
    fixture.bots = [
      makeBot({ section: "General" }),
      makeBot({ id: "chief-1", name: "Atlas", section: "Elsewhere", chiefOfStaff: true, managedSections: ["Other"] }),
    ];
    expect(renderMarker(makeBot({ section: "General" }), "chief")).toBe("");
  });

  it("hides markers when the bot itself is the only Chief", () => {
    fixture.bots = [makeBot({ chiefOfStaff: true })];
    expect(renderMarker(makeBot(), "chief")).toBe("");
  });

  it("hides markers in the new-bot draft editor", () => {
    fixture.bots = [makeBot(), makeBot({ id: "chief-1", chiefOfStaff: true })];
    const markup = renderToStaticMarkup(createElement(
      BotEditorContext.Provider,
      { value: { request: api, draft: true } },
      createElement(ProposalStatus, { bot: makeBot(), kind: "chief" }),
    ));
    expect(markup).toBe("");
  });

  it("matches a Chief across section whitespace", () => {
    fixture.bots = [
      makeBot({ section: " General " }),
      makeBot({ id: "chief-1", section: "General", chiefOfStaff: true }),
    ];
    expect(renderMarker(makeBot({ section: " General " }), "chief")).toContain(CHIEF_COPY);
  });
});

describe("Edit Profile boundary markers in sections", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("marks the Access groups: working folder Chief-proposable, works-on owner-only", () => {
    fixture.bots = [makeBot(), makeBot({ id: "chief-1", chiefOfStaff: true })];
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived() })),
    );
    expect(markup).toContain(
      'Where this bot runs its shell and file tools.</div><div class="mt-1 text-[11.5px] leading-snug text-ink-secondary">Chief-proposable',
    );
    expect(markup).toContain(
      'Browser is the built-in browser tab only; no desktop.</div><div class="mt-1 text-[11.5px] leading-snug text-ink-secondary">Owner-only',
    );
    expect(markup).toContain("Inbound triggers wired to this bot.");
  });

  it("shows no Access markers without a covering Chief", () => {
    fixture.bots = [makeBot()];
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived() })),
    );
    expect(markup).not.toContain(CHIEF_COPY);
    expect(markup).not.toContain(OWNER_COPY);
  });

  it("leaves the visibility section without markers even when a Chief covers it", () => {
    fixture.bots = [makeBot(), makeBot({ id: "chief-1", chiefOfStaff: true })];
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(VisibilitySection, { bot: makeBot() })),
    );
    expect(markup).not.toContain(CHIEF_COPY);
    expect(markup).not.toContain(OWNER_COPY);
  });

  it("marks the managed-teams group owner-only inside the Chief card", () => {
    fixture.bots = [makeBot({ chiefOfStaff: true }), makeBot({ id: "chief-1", chiefOfStaff: true })];
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(PermissionsSection, { bot: makeBot({ chiefOfStaff: true }), derived: makeDerived() })),
    );
    expect(markup).toContain(CHIEF_COPY);
    expect(markup).toContain(OWNER_COPY);
  });

  it("shows no Permissions markers without a covering Chief", () => {
    fixture.bots = [makeBot({ chiefOfStaff: true })];
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(PermissionsSection, { bot: makeBot({ chiefOfStaff: true }), derived: makeDerived() })),
    );
    expect(markup).not.toContain(CHIEF_COPY);
    expect(markup).not.toContain(OWNER_COPY);
  });
});
