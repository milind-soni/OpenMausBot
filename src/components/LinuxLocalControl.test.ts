import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  localComputer: { available: false } as DesktopCapabilities["localComputer"],
  session: "wayland" as DesktopCapabilities["host"]["session"],
}));
vi.stubGlobal("window", { ogb: { platform: "linux", localControl: { enable: vi.fn(), disable: vi.fn(), retry: vi.fn() } } });
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: { host: { platform: "linux", session: fixture.session, packaged: true }, localComputer: fixture.localComputer },
    ready: true,
  }),
}));

const { LinuxLocalControl } = await import("./LinuxLocalControl");
afterAll(() => vi.unstubAllGlobals());

describe("Linux local control on Omarchy", () => {
  it("says in one sentence how to turn Cua's Hyprland plugin on, links Cua's guide, and offers Try again", () => {
    fixture.localComputer = {
      available: false,
      support: "unsupported",
      enabled: false,
      status: "unavailable",
      reasonCode: "linux-hyprland-plugin-required",
      compositor: "hyprland",
    } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(LinuxLocalControl));
    expect(markup).toContain("data-linux-hyprland-plugin-required");
    expect(markup).toContain("install and turn on Cua&#x27;s Hyprland plugin (cua-hyprland-plugin), reload Hyprland, then try again.");
    expect(markup).toContain("Cua&#x27;s Omarchy guide");
    expect(markup).toContain("Plugin needed");
    expect(markup).toContain("Try again");
    expect(markup).toContain("Experimental · Omarchy (Hyprland)");
    expect(markup).not.toContain("Enable local control (Beta)");
    expect(markup).not.toContain("Unavailable on Wayland");
  });

  it("describes Omarchy's own seat once ready, without the GNOME foreground prompt", () => {
    fixture.localComputer = {
      available: true,
      support: "limited",
      enabled: true,
      status: "ready",
      compositor: "hyprland",
      driverPath: "/usr/bin/cua-driver",
      driverSource: "system-package",
      driverVersion: "0.41.3",
    } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(LinuxLocalControl));
    expect(markup).toContain("own seat inside Hyprland");
    expect(markup).toContain("/usr/bin/cua-driver · 0.41.3");
    expect(markup).not.toContain("GNOME may also ask");
  });

  it("keeps the Wayland safety block on other desktops", () => {
    fixture.localComputer = {
      available: false,
      support: "unsupported",
      enabled: false,
      status: "unavailable",
      reasonCode: "linux-wayland-seat-safety-blocked",
    } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(LinuxLocalControl));
    expect(markup).toContain("Unavailable on Wayland");
    expect(markup).not.toContain("cua-hyprland-plugin");
    expect(markup).not.toContain("Try again");
  });
});
