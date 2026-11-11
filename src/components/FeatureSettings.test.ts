// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { featureControlDestination, FeaturesSettings, SkillsSettings } from "./FeatureSettings";

const fixture = vi.hoisted(() => ({
  config: { features: { skillsLibrary: false, skillAuthoring: true, autoRecall: true } } as { features: Record<string, boolean> },
  api: vi.fn(), dispatch: vi.fn(), owner: true, libraryMounts: 0,
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({
  state: { config: fixture.config, bots: [], instances: [] }, dispatch: fixture.dispatch,
}) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("./SkillsSection", () => ({ SkillsSection: () => {
  fixture.libraryMounts += 1;
  return createElement("div", { "data-library": true }, "Library");
} }));

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(SkillsSettings)));
const librarySwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Skills library"]')!;
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  fixture.config = { features: { skillsLibrary: false, skillAuthoring: true, autoRecall: true } };
  fixture.api.mockReset(); fixture.dispatch.mockReset(); fixture.owner = true; fixture.libraryMounts = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("feature settings", () => {
  it("waits for the confirmed save before mounting the library, then unmounts on disable", async () => {
    let confirm!: (config: typeof fixture.config) => void;
    fixture.api.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    render();
    expect(fixture.libraryMounts).toBe(0);
    expect(host.textContent).toContain("Enable the skills library");
    flushSync(() => librarySwitch().click());
    expect(librarySwitch().disabled).toBe(true);
    expect(fixture.libraryMounts).toBe(0);
    const enabled = { features: { ...fixture.config.features, skillsLibrary: true } };
    confirm(enabled); await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { skillsLibrary: true } }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: enabled });
    fixture.config = enabled; render();
    expect(host.querySelector("[data-library]")).not.toBeNull();
    fixture.api.mockResolvedValueOnce({ features: { ...enabled.features, skillsLibrary: false } });
    flushSync(() => librarySwitch().click()); await settle();
    fixture.config = { features: { ...enabled.features, skillsLibrary: false } }; render();
    expect(host.querySelector("[data-library]")).toBeNull();
    expect(fixture.api.mock.calls.every(([path]) => path === "/api/config")).toBe(true);
  });

  it("shows failed saves inline and keeps the disabled library unmounted", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Save failed")); render();
    flushSync(() => librarySwitch().click()); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
    expect(librarySwitch().getAttribute("aria-checked")).toBe("false");
    expect(fixture.libraryMounts).toBe(0);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps skill review reachable without the library and shows sharing requirements", () => {
    render();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-review-settings"] [role="switch"]')?.disabled).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="share-learned-skills-settings"] [role="radio"]')].every((button) => button.disabled)).toBe(true);
    fixture.config.features.skillAuthoring = false; render();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-review-settings"] [role="switch"]')?.disabled).toBe(true);
  });

  it("protects feature and library controls from members", () => {
    fixture.owner = false; render();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    flushSync(() => root.render(createElement(FeaturesSettings, { onOpen: vi.fn() })));
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  it("renders defaults and links existing controls to their destinations", () => {
    fixture.config = { features: { skillsLibrary: false, skillAuthoring: true } };
    const onOpen = vi.fn();
    flushSync(() => root.render(createElement(FeaturesSettings, { onOpen })));
    expect(host.querySelector('[aria-label="Automatic memory recall"]')?.getAttribute("aria-checked")).toBe("true");
    const row = host.querySelector('[data-settings-block="feature-showToolCalls"]')!;
    flushSync(() => row.querySelector<HTMLButtonElement>("button")!.click());
    expect(onOpen).toHaveBeenCalledWith("appearance", "control-showToolCalls");
    expect(host.textContent).toContain("loopGuard");
    const lending = host.querySelector('[data-settings-block="feature-sharedComputers"]')!;
    expect(lending.querySelector('[role="switch"], button')).toBeNull();
    expect(host.querySelector('[data-settings-block="feature-agentsToolBridge"]')!.textContent).toContain("OMB_AGENTS_TOOL_BRIDGE");
    expect(host.querySelector('[data-settings-block="feature-chiefEscalations"]')).toBeNull();
  });

  it("keeps saved-steps discovery explanatory when this host lacks the capability", () => {
    const onOpen = vi.fn();
    flushSync(() => root.render(createElement(FeaturesSettings, { onOpen })));
    const row = host.querySelector('[data-settings-block="feature-savedSteps"]')!;
    expect(row.textContent).toContain("Requires a supported Mac");
    expect(row.querySelector("button")).toBeNull();
    expect(featureControlDestination("savedSteps", fixture.config)).toEqual({ section: "features", anchor: "feature-savedSteps" });
    expect(featureControlDestination("savedSteps", { features: { savedStepsHere: true } })).toEqual({ section: "general", anchor: "control-savedSteps" });
  });
});
