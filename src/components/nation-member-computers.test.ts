// A server-confirmed member never sees desk setup: no Local VM section in
// Settings, no Box / SSH / "not configured" copy, and a Computer panel that
// explains instead of listing choices that are all "Unavailable here".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const noop = () => {};
  const browserWindow = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { pathname: "/swarm/", search: "", hash: "" },
  });
  vi.stubGlobal("window", browserWindow());
  vi.stubGlobal("location", browserWindow().location);
  return {
    browserWindow,
    state: {
      // exactly what configForAccess() sends a client session: no box, no localVm
      config: {
        isProductOwner: false as boolean,
        adminGate: { pinRequired: false },
        profile: { name: "", email: "" },
        language: "",
        onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: [] },
        rooms: { turnTimeoutMinutes: 5 },
        threads: { maxConcurrentPerBot: 2 },
        vps: { configured: true },
        composio: { configured: false },
        tts: { configured: false },
        features: { browser: false, showToolCalls: false, skillAuthoring: false, sharedComputers: false },
        browserProfiles: [],
      } as Record<string, unknown>,
      appSettingsSection: "computer",
      instances: [],
      bots: [],
      groups: [],
    },
  };
});
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.state, dispatch: vi.fn(), refreshInstances: vi.fn() }),
  api: vi.fn(),
  apiUrl: (path: string) => path,
}));

import { ComputerPanel } from "./ComputerPanel";
import { SettingsModal } from "./SettingsModal";
import { isAdminOnlySettingsSection, isProductAdmin } from "@/lib/admin-gate";

const DESK_SETUP = /\bBox\b|SSH|Local VM|Unavailable here|not configured|VPS inventory|ascii\.dev|Docker/i;
const bot = { id: "bot_1", name: "Scout", threadId: "thread_1", modelSelection: { instanceId: "nation", model: "NATION API" } } as never;

beforeEach(() => {
  vi.stubGlobal("window", fixture.browserWindow());
  vi.stubGlobal("sessionStorage", { getItem: () => "1", setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

describe("member session", () => {
  it("treats Local VM as an owner/admin-only Settings section, even with a forged local unlock", () => {
    expect(isAdminOnlySettingsSection("computer")).toBe(true);
    expect(isProductAdmin({ isProductOwner: false, unlocked: true })).toBe(false);
  });

  it("does not render the Local VM section or its label, even when it was the requested section", () => {
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).not.toMatch(DESK_SETUP);
    expect(html).not.toMatch(/VPS computers/);
  });

  it("shows a NATION explanation in the Computer panel instead of desk setup", () => {
    const html = renderToStaticMarkup(createElement(ComputerPanel, { bot }));
    expect(html).toContain('data-testid="member-computer"');
    expect(html).toContain("Your workspace owner runs the NATION desks");
    expect(html).toContain("Scout");
    expect(html).not.toMatch(DESK_SETUP);
    expect(html).not.toMatch(/OpenMaus|Claude|Anthropic|Hermes|Venice|Grok/i);
  });

  it("still shows the owner the Local VM section with its VPS desk inventory", () => {
    const member = fixture.state.config;
    fixture.state.config = { ...member, isProductOwner: true, box: { configured: false }, localVm: { mode: "shared", maxInstances: 1 } };
    try {
      const html = renderToStaticMarkup(createElement(SettingsModal));
      expect(html).toContain("Local VM");
      expect(html).toContain("Self-hosted VPS computers");
    } finally {
      fixture.state.config = member;
    }
  });
});

describe("a member's own workspace", () => {
  const withConfig = (patch: Record<string, unknown>, render: () => string): string => {
    const member = fixture.state.config;
    fixture.state.config = { ...member, ...patch };
    try {
      return render();
    } finally {
      fixture.state.config = member;
    }
  };
  const own = { personalWorkspace: true, features: { browser: true, computers: true, sharedComputers: false }, browserEngine: { kind: "engine" } };
  const panel = (target: unknown = bot) => renderToStaticMarkup(createElement(ComputerPanel, { bot: target as never }));

  it("offers where a bot works: its cloud computer, the browser or off, and nothing about desks", () => {
    const html = withConfig(own, () => panel());
    expect(html).toContain('data-testid="workspace-computer"');
    for (const label of ["Works on", "Auto", "Cloud computer", "Browser", "Off"]) expect(html).toContain(label);
    expect(html).not.toContain('data-testid="member-computer"');
    expect(html).not.toMatch(DESK_SETUP);
    expect(html).not.toMatch(/OpenMaus|Claude|Anthropic|Hermes|Venice|Grok|This computer|Local desktop/i);
  });

  it("offers only what the workspace's config turns on", () => {
    const cloudOnly = withConfig({ ...own, browserEngine: { kind: "unavailable" } }, () => panel());
    expect(cloudOnly).toContain("Cloud computer");
    expect(cloudOnly).not.toContain(">Browser<");
    const browserOnly = withConfig({ ...own, features: { browser: true, computers: false } }, () => panel());
    expect(browserOnly).not.toContain("Cloud computer");
    expect(browserOnly).toContain(">Browser<");
    const neither = withConfig({ ...own, features: { browser: false, computers: false } }, () => panel());
    expect(neither).toContain('data-testid="member-computer"');
    expect(neither).not.toContain("Works on");
  });

  it("never offers them to a member of a shared desk, whatever the flags say", () => {
    const html = withConfig({ ...own, personalWorkspace: false }, () => panel());
    expect(html).toContain('data-testid="member-computer"');
    expect(html).not.toContain("Works on");
  });

  it("shows the bot's own cloud computer, or its browser without the owner's profiles", () => {
    const cloud = withConfig(own, () => panel({ ...(bot as object), computer: "cloud" }));
    expect(cloud).toContain('data-testid="workspace-cloud-computer"');
    expect(cloud).toContain("Scout has a cloud computer of its own in your workspace");
    expect(cloud).not.toMatch(DESK_SETUP);
    const browsing = withConfig(own, () => panel({ ...(bot as object), computer: "browser" }));
    expect(browsing).toContain('data-testid="workspace-browser"');
    expect(browsing).toContain("public websites");
    expect(browsing).not.toContain("Browser profiles");
  });
});
