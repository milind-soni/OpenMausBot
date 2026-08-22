import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  desktopCapabilities,
  linuxSession,
  localComputerReady,
  nativeDesktopActions,
} = require("./capabilities.cjs");

describe("desktop capabilities", () => {
  it("keeps Apple permissions, Settings, and speech actions unreachable on Linux", () => {
    expect(nativeDesktopActions("linux")).toEqual({
      appleMediaPermissions: false,
      applePrivacySettings: false,
      appleSpeech: false,
    });
    expect(nativeDesktopActions("win32")).toEqual(nativeDesktopActions("linux"));
    expect(nativeDesktopActions("darwin")).toEqual({
      appleMediaPermissions: true,
      applePrivacySettings: true,
      appleSpeech: true,
    });
  });

  it("keeps macOS native features behind a ready CUA connection", () => {
    const capabilities = desktopCapabilities({
      platform: "darwin",
      packaged: true,
      localConnection: { mode: "embedded" },
    });

    expect(capabilities).toMatchObject({
      host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
      windowChrome: "mac-inset",
      screenPreview: { available: true, interaction: "direct" },
      dictation: { available: true, engine: "apple-speech", onDevice: true },
      localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
    });
  });

  it.each(["win32", "freebsd"])("fails closed on %s", (platform) => {
    const capabilities = desktopCapabilities({
      platform,
      env: { DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.windowChrome).toBe("native");
    expect(capabilities.screenPreview.available).toBe(false);
    expect(capabilities.dictation.available).toBe(false);
    expect(capabilities.localComputer).toMatchObject({
      available: false,
      support: "unsupported",
      reasonCode: "unsupported-platform",
    });
  });

  it("offers direct Xorg preview without enabling local control", () => {
    const capabilities = desktopCapabilities({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.screenPreview).toEqual({ available: true, interaction: "direct" });
    expect(capabilities.localComputer.available).toBe(false);
  });

  it("offers portal-mediated Wayland preview and fails closed when headless", () => {
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      }).screenPreview,
    ).toEqual({ available: true, interaction: "portal-picker" });
    expect(desktopCapabilities({ platform: "linux", env: {} }).screenPreview).toEqual({
      available: false,
      interaction: "none",
      reasonCode: "headless-session",
    });
  });

  it("detects Wayland before XWayland and distinguishes X11 and headless Linux", () => {
    expect(linuxSession("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland");
    expect(
      linuxSession("linux", {
        XDG_SESSION_TYPE: "x11",
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      }),
    ).toBe("wayland");
    expect(linuxSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe("x11");
    expect(linuxSession("linux", {})).toBe("headless");
  });

  it("never treats an embedded-looking Linux connection as local control", () => {
    expect(localComputerReady("linux", { mode: "embedded" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "unavailable" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "standalone" })).toBe(true);
  });

  it("enables limited Linux control only for the complete supervised X11 contract", () => {
    const connection = {
      schemaVersion: 1,
      mode: "linux-x11-supervised",
      platform: "linux",
      session: "x11",
      enabled: true,
      status: "ready",
      driver: {
        path: "/home/test/.local/bin/cua-driver",
        version: "0.19.3",
        source: "user-local",
      },
    };
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
        localConnection: connection,
      }).localComputer,
    ).toMatchObject({
      available: true,
      support: "limited",
      enabled: true,
      status: "ready",
      driverVersion: "0.19.3",
      driverSource: "user-local",
    });
    expect(localComputerReady("linux", { ...connection, session: "wayland" })).toBe(false);
    expect(localComputerReady("linux", { ...connection, status: "starting" })).toBe(false);
    expect(localComputerReady("linux", { ...connection, schemaVersion: 2 })).toBe(false);
  });

  it("enables GNOME Wayland control only for the exact supervised contract", () => {
    const connection = {
      schemaVersion: 1,
      mode: "linux-wayland-gnome-supervised",
      platform: "linux",
      session: "wayland",
      compositor: "gnome-mutter",
      enabled: true,
      status: "ready",
    };
    expect(localComputerReady("linux", connection)).toBe(true);
    expect(localComputerReady("linux", { ...connection, compositor: undefined })).toBe(false);
    expect(localComputerReady("linux", { ...connection, session: "x11" })).toBe(false);
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
        localConnection: connection,
      }).localComputer,
    ).toMatchObject({
      available: true,
      support: "limited",
      session: "wayland",
      compositor: "gnome-mutter",
    });
  });
});
