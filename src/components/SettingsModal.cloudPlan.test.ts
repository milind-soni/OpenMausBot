import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({ section: "cloudAccount" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined, advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config, instances: [], bots: [], appSettingsCloudLink: 0 }, dispatch: vi.fn() }),
}));
vi.mock("./CloudAccountSettings", () => ({
  CloudAccountSettings: ({ cloudHome, onAddCloud }: { cloudHome?: boolean; onAddCloud?: () => void }) => `CLOUD_PLAN_MARKER${cloudHome ? " home" : ""}${onAddCloud ? " offer" : ""}`,
}));

const plan = { state: vi.fn(), manage: vi.fn() };
beforeEach(() => {
  fixture.section = "cloudAccount"; fixture.config = undefined;
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.unstubAllGlobals(); });
const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe.each(["Simple", "Advanced"] as const)("%s Settings → Plan & billing on a server open in the app's window", (mode) => {
  beforeEach(() => { fixture.advanced = mode === "Advanced"; });
  const reachable = 'data-settings-page="plan"';
  it("is not offered on a server that is not an OMB Cloud home", () => {
    vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
    const html = render();
    expect(html).not.toContain("CLOUD_PLAN_MARKER"); expect(html).not.toContain(reachable);
  });
  it("shows the plan, read only, on the person's own Cloud", () => {
    vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
    fixture.config = { cloudHome: true };
    const html = render();
    expect(html).toContain("CLOUD_PLAN_MARKER home"); expect(html).toContain(reachable);
    expect(html).toContain('data-settings-page-open="plan"');
  });
  it("is the full plan page in the app on this computer, with the offer in both modes", () => {
    vi.stubGlobal("window", { ogb: { cloudAccount: {}, cloudPlan: plan } });
    const html = render();
    expect(html).toContain("CLOUD_PLAN_MARKER offer");
    expect(html).not.toContain("CLOUD_PLAN_MARKER home");
    expect(html).toContain(reachable);
  });
});
