import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  localComputer: { available: false, message: "Accessibility required; grant access in System Settings" } as DesktopCapabilities["localComputer"],
}));
vi.stubGlobal("window", {
  ogb: { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() },
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, localComputer: fixture.localComputer }, ready: true }),
}));

const { MacLocalControl, hideMacLocalControlUntilRelaunch } = await import("./MacLocalControl");
afterAll(() => vi.unstubAllGlobals());

describe("Mac local computer status", () => {
  it("shows the recorded Accessibility failure and its matching recovery actions", () => {
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("Accessibility is required for MausBot");
    expect(markup).toContain("Open Accessibility Settings");
    expect(markup).toContain("Relaunch MausBot");
    expect(markup).not.toContain("Open Screen Recording Settings");
    expect(markup).toContain("Driver detail");
    expect(markup).toContain(">Not now</button>");
  });

  it("does not turn a missing reason into a claimed permission diagnosis", () => {
    fixture.localComputer = { available: false, status: "unavailable" } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("Local computer control is not ready");
    expect(markup).not.toContain("Accessibility is required");
    expect(markup).not.toContain("Relaunch MausBot</button>");
  });

  it("does not offer host repair actions to a remote renderer", () => {
    fixture.localComputer = { available: false, status: "unavailable", reasonCode: "remote-server" } as DesktopCapabilities["localComputer"];
    expect(renderToStaticMarkup(createElement(MacLocalControl))).toBe("");
  });

  it("hides the card after Not now until the app starts again", () => {
    fixture.localComputer = { available: false, message: "Accessibility required; grant access in System Settings" } as DesktopCapabilities["localComputer"];
    expect(renderToStaticMarkup(createElement(MacLocalControl))).toContain("Allow control of this computer");
    hideMacLocalControlUntilRelaunch();
    expect(renderToStaticMarkup(createElement(MacLocalControl))).toBe("");
  });
});
