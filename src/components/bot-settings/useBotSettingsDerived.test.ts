import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { HighLevelStatus } from "@/lib/highlevel-sign-in";

const fixture = vi.hoisted(() => ({
  instances: [] as unknown[],
  config: null as unknown,
  highlevel: null as HighLevelStatus | null,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: fixture.instances, config: fixture.config }, dispatch: vi.fn() }),
  };
});
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { packaged: false } } }) }));
vi.mock("@/lib/highlevel-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/highlevel-status")>(),
  useHighLevelStatus: () => fixture.highlevel,
}));

const { useBotSettingsDerived } = await import("./useBotSettingsDerived");

const bot = { id: "bot-1", threadId: "t", name: "Scout", title: "Scout", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "engine", model: "m" }, messages: [] } as unknown as Bot;
const engine = (capabilities: Record<string, boolean>) => [{ instanceId: "engine", capabilities } as unknown as InstanceInfo];

function derive() {
  let derived!: ReturnType<typeof useBotSettingsDerived>;
  function Capture() { derived = useBotSettingsDerived(bot); return null; }
  renderToStaticMarkup(createElement(Capture));
  return derived;
}

beforeEach(() => { vi.stubGlobal("window", {}); fixture.instances = []; fixture.config = null; fixture.highlevel = null; });
afterEach(() => vi.unstubAllGlobals());

describe("connected apps in bot settings", () => {
  it("lets the engine use connected apps through either Composio's MCP or the native HighLevel one", () => {
    fixture.instances = engine({ composioMcp: true });
    expect(derive().canUseConnectedApps).toBe(true);
    fixture.instances = engine({ highlevelMcp: true });
    expect(derive().canUseConnectedApps).toBe(true);
    fixture.instances = engine({ dataMcp: true });
    expect(derive().canUseConnectedApps).toBe(false);
    fixture.instances = [];
    expect(derive().canUseConnectedApps).toBe(false);
  });

  it("counts a connected HighLevel as configured connected apps even without the Composio service", () => {
    expect(derive().connectedAppsConfigured).toBe(false);
    fixture.highlevel = { state: "connected", location: { id: "loc_1", name: "Example Profiles" } };
    expect(derive().connectedAppsConfigured).toBe(true);
    fixture.highlevel = { state: "needs-sign-in" };
    expect(derive().connectedAppsConfigured).toBe(false);
    fixture.config = { composio: { configured: true } };
    expect(derive().connectedAppsConfigured).toBe(true);
  });
});
